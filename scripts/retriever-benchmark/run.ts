/**
 * Run the D-L4-3 retriever benchmark against TEI containers, and summarise.
 *
 *   npx tsx scripts/retriever-benchmark/run.ts bench --embed <candidate-id> --out <dir> --failures <dir>
 *   npx tsx scripts/retriever-benchmark/run.ts summarize --records <dir> --out <file>
 *
 * Meant for `.github/workflows/retriever-benchmark.yml` on a GitHub-hosted
 * runner, never on the production VM (capacity rule: no new container there
 * before C1). It needs Docker; it starts one TEI container at a time on
 * 127.0.0.1, by digest, and removes it when the stage ends.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT LEAVES THE RUNNER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The only outbound traffic is TEI downloading model weights from Hugging
 * Face. Every text this script sends goes to the container on loopback —
 * `teiUrl` refuses any other host — and the texts are the seed set's
 * synthetic questions and seed policy chunks. A record is written to a
 * directory the workflow uploads as an artifact; nothing here commits.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A STAGE THAT CANNOT RUN IS A FAILURE FILE, NEVER A RECORD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Whether TEI can serve a candidate on CPU at all is one of the things Phase 0
 * asks (0.2). A candidate that does not load writes a failure file naming the
 * stage and the engine's last log lines, the other stages carry on, and the
 * process exits non-zero at the end. Nothing partial is written as a record:
 * `scoreRecord` would refuse it anyway, and a refused record in the records
 * artifact reads like a result.
 *
 * Plain `fetch` rather than `safeFetch`: this is a CI script talking to a
 * container on loopback, which `safeFetch` exists to refuse. The SSRF egress
 * population is `src/`, where tenant-influenced URLs live; nothing here takes
 * a URL from anyone.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { readSeedSet } from './build-seed-set';
import {
    D_L4_3_RECALL_MARGIN,
    EMBED_CANDIDATES,
    PROBE_BATCH,
    PROBE_SAMPLES,
    PROBE_WARMUP,
    RERANK_CANDIDATES,
    RERANK_DEPTH,
    TEI_CPU_IMAGE,
    embedCandidate,
    type EmbedCandidate,
    type RerankCandidate,
} from './candidates';
import type { CorpusChunk } from './corpus';
import {
    RECALL_K,
    RECORD_SCHEMA,
    computeAggregates,
    decideD_L4_3,
    scoreRecord,
    type BenchmarkRecord,
    type LatencyProbe,
    type RecordedAnswer,
    type RetrieverSeedSet,
    type ScoredPipeline,
} from './scoring';

const HOST_PORT = 18080;
const CONTAINER = 'retriever-benchmark-tei';
const READY_TIMEOUT_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const CORPUS_BATCH = 32;

/** Only the loopback container. A different host is a bug, and a send of seed text elsewhere. */
export function teiUrl(base: string, route: string): string {
    const url = new URL(route, base);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') {
        throw new Error(`refusing to send benchmark text to ${url.origin}: only the loopback TEI container is allowed`);
    }
    return url.toString();
}

/** Top `n` corpus indices by dot product (vectors are unit length, so cosine). */
export function topByCosine(query: readonly number[], passages: readonly (readonly number[])[], n: number): number[] {
    const scored = passages.map((p, i) => {
        let dot = 0;
        for (let d = 0; d < query.length; d++) dot += query[d] * p[d];
        return { i, dot };
    });
    // Ties broken by corpus order so a rerun ranks identically.
    scored.sort((a, b) => b.dot - a.dot || a.i - b.i);
    return scored.slice(0, n).map((s) => s.i);
}

interface TeiInfo {
    readonly model_id?: string;
    readonly model_sha?: string | null;
    readonly max_input_length?: number;
}

class Tei {
    constructor(private readonly base = `http://127.0.0.1:${HOST_PORT}/`) {}

    private async post<T>(route: string, body: unknown): Promise<T> {
        const res = await fetch(teiUrl(this.base, route), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`TEI ${route} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return (await res.json()) as T;
    }

    async info(): Promise<TeiInfo> {
        const res = await fetch(teiUrl(this.base, 'info'), { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`TEI /info answered ${res.status}`);
        return (await res.json()) as TeiInfo;
    }

    async ready(): Promise<boolean> {
        try {
            const res = await fetch(teiUrl(this.base, 'health'), { signal: AbortSignal.timeout(5_000) });
            return res.ok;
        } catch {
            return false;
        }
    }

    embed(inputs: readonly string[]): Promise<number[][]> {
        return this.post<number[][]>('embed', { inputs, normalize: true, truncate: true });
    }

    rerank(query: string, texts: readonly string[]): Promise<Array<{ index: number; score: number }>> {
        return this.post('rerank', { query, texts, truncate: true, raw_scores: false });
    }

    async tokens(text: string): Promise<number | null> {
        try {
            const out = await this.post<unknown[][]>('tokenize', { inputs: [text], add_special_tokens: true });
            return Array.isArray(out?.[0]) ? out[0].length : null;
        } catch {
            return null;
        }
    }
}

function docker(args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function stopContainer(): void {
    try {
        docker(['rm', '-f', CONTAINER]);
    } catch {
        // Already gone.
    }
}

function logTail(): string {
    try {
        return execFileSync('docker', ['logs', '--tail', '40', CONTAINER], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return `docker logs failed: ${(e as Error).message}`;
    }
}

async function startTei(model: string, revision: string | null, cacheDir: string): Promise<{ tei: Tei; info: TeiInfo }> {
    stopContainer();
    const args = [
        'run', '-d', '--name', CONTAINER,
        '-p', `127.0.0.1:${HOST_PORT}:80`,
        '-v', `${cacheDir}:/data`,
    ];
    // Passed by NAME: docker reads the value from this process's environment,
    // so a token never appears in an argument list or a log.
    if (process.env.HF_TOKEN) args.push('-e', 'HF_TOKEN');
    args.push(TEI_CPU_IMAGE, '--model-id', model, '--auto-truncate', '--max-client-batch-size', '64');
    if (revision) args.push('--revision', revision);
    docker(args);

    const tei = new Tei();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await tei.ready()) return { tei, info: await tei.info() };
        const state = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]).trim();
        if (state !== 'true') throw new Error(`TEI exited while loading ${model}`);
        await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(`TEI did not become ready for ${model} within ${READY_TIMEOUT_MS / 60000} minutes`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const t0 = performance.now();
    const value = await fn();
    return { value, ms: Math.round((performance.now() - t0) * 1000) / 1000 };
}

async function probe(name: string, batch: number, tokensPerInput: number | null, fn: () => Promise<unknown>): Promise<LatencyProbe> {
    for (let i = 0; i < PROBE_WARMUP; i++) await fn();
    const samplesMs: number[] = [];
    for (let i = 0; i < PROBE_SAMPLES; i++) samplesMs.push((await timed(fn)).ms);
    return { name, batch, tokensPerInput, samplesMs };
}

/** Batch-of-32 inputs near the token lengths Phase 0.3 names, built from the set itself. */
async function probeInputs(tei: Tei, set: RetrieverSeedSet): Promise<{ queries: string[]; passages: string[]; qTok: number | null; pTok: number | null }> {
    const queries = set.cases.slice(0, PROBE_BATCH).map((c) => c.question);
    const passages: string[] = [];
    let cursor = 0;
    for (let i = 0; i < PROBE_BATCH; i++) {
        const words: string[] = [];
        // About 512 tokens of English policy text; the engine's own count is recorded.
        while (words.length < 400) {
            words.push(...set.corpus[cursor % set.corpus.length].text.split(/\s+/));
            cursor++;
        }
        passages.push(words.slice(0, 400).join(' '));
    }
    const mean = async (texts: string[]) => {
        const counts = await Promise.all(texts.map((t) => tei.tokens(t)));
        if (counts.some((c) => c === null)) return null;
        return (counts as number[]).reduce((a, b) => a + b, 0) / counts.length;
    };
    return { queries, passages, qTok: await mean(queries), pTok: await mean(passages) };
}

function environment(): BenchmarkRecord['environment'] {
    return {
        runner: process.env.GITHUB_ACTIONS === 'true' ? `github-hosted ${process.env.RUNNER_OS ?? ''}`.trim() : 'local',
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpus: os.cpus().length,
        memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    };
}

function revisionOf(info: TeiInfo, model: string): string {
    // An absent sha is written as-is; scoring refuses it as REVISION_NOT_A_COMMIT.
    if (info.model_id && info.model_id !== model) throw new Error(`TEI loaded ${info.model_id}, not ${model}`);
    return info.model_sha ?? 'unknown';
}

function writeJson(dir: string, name: string, value: unknown): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
}

function finalise(set: RetrieverSeedSet, record: Omit<BenchmarkRecord, 'aggregates'>): BenchmarkRecord {
    const scored = scoreRecord(set, record);
    if (!scored.ok) {
        throw new Error(`record would be refused: ${scored.problems.map((p) => `${p.code} ${p.detail}`).slice(0, 5).join('; ')}`);
    }
    return { ...record, aggregates: computeAggregates(set, record) };
}

async function bench(embedId: string, outDir: string, failDir: string, cacheDir: string): Promise<number> {
    const root = path.resolve(__dirname, '../..');
    const set = readSeedSet(root);
    const cand: EmbedCandidate = embedCandidate(embedId);
    fs.mkdirSync(cacheDir, { recursive: true });
    let failures = 0;
    const fail = (stage: string, model: string, err: unknown) => {
        failures++;
        const name = stage === 'embed' ? embedId : `${embedId}+${stage}`;
        writeJson(failDir, name, { stage, model, reason: (err as Error).message, engineLog: logTail(), at: new Date().toISOString() });
        process.stderr.write(`FAILED ${name}: ${(err as Error).message}\n`);
    };

    // ── Stage 1: embed the corpus and every question ────────────────────
    const depth = Math.max(RECALL_K, RERANK_DEPTH);
    let embedRanked: Array<{ caseId: string; indices: number[]; embedMs: number }>;
    let embedRecordBase: Omit<BenchmarkRecord, 'aggregates' | 'pipeline' | 'answers' | 'probes'>;
    let embedRef: BenchmarkRecord['pipeline']['embed'];
    try {
        const { tei, info } = await startTei(cand.model, cand.revision, cacheDir);
        embedRef = {
            model: cand.model,
            revision: revisionOf(info, cand.model),
            parametersM: cand.parametersM,
            queryPrefix: cand.queryPrefix,
            passagePrefix: cand.passagePrefix,
        };
        const vectors: number[][] = [];
        for (let i = 0; i < set.corpus.length; i += CORPUS_BATCH) {
            const batch = set.corpus.slice(i, i + CORPUS_BATCH).map((c: CorpusChunk) => cand.passagePrefix + c.text);
            vectors.push(...(await tei.embed(batch)));
        }
        if (vectors.length !== set.corpus.length) throw new Error(`embedded ${vectors.length} of ${set.corpus.length} chunks`);
        embedRanked = [];
        for (const c of set.cases) {
            // One query per request, timed: the latency a user's search pays.
            const { value, ms } = await timed(() => tei.embed([cand.queryPrefix + c.question]));
            embedRanked.push({ caseId: c.id, indices: topByCosine(value[0], vectors, depth), embedMs: ms });
        }
        const inputs = await probeInputs(tei, set);
        const probes = [
            await probe('query-20', PROBE_BATCH, inputs.qTok, () => tei.embed(inputs.queries.map((q) => cand.queryPrefix + q))),
            await probe('passage-512', PROBE_BATCH, inputs.pTok, () => tei.embed(inputs.passages.map((p) => cand.passagePrefix + p))),
        ];
        embedRecordBase = {
            schema: RECORD_SCHEMA,
            set: { id: set.id, version: set.version, contentHash: set.contentHash },
            engine: { image: TEI_CPU_IMAGE },
            environment: environment(),
            ranAt: new Date().toISOString(),
        };
        const record = finalise(set, {
            ...embedRecordBase,
            pipeline: { embed: embedRef, rerank: null, rerankDepth: null },
            answers: embedRanked.map((r) => ({
                caseId: r.caseId,
                ranked: r.indices.map((i) => set.corpus[i].id),
                stageMs: { embed: r.embedMs },
            })),
            probes,
        });
        process.stdout.write(`wrote ${writeJson(outDir, embedId, record)} recall@10=${record.aggregates?.recallAt10}\n`);
    } catch (err) {
        fail('embed', cand.model, err);
        stopContainer();
        return failures;
    }
    stopContainer();

    // ── Stage 2: each reranker over this embedder's top RERANK_DEPTH ─────
    for (const rr of RERANK_CANDIDATES as readonly RerankCandidate[]) {
        try {
            const { tei, info } = await startTei(rr.model, rr.revision, cacheDir);
            const rerankRef = { model: rr.model, revision: revisionOf(info, rr.model), parametersM: rr.parametersM };
            const answers: RecordedAnswer[] = [];
            for (const r of embedRanked) {
                const c = set.cases.find((x) => x.id === r.caseId)!;
                const pool = r.indices.slice(0, RERANK_DEPTH);
                const { value, ms } = await timed(() => tei.rerank(c.question, pool.map((i) => set.corpus[i].text)));
                if (value.length !== pool.length) throw new Error(`reranker returned ${value.length} of ${pool.length} for ${c.id}`);
                const order = [...value].sort((a, b) => b.score - a.score || a.index - b.index);
                answers.push({
                    caseId: r.caseId,
                    ranked: order.map((o) => set.corpus[pool[o.index]].id),
                    stageMs: { embed: r.embedMs, rerank: ms },
                });
            }
            const probeQuery = set.cases[0].question;
            const probeTexts = set.corpus.slice(0, PROBE_BATCH).map((x) => x.text);
            const probes = [await probe('rerank-32', PROBE_BATCH, null, () => tei.rerank(probeQuery, probeTexts))];
            const record = finalise(set, {
                ...embedRecordBase,
                ranAt: new Date().toISOString(),
                pipeline: { embed: embedRef, rerank: rerankRef, rerankDepth: RERANK_DEPTH },
                answers,
                probes,
            });
            process.stdout.write(`wrote ${writeJson(outDir, `${embedId}+${rr.id}`, record)} recall@10=${record.aggregates?.recallAt10}\n`);
        } catch (err) {
            fail(rr.id, rr.model, err);
        }
        stopContainer();
    }
    return failures;
}

export interface Summary {
    readonly set: { readonly id: string; readonly contentHash: string };
    readonly records: ReadonlyArray<{
        readonly file: string;
        readonly ok: boolean;
        readonly problems: readonly string[];
        readonly pipeline: string;
        readonly recallAt10: number | null;
        readonly mrrAt10: number | null;
        readonly embedP50: number | null;
        readonly embedP95: number | null;
        readonly rerankP50: number | null;
        readonly rerankP95: number | null;
    }>;
    readonly decisions: ReturnType<typeof decideD_L4_3>;
}

export function summarise(set: RetrieverSeedSet, files: ReadonlyArray<{ file: string; record: BenchmarkRecord }>): Summary {
    const pipelines: ScoredPipeline[] = [];
    const records = files.map(({ file, record }) => {
        const scored = scoreRecord(set, record);
        const name = `${record.pipeline.embed.model}${record.pipeline.rerank ? ` + ${record.pipeline.rerank.model}` : ''}`;
        const a = scored.aggregates;
        if (scored.ok && a) {
            pipelines.push({
                embedModel: record.pipeline.embed.model,
                rerankModel: record.pipeline.rerank?.model ?? null,
                parametersM: record.pipeline.embed.parametersM + (record.pipeline.rerank?.parametersM ?? 0),
                recallAt10: a.recallAt10,
            });
        }
        return {
            file,
            ok: scored.ok,
            problems: scored.problems.map((p) => `${p.code}: ${p.detail}`),
            pipeline: name,
            recallAt10: a?.recallAt10 ?? null,
            mrrAt10: a?.mrrAt10 ?? null,
            embedP50: a?.embedMs.p50 ?? null,
            embedP95: a?.embedMs.p95 ?? null,
            rerankP50: a?.rerankMs?.p50 ?? null,
            rerankP95: a?.rerankMs?.p95 ?? null,
        };
    });
    const decisions = decideD_L4_3(
        pipelines,
        EMBED_CANDIDATES.map((c) => c.model),
        [null, ...RERANK_CANDIDATES.map((r) => r.model)],
        D_L4_3_RECALL_MARGIN,
    );
    return { set: { id: set.id, contentHash: set.contentHash }, records, decisions };
}

export function summaryMarkdown(s: Summary): string {
    const f = (n: number | null, d = 3) => (n === null ? '—' : n.toFixed(d));
    const lines = [
        `## Retriever benchmark (D-L4-3)`,
        ``,
        `Set \`${s.set.id}\` \`${s.set.contentHash}\`. Figures recomputed from each record's raw answers.`,
        ``,
        `| pipeline | ok | recall@10 | MRR@10 | embed p50 ms | embed p95 ms | rerank p50 ms | rerank p95 ms |`,
        `| --- | --- | --- | --- | --- | --- | --- | --- |`,
        ...s.records.map((r) =>
            `| ${r.pipeline} | ${r.ok ? 'yes' : `no: ${r.problems[0] ?? ''}`} | ${f(r.recallAt10)} | ${f(r.mrrAt10)} | ${f(r.embedP50, 1)} | ${f(r.embedP95, 1)} | ${f(r.rerankP50, 1)} | ${f(r.rerankP95, 1)} |`,
        ),
        ``,
        `### Decision rule: the smallest pipeline within ${s.decisions[0]?.margin ?? D_L4_3_RECALL_MARGIN} recall@10 of the best`,
        ``,
        ...s.decisions.map((d) =>
            `- reranker ${d.rerankModel ?? 'none'}: **${d.status}**` +
            (d.chosen ? ` — choose ${d.chosen.embedModel} (${f(d.chosen.recallAt10)}); best ${d.best?.embedModel} (${f(d.best?.recallAt10 ?? null)})` : '') +
            (d.missing.length ? `; no scored record for ${d.missing.join(', ')}` : ''),
        ),
        ``,
        `A proposal for the owner, not a decision: D-L4-3 is initialled by a person.`,
    ];
    return `${lines.join('\n')}\n`;
}

function arg(name: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    if (!v) throw new Error(`--${name} is required`);
    return v;
}

async function main(): Promise<void> {
    const cmd = process.argv[2];
    if (cmd === 'bench') {
        const failures = await bench(arg('embed'), arg('out'), arg('failures'), path.resolve('.retriever-cache'));
        process.exit(failures > 0 ? 1 : 0);
    }
    if (cmd === 'summarize') {
        const root = path.resolve(__dirname, '../..');
        const set = readSeedSet(root);
        const dir = arg('records');
        const files = fs.existsSync(dir)
            ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort()
            : [];
        const summary = summarise(
            set,
            files.map((file) => ({ file, record: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as BenchmarkRecord })),
        );
        fs.writeFileSync(arg('out'), `${JSON.stringify(summary, null, 2)}\n`);
        process.stdout.write(summaryMarkdown(summary));
        return;
    }
    throw new Error('usage: run.ts bench --embed <id> --out <dir> --failures <dir> | summarize --records <dir> --out <file>');
}

if (require.main === module) {
    main().catch((e: unknown) => {
        process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
        process.exit(1);
    });
}
