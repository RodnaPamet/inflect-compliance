/**
 * Scoring for the retriever benchmark (D-L4-3): what a record must hold, and
 * every figure recomputed from it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A RECORD IS RAW ANSWERS; A FIGURE IS ALWAYS RECOMPUTED (G11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A record holds the ranked chunk ids each case got back and the measured
 * stage times — never a recall or a percentile it asks to be believed. A
 * record MAY carry an `aggregates` block for a human reading the JSON, and
 * `scoreRecord` recomputes it and reports `AGGREGATE_DISAGREES` when the two
 * differ, so a hand-edited figure is caught rather than quoted.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO IS NEVER COMPLETE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A record with no answers, or one that answers a subset of the set, is
 * refused rather than scored: recall over the cases a run happened to finish
 * is a figure about a different, easier set. Every case exactly once, every
 * ranked id a chunk of the set's corpus, or no score at all.
 *
 * Pure: no file, network or clock access.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../src/lib/canonical-json';
import type { CorpusChunk } from './corpus';

export const RECORD_SCHEMA = 'inflect-retriever-benchmark/1';

/** recall@K — the figure the master roadmap and D-L4-3 name. */
export const RECALL_K = 10;

/**
 * The languages a case's QUESTION is written in. The corpus is the seed's
 * English policy text, so a `bg` case measures cross-lingual retrieval: a
 * Bulgarian question that must find an English chunk. Absent means `en`.
 */
export type CaseLocale = 'en' | 'bg';
export const CASE_LOCALES: readonly CaseLocale[] = ['en', 'bg'];

export interface SeedCase {
    readonly id: string;
    /** Retrieval has one case kind: a question and the chunks that answer it. */
    readonly kind: 'task';
    readonly locale?: CaseLocale;
    readonly question: string;
    /** Corpus chunk ids, at least one. Recall is the share of these found. */
    readonly relevant: readonly string[];
    /** For a translated case, the case it translates; its labels are that case's. */
    readonly translationOf?: string;
}

export function caseLocale(c: SeedCase): CaseLocale {
    return c.locale ?? 'en';
}

export interface RetrieverSeedSet {
    readonly id: string;
    readonly version: string;
    readonly provenance: string;
    readonly contentHash: string;
    readonly corpus: readonly CorpusChunk[];
    readonly cases: readonly SeedCase[];
}

export interface ModelRef {
    /** Hugging Face model id. */
    readonly model: string;
    /** The commit the engine was started with, resolved from the Hub first (`hub.ts`). */
    readonly revision: string;
    /** Declared size, from the model card; what "the smaller" compares. */
    readonly parametersM: number;
}

export interface EmbedRef extends ModelRef {
    readonly queryPrefix: string;
    readonly passagePrefix: string;
}

export interface RecordedAnswer {
    readonly caseId: string;
    /** Chunk ids, best first, as the pipeline under test returned them. */
    readonly ranked: readonly string[];
    /** Wall time of each stage for this case's query, in milliseconds. */
    readonly stageMs: { readonly embed: number; readonly rerank?: number };
}

export interface LatencyProbe {
    /** `query-20` / `passage-512` / `rerank-32`. */
    readonly name: string;
    readonly batch: number;
    /** Mean tokens per input as the engine counted them, null if it could not say. */
    readonly tokensPerInput: number | null;
    readonly samplesMs: readonly number[];
}

export interface Aggregates {
    readonly cases: number;
    readonly recallAt10: number;
    /**
     * recall@10 per question language, over that slice's cases only. A locale
     * with no cases in the set is absent, never 0: a slice of nothing has no
     * recall.
     */
    readonly byLocale: Readonly<Partial<Record<CaseLocale, { readonly cases: number; readonly recallAt10: number }>>>;
    readonly mrrAt10: number;
    readonly embedMs: { readonly p50: number; readonly p95: number };
    readonly rerankMs: { readonly p50: number; readonly p95: number } | null;
    readonly probes: Readonly<Record<string, { readonly p50: number; readonly p95: number; readonly samples: number }>>;
}

export interface BenchmarkRecord {
    readonly schema: string;
    readonly set: { readonly id: string; readonly version: string; readonly contentHash: string };
    readonly pipeline: {
        readonly embed: EmbedRef;
        readonly rerank: ModelRef | null;
        /** How many embed hits the reranker re-orders; null without one. */
        readonly rerankDepth: number | null;
    };
    readonly engine: { readonly image: string };
    readonly environment: {
        readonly runner: string;
        readonly cpuModel: string;
        readonly cpus: number;
        readonly memoryGb: number;
    };
    readonly ranAt: string;
    readonly answers: readonly RecordedAnswer[];
    readonly probes: readonly LatencyProbe[];
    readonly aggregates?: Aggregates;
}

export type RecordProblem =
    | 'SCHEMA_UNKNOWN'
    | 'SET_MISMATCH'
    | 'NO_ANSWERS'
    | 'CASE_MISSING'
    | 'CASE_DUPLICATED'
    | 'CASE_UNKNOWN'
    | 'RANKED_UNKNOWN_CHUNK'
    | 'RANKED_DUPLICATE_CHUNK'
    | 'RANKED_TOO_SHORT'
    | 'RANKED_PAST_RERANK_DEPTH'
    | 'STAGE_TIME_INVALID'
    | 'RERANK_STAGE_MISMATCH'
    | 'REVISION_NOT_A_COMMIT'
    | 'IMAGE_NOT_DIGEST_PINNED'
    | 'PROBE_INVALID'
    | 'AGGREGATE_DISAGREES';

export interface ScoredRecord {
    readonly ok: boolean;
    readonly problems: readonly { readonly code: RecordProblem; readonly detail: string }[];
    /** Present only when `ok`: a figure over an incomplete record is not given. */
    readonly aggregates: Aggregates | null;
}

/** The hash a record names its set by: the set minus the hash itself. */
export function setContentHash(set: Omit<RetrieverSeedSet, 'contentHash'>): string {
    const body = {
        id: set.id,
        version: set.version,
        provenance: set.provenance,
        corpus: set.corpus,
        cases: set.cases,
    };
    return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

export function recallAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
    if (relevant.length === 0) throw new Error('a case with no relevant chunk cannot be scored');
    const top = new Set(ranked.slice(0, k));
    return relevant.filter((id) => top.has(id)).length / relevant.length;
}

export function reciprocalRankAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
    const wanted = new Set(relevant);
    const at = ranked.slice(0, k).findIndex((id) => wanted.has(id));
    return at < 0 ? 0 : 1 / (at + 1);
}

/** Nearest-rank percentile. Throws on no samples: a percentile of nothing is not 0. */
export function percentile(samples: readonly number[], p: number): number {
    if (samples.length === 0) throw new Error('percentile of no samples');
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[rank - 1];
}

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

function validTime(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function computeAggregates(set: RetrieverSeedSet, record: BenchmarkRecord): Aggregates {
    const byCase = new Map(set.cases.map((c) => [c.id, c]));
    let recall = 0;
    let mrr = 0;
    const slice: Partial<Record<CaseLocale, { n: number; recall: number }>> = {};
    const embedMs: number[] = [];
    const rerankMs: number[] = [];
    for (const a of record.answers) {
        const c = byCase.get(a.caseId);
        if (!c) continue;
        const caseRecall = recallAtK(a.ranked, c.relevant, RECALL_K);
        recall += caseRecall;
        mrr += reciprocalRankAtK(a.ranked, c.relevant, RECALL_K);
        const loc = caseLocale(c);
        const acc = (slice[loc] ??= { n: 0, recall: 0 });
        acc.n += 1;
        acc.recall += caseRecall;
        embedMs.push(a.stageMs.embed);
        if (a.stageMs.rerank !== undefined) rerankMs.push(a.stageMs.rerank);
    }
    const n = record.answers.length;
    const probes: Record<string, { p50: number; p95: number; samples: number }> = {};
    for (const p of record.probes) {
        probes[p.name] = { p50: percentile(p.samplesMs, 50), p95: percentile(p.samplesMs, 95), samples: p.samplesMs.length };
    }
    const byLocale: Partial<Record<CaseLocale, { cases: number; recallAt10: number }>> = {};
    for (const loc of CASE_LOCALES) {
        const acc = slice[loc];
        if (acc && acc.n > 0) byLocale[loc] = { cases: acc.n, recallAt10: round(acc.recall / acc.n) };
    }
    return {
        cases: n,
        recallAt10: round(recall / n),
        byLocale,
        mrrAt10: round(mrr / n),
        embedMs: { p50: percentile(embedMs, 50), p95: percentile(embedMs, 95) },
        rerankMs: rerankMs.length > 0 ? { p50: percentile(rerankMs, 50), p95: percentile(rerankMs, 95) } : null,
        probes,
    };
}

/**
 * Check a record against the set it names and, only if it holds up, recompute
 * its figures. Every problem is listed, not just the first, so one read of a
 * failed run says everything wrong with it.
 */
export function scoreRecord(set: RetrieverSeedSet, record: BenchmarkRecord): ScoredRecord {
    const problems: { code: RecordProblem; detail: string }[] = [];
    const add = (code: RecordProblem, detail: string) => problems.push({ code, detail });

    if (record.schema !== RECORD_SCHEMA) add('SCHEMA_UNKNOWN', `${String(record.schema)} is not ${RECORD_SCHEMA}`);
    if (record.set?.contentHash !== set.contentHash || record.set?.id !== set.id || record.set?.version !== set.version) {
        add('SET_MISMATCH', `record names ${record.set?.id}@${record.set?.version} ${record.set?.contentHash}`);
    }
    const models = [record.pipeline.embed, ...(record.pipeline.rerank ? [record.pipeline.rerank] : [])];
    for (const m of models) {
        if (!COMMIT.test(m.revision ?? '')) add('REVISION_NOT_A_COMMIT', `${m.model} revision ${String(m.revision)}`);
    }
    if (!DIGEST_PINNED.test(record.engine?.image ?? '')) add('IMAGE_NOT_DIGEST_PINNED', String(record.engine?.image));

    if (record.answers.length === 0) add('NO_ANSWERS', 'a record with no answers evidences nothing');

    const corpusIds = new Set(set.corpus.map((c) => c.id));
    const caseIds = new Set(set.cases.map((c) => c.id));
    const seen = new Set<string>();
    const minRanked = Math.min(RECALL_K, set.corpus.length);
    const hasRerank = record.pipeline.rerank !== null;
    const depth = record.pipeline.rerankDepth;
    if (hasRerank && (depth === null || !Number.isInteger(depth) || depth < RECALL_K)) {
        add('RERANK_STAGE_MISMATCH', `rerank pipeline with rerankDepth ${String(depth)}`);
    }
    for (const a of record.answers) {
        if (!caseIds.has(a.caseId)) add('CASE_UNKNOWN', a.caseId);
        if (seen.has(a.caseId)) add('CASE_DUPLICATED', a.caseId);
        seen.add(a.caseId);
        const unknown = a.ranked.filter((id) => !corpusIds.has(id));
        if (unknown.length > 0) add('RANKED_UNKNOWN_CHUNK', `${a.caseId}: ${unknown.slice(0, 3).join(', ')}`);
        if (new Set(a.ranked).size !== a.ranked.length) add('RANKED_DUPLICATE_CHUNK', a.caseId);
        if (a.ranked.length < minRanked) add('RANKED_TOO_SHORT', `${a.caseId}: ${a.ranked.length} < ${minRanked}`);
        if (hasRerank && depth !== null && a.ranked.length > depth) {
            add('RANKED_PAST_RERANK_DEPTH', `${a.caseId}: ${a.ranked.length} > ${depth}`);
        }
        if (!validTime(a.stageMs?.embed)) add('STAGE_TIME_INVALID', `${a.caseId}: embed`);
        if (hasRerank !== (a.stageMs?.rerank !== undefined)) add('RERANK_STAGE_MISMATCH', a.caseId);
        if (a.stageMs?.rerank !== undefined && !validTime(a.stageMs.rerank)) add('STAGE_TIME_INVALID', `${a.caseId}: rerank`);
    }
    for (const id of caseIds) if (!seen.has(id)) add('CASE_MISSING', id);

    for (const p of record.probes) {
        if (p.samplesMs.length === 0 || !p.samplesMs.every(validTime) || !(p.batch > 0)) {
            add('PROBE_INVALID', p.name);
        }
    }

    if (problems.length > 0) return { ok: false, problems, aggregates: null };

    const aggregates = computeAggregates(set, record);
    if (record.aggregates !== undefined && canonicalJson(record.aggregates) !== canonicalJson(aggregates)) {
        add('AGGREGATE_DISAGREES', 'the stored aggregates are not what the answers give');
        return { ok: false, problems, aggregates: null };
    }
    return { ok: true, problems, aggregates };
}

export interface ScoredPipeline {
    readonly embedModel: string;
    readonly rerankModel: string | null;
    readonly parametersM: number;
    readonly recallAt10: number;
    /** recall@10 on the Bulgarian slice; null when the set has none. */
    readonly bgRecallAt10: number | null;
}

export interface D_L4_3_Decision {
    readonly rerankModel: string | null;
    /**
     * DECIDED: every expected candidate has a scored record. BLOCKED: one is
     * missing because the engine refuses a model of that pipeline on CPU, so
     * no rerun on this engine will decide it. INCOMPLETE: one is missing for
     * any other reason.
     */
    readonly status: 'DECIDED' | 'BLOCKED' | 'INCOMPLETE';
    readonly missing: readonly string[];
    /** The refused models (embed, or this group's reranker) behind a BLOCKED status. */
    readonly blockedBy: readonly string[];
    readonly best: ScoredPipeline | null;
    /** The best recall@10 on the Bulgarian slice in this group, null without one. */
    readonly bestBg: number | null;
    readonly chosen: ScoredPipeline | null;
    readonly margin: number;
}

/**
 * D-L4-3: "keep the smaller unless recall@10 drops past a margin". For each
 * reranker (and for no reranker), the chosen pipeline is the SMALLEST whose
 * recall@10 is within `margin` of the best, overall AND on the Bulgarian
 * slice (amended 2026-11-13, owner): a model that keeps up in English and
 * falls past the margin on Bulgarian questions is not eligible, because the
 * product serves both languages. An expected candidate with no
 * scored record makes the comparison INCOMPLETE (or BLOCKED, when the engine
 * refused it) — a decision that never saw one of the candidates is not the
 * decision the owner asked for.
 *
 * Among eligible pipelines of EQUAL declared size the higher recall wins, then
 * the model id: the size rule says nothing between two same-size models, and
 * input order must not pick the worse one.
 */
export function chooseSmallest(eligible: readonly ScoredPipeline[]): ScoredPipeline {
    if (eligible.length === 0) throw new Error('no eligible pipeline to choose from');
    return [...eligible].sort(
        (a, b) =>
            a.parametersM - b.parametersM ||
            b.recallAt10 - a.recallAt10 ||
            (a.embedModel < b.embedModel ? -1 : a.embedModel > b.embedModel ? 1 : 0),
    )[0];
}

export function decideD_L4_3(
    pipelines: readonly ScoredPipeline[],
    expectedEmbedModels: readonly string[],
    rerankModels: readonly (string | null)[],
    margin: number,
    engineRefused: ReadonlySet<string> = new Set(),
): D_L4_3_Decision[] {
    return rerankModels.map((rerankModel) => {
        const group = pipelines.filter((p) => p.rerankModel === rerankModel);
        const missing = expectedEmbedModels.filter((m) => !group.some((p) => p.embedModel === m));
        const blockedBy = missing.length === 0
            ? []
            : [...missing.filter((m) => engineRefused.has(m)), ...(rerankModel !== null && engineRefused.has(rerankModel) ? [rerankModel] : [])];
        const gap = blockedBy.length > 0 ? 'BLOCKED' : 'INCOMPLETE';
        if (group.length === 0) {
            return { rerankModel, status: gap, missing, blockedBy, best: null, bestBg: null, chosen: null, margin };
        }
        const best = group.reduce((a, b) => (b.recallAt10 > a.recallAt10 ? b : a));
        const bgOf = (p: ScoredPipeline): number | null => (typeof p.bgRecallAt10 === 'number' ? p.bgRecallAt10 : null);
        const bgScores = group.map(bgOf).filter((x): x is number => x !== null);
        const bestBg = bgScores.length > 0 ? Math.max(...bgScores) : null;
        // The epsilon keeps a drop of exactly `margin` inside it: 0.2 - 0.05
        // is 0.15000000000000002 in binary floating point, above 0.15.
        const within = (x: number, top: number) => x + 1e-9 >= top - margin;
        const eligible = group.filter(
            (p) => {
                const bg = bgOf(p);
                return within(p.recallAt10, best.recallAt10) && (bestBg === null || (bg !== null && within(bg, bestBg)));
            },
        );
        const chosen = chooseSmallest(eligible);
        return { rerankModel, status: missing.length > 0 ? gap : 'DECIDED', missing, blockedBy, best, bestBg, chosen, margin };
    });
}
