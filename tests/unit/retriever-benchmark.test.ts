/**
 * The D-L4-3 retriever benchmark: its seed set, its scoring, and the shape of
 * the workflow that runs it (docs/ai-architecture/nemotron-retriever.md,
 * Phase 0.3-0.4).
 *
 * The workflow itself is dispatch-only and is never run by CI, so everything
 * that decides what its records MEAN is held here instead: the set is seed
 * data and hashed, a record is raw answers whose figures are recomputed, and
 * an incomplete record is refused rather than scored.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import {
    EMBED_CANDIDATES,
    RERANK_CANDIDATES,
    RERANK_DEPTH,
    TEI_CPU_IMAGE,
    teiCpuRefusal,
} from '../../scripts/retriever-benchmark/candidates';
import { HUB_ORIGIN, hubRevisionUrl, parseHubRevision } from '../../scripts/retriever-benchmark/hub';
import {
    buildCorpus,
    chunkDocument,
    loadSeedSources,
    type CorpusChunk,
} from '../../scripts/retriever-benchmark/corpus';
import {
    readSeedSet,
    rebuildSeedSet,
    serialiseSeedSet,
    SEED_SET_FILE,
} from '../../scripts/retriever-benchmark/build-seed-set';
import {
    revisionOf,
    summarise,
    teiArgs,
    teiUrl,
    topByCosine,
    type StageFailure,
} from '../../scripts/retriever-benchmark/run';
import {
    RECORD_SCHEMA,
    computeAggregates,
    chooseSmallest,
    decideD_L4_3,
    percentile,
    recallAtK,
    reciprocalRankAtK,
    scoreRecord,
    setContentHash,
    type BenchmarkRecord,
    type RecordProblem,
    type RetrieverSeedSet,
} from '../../scripts/retriever-benchmark/scoring';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/retriever-benchmark.yml');

// ─── The seed set ───────────────────────────────────────────────────────────

describe('the retriever seed set is seed data, hashed', () => {
    const set = readSeedSet(ROOT);

    it('the committed corpus is exactly what the chunker derives from the seed today', () => {
        // A seed policy edited after the set was built fails here until the set
        // is rebuilt — which moves the hash and retires every older record.
        const rebuilt = rebuildSeedSet(ROOT, set);
        expect(serialiseSeedSet(rebuilt)).toBe(fs.readFileSync(path.join(ROOT, SEED_SET_FILE), 'utf-8'));
    });

    it('the content hash is recomputed from the set, never trusted', () => {
        const { contentHash, ...body } = set;
        expect(setContentHash(body)).toBe(contentHash);
        expect(setContentHash({ ...body, cases: body.cases.slice(1) })).not.toBe(contentHash);
    });

    it('holds 200 cases with unique ids and questions, each answered by chunks the corpus holds', () => {
        expect(set.cases).toHaveLength(200);
        expect(new Set(set.cases.map((c) => c.id)).size).toBe(200);
        expect(new Set(set.cases.map((c) => c.question)).size).toBe(200);
        const ids = new Set(set.corpus.map((c) => c.id));
        expect(ids.size).toBe(set.corpus.length);
        for (const c of set.cases) {
            expect(c.kind).toBe('task');
            expect(c.relevant.length).toBeGreaterThan(0);
            for (const r of c.relevant) expect(ids.has(r)).toBe(true);
        }
    });

    it('holds distractors that answer no case, so recall@10 is not a corpus of answers', () => {
        // Near-duplicate sections across the seed's policies (several "evidence
        // to retain" and "exceptions" blocks) are the hard negatives; a corpus of
        // answers only would make every model look perfect.
        const answering = new Set(set.cases.flatMap((c) => c.relevant));
        const distractors = set.corpus.filter((c) => !answering.has(c.id)).length;
        expect(distractors).toBeGreaterThanOrEqual(answering.size * 0.9);
        expect(distractors).toBeGreaterThan(150);
    });

    it('says it is synthetic and names only seed sources', () => {
        expect(set.provenance).toMatch(/^SYNTHETIC\./);
        const sources = new Set(set.corpus.map((c) => c.source));
        expect([...sources].sort()).toEqual(['prisma/fixtures/policy-templates-ciso-toolkit.json', 'prisma/seed.ts']);
    });
});

describe('the corpus loader and chunker', () => {
    it('refuses a seed it cannot parse rather than shrinking the corpus', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retriever-seed-'));
        fs.mkdirSync(path.join(dir, 'prisma/fixtures'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'prisma/seed.ts'), 'export {};\n');
        fs.writeFileSync(path.join(dir, 'prisma/fixtures/policy-templates-ciso-toolkit.json'), '{"templates":[]}');
        expect(() => loadSeedSources(dir)).toThrow(/no starter policy templates/);
    });

    it('splits a numbered Policy Statements list into one chunk per statement', () => {
        const chunks = chunkDocument({
            source: 's',
            title: 'Demo Policy',
            format: 'markdown',
            text: '# Demo Policy\n\n## Purpose\nWhy.\n\n## Policy Statements\n1. First.\n2. Second.\n\n## Empty\n\n## Review\nYearly.',
        });
        expect(chunks.map((c) => c.id)).toEqual([
            'demo-policy/purpose',
            'demo-policy/policy-statements-1',
            'demo-policy/policy-statements-2',
            'demo-policy/review',
        ]);
        expect(chunks[1].text).toBe('Demo Policy — Policy Statements / 1\nFirst.');
    });

    it('reads an HTML template one heading section at a time, tags stripped', () => {
        const chunks = chunkDocument({
            source: 's',
            title: 'Web Policy',
            format: 'html',
            text: '<h1>Web Policy</h1><hr><h2>Scope</h2><p>All <b>staff</b>.</p><h2>Rules</h2><p>Be kind.</p>',
        });
        expect(chunks.map((c) => c.text)).toEqual(['Web Policy — Scope\nAll staff .', 'Web Policy — Rules\nBe kind.']);
    });

    it('gives a repeated id a numeric suffix in order of appearance', () => {
        const doc = { source: 's', title: 'Same', format: 'markdown' as const, text: '## A\nx\n## A\ny' };
        expect(buildCorpus([doc]).map((c) => c.id)).toEqual(['same/a', 'same/a-2']);
    });
});

// ─── Scoring ────────────────────────────────────────────────────────────────

const COMMIT = 'a'.repeat(40);
const IMAGE = `ghcr.io/huggingface/text-embeddings-inference@sha256:${'b'.repeat(64)}`;

function tinySet(): RetrieverSeedSet {
    const corpus: CorpusChunk[] = Array.from({ length: 12 }, (_, i) => ({
        id: `doc/c${i}`,
        source: 'prisma/seed.ts',
        title: 'Doc',
        heading: `C${i}`,
        text: `Doc — C${i}\nbody ${i}`,
    }));
    const body = {
        id: 'tiny',
        version: '1',
        provenance: 'SYNTHETIC. test',
        corpus,
        cases: [
            { id: 'q1', kind: 'task' as const, question: 'one?', relevant: ['doc/c0'] },
            { id: 'q2', kind: 'task' as const, question: 'two?', relevant: ['doc/c1', 'doc/c11'] },
        ],
    };
    return { ...body, contentHash: setContentHash(body) };
}

const ranking = (first: string[]) => [...first, ...Array.from({ length: 12 }, (_, i) => `doc/c${i}`).filter((x) => !first.includes(x))];

function validRecord(set: RetrieverSeedSet, rerank = false): BenchmarkRecord {
    return {
        schema: RECORD_SCHEMA,
        set: { id: set.id, version: set.version, contentHash: set.contentHash },
        pipeline: {
            embed: { model: 'm/embed', revision: COMMIT, parametersM: 33, queryPrefix: 'query: ', passagePrefix: '' },
            rerank: rerank ? { model: 'm/rerank', revision: COMMIT, parametersM: 278 } : null,
            rerankDepth: rerank ? 12 : null,
        },
        engine: { image: IMAGE },
        environment: { runner: 'test', cpuModel: 'x', cpus: 4, memoryGb: 16 },
        ranAt: '2026-11-11T00:00:00.000Z',
        answers: [
            { caseId: 'q1', ranked: ranking(['doc/c0']), stageMs: rerank ? { embed: 5, rerank: 40 } : { embed: 5 } },
            { caseId: 'q2', ranked: ranking(['doc/c1']), stageMs: rerank ? { embed: 7, rerank: 60 } : { embed: 7 } },
        ],
        probes: [{ name: 'query-20', batch: 32, tokensPerInput: 18, samplesMs: [10, 12, 11] }],
    };
}

describe('recall@10 and the percentiles are computed, not reported', () => {
    it('counts a relevant chunk at rank 10 and not at rank 11', () => {
        const ids = Array.from({ length: 11 }, (_, i) => `x${i}`);
        expect(recallAtK(ids, ['x9'], 10)).toBe(1);
        expect(recallAtK(ids, ['x10'], 10)).toBe(0);
    });

    it('gives the share of relevant chunks found when a case has several', () => {
        expect(recallAtK(['a', 'b'], ['a', 'z'], 10)).toBe(0.5);
        expect(reciprocalRankAtK(['q', 'a'], ['a'], 10)).toBe(0.5);
    });

    it('refuses to score a case with no relevant chunk', () => {
        expect(() => recallAtK(['a'], [], 10)).toThrow();
    });

    it('takes the nearest-rank percentile and refuses an empty sample', () => {
        const s = Array.from({ length: 20 }, (_, i) => i + 1);
        expect(percentile(s, 50)).toBe(10);
        expect(percentile(s, 95)).toBe(19);
        expect(() => percentile([], 50)).toThrow();
    });
});

describe('scoreRecord: a complete record is scored, anything else is refused', () => {
    const set = tinySet();

    it('scores a complete record from its raw answers', () => {
        const scored = scoreRecord(set, validRecord(set));
        expect(scored.problems).toEqual([]);
        expect(scored.ok).toBe(true);
        // q1 finds its one chunk at rank 1; q2 finds c1 at rank 1 and c11 at rank 12 (outside 10).
        expect(scored.aggregates?.recallAt10).toBe(0.75);
        expect(scored.aggregates?.mrrAt10).toBe(1);
        expect(scored.aggregates?.embedMs).toEqual({ p50: 5, p95: 7 });
        expect(scored.aggregates?.probes['query-20']).toEqual({ p50: 11, p95: 12, samples: 3 });
    });

    it('scores a rerank record and its rerank stage times', () => {
        const scored = scoreRecord(set, validRecord(set, true));
        expect(scored.ok).toBe(true);
        expect(scored.aggregates?.rerankMs).toEqual({ p50: 40, p95: 60 });
    });

    it('accepts stored aggregates only when they are what the answers give', () => {
        const r = validRecord(set);
        expect(scoreRecord(set, { ...r, aggregates: computeAggregates(set, r) }).ok).toBe(true);
        const edited = { ...computeAggregates(set, r), recallAt10: 0.99 };
        const scored = scoreRecord(set, { ...r, aggregates: edited });
        expect(scored.ok).toBe(false);
        expect(scored.problems.map((p) => p.code)).toEqual(['AGGREGATE_DISAGREES']);
        expect(scored.aggregates).toBeNull();
    });

    const mutations: Array<[RecordProblem, (r: BenchmarkRecord) => BenchmarkRecord]> = [
        ['SCHEMA_UNKNOWN', (r) => ({ ...r, schema: 'other/1' })],
        ['SET_MISMATCH', (r) => ({ ...r, set: { ...r.set, contentHash: `sha256:${'0'.repeat(64)}` } })],
        ['NO_ANSWERS', (r) => ({ ...r, answers: [] })],
        ['CASE_MISSING', (r) => ({ ...r, answers: r.answers.slice(0, 1) })],
        ['CASE_DUPLICATED', (r) => ({ ...r, answers: [...r.answers, r.answers[0]] })],
        ['CASE_UNKNOWN', (r) => ({ ...r, answers: [...r.answers, { ...r.answers[0], caseId: 'q9' }] })],
        ['RANKED_UNKNOWN_CHUNK', (r) => ({ ...r, answers: [{ ...r.answers[0], ranked: ['doc/nope', ...r.answers[0].ranked.slice(1)] }, r.answers[1]] })],
        ['RANKED_DUPLICATE_CHUNK', (r) => ({ ...r, answers: [{ ...r.answers[0], ranked: ['doc/c0', ...r.answers[0].ranked] }, r.answers[1]] })],
        ['RANKED_TOO_SHORT', (r) => ({ ...r, answers: [{ ...r.answers[0], ranked: ['doc/c0'] }, r.answers[1]] })],
        ['STAGE_TIME_INVALID', (r) => ({ ...r, answers: [{ ...r.answers[0], stageMs: { embed: Number.NaN } }, r.answers[1]] })],
        ['RERANK_STAGE_MISMATCH', (r) => ({ ...r, answers: [{ ...r.answers[0], stageMs: { embed: 1, rerank: 1 } }, r.answers[1]] })],
        ['REVISION_NOT_A_COMMIT', (r) => ({ ...r, pipeline: { ...r.pipeline, embed: { ...r.pipeline.embed, revision: 'main' } } })],
        ['IMAGE_NOT_DIGEST_PINNED', (r) => ({ ...r, engine: { image: 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4' } })],
        ['PROBE_INVALID', (r) => ({ ...r, probes: [{ ...r.probes[0], samplesMs: [] }] })],
    ];

    it.each(mutations)('refuses with %s and gives no figure', (code, mutate) => {
        const scored = scoreRecord(set, mutate(validRecord(set)));
        expect(scored.ok).toBe(false);
        expect(scored.problems.map((p) => p.code)).toContain(code);
        expect(scored.aggregates).toBeNull();
    });

    it('refuses a rerank record whose ranking reaches past the depth it reranked', () => {
        const r = validRecord(set, true);
        const scored = scoreRecord(set, { ...r, pipeline: { ...r.pipeline, rerankDepth: 10 } });
        expect(scored.problems.map((p) => p.code)).toContain('RANKED_PAST_RERANK_DEPTH');
    });
});

describe('the D-L4-3 rule: the smallest pipeline within the margin of the best', () => {
    const big = { embedModel: 'nvidia/big', rerankModel: null, parametersM: 1236, recallAt10: 0.85 };
    const small = { embedModel: 'baai/small', rerankModel: null, parametersM: 33 };
    const expected = ['nvidia/big', 'baai/small'];

    it('keeps the smaller model when its recall is within the margin', () => {
        const [d] = decideD_L4_3([big, { ...small, recallAt10: 0.81 }], expected, [null], 0.05);
        expect(d.status).toBe('DECIDED');
        expect(d.chosen?.embedModel).toBe('baai/small');
        expect(d.best?.embedModel).toBe('nvidia/big');
    });

    it('keeps it at a drop of exactly the margin, floating point notwithstanding', () => {
        // 0.2 - 0.05 is 0.15000000000000002, above 0.15, in binary floating point.
        for (const [b, s] of [[0.85, 0.8], [0.2, 0.15]]) {
            const [d] = decideD_L4_3([{ ...big, recallAt10: b }, { ...small, recallAt10: s }], expected, [null], 0.05);
            expect(d.chosen?.embedModel).toBe('baai/small');
        }
    });

    it('takes the larger model when the smaller drops past the margin', () => {
        const [d] = decideD_L4_3([big, { ...small, recallAt10: 0.79 }], expected, [null], 0.05);
        expect(d.chosen?.embedModel).toBe('nvidia/big');
    });

    it('is INCOMPLETE, naming the gap, when a candidate has no scored record', () => {
        const [d] = decideD_L4_3([{ ...small, recallAt10: 0.8 }], expected, [null], 0.05);
        expect(d.status).toBe('INCOMPLETE');
        expect(d.missing).toEqual(['nvidia/big']);
    });

    it('between two eligible models of the same size, chooses the higher recall whatever the input order', () => {
        const nemotron = { embedModel: 'nvidia/llama-nemotron-embed-1b-v2', rerankModel: null, parametersM: 1236, recallAt10: 0.85 };
        const bge = { embedModel: 'BAAI/bge-small-en-v1.5', rerankModel: null, parametersM: 33, recallAt10: 0.8 };
        const e5 = { embedModel: 'intfloat/e5-small-v2', rerankModel: null, parametersM: 33, recallAt10: 0.84 };
        const models = [nemotron.embedModel, bge.embedModel, e5.embedModel];
        for (const order of [[bge, e5, nemotron], [e5, bge, nemotron], [nemotron, bge, e5]]) {
            const [d] = decideD_L4_3(order, models, [null], 0.05);
            expect(d.chosen?.embedModel).toBe('intfloat/e5-small-v2');
        }
    });

    it('breaks an exact tie of size and recall by model id, so a rerun proposes the same model', () => {
        const a = { embedModel: 'a/m', rerankModel: null, parametersM: 33, recallAt10: 0.8 };
        const b = { ...a, embedModel: 'b/m' };
        expect(chooseSmallest([b, a]).embedModel).toBe('a/m');
        expect(chooseSmallest([a, b]).embedModel).toBe('a/m');
        expect(() => chooseSmallest([])).toThrow();
    });

    it('is BLOCKED, naming the refused model, when the engine refused a missing candidate', () => {
        const refused = new Set(['nvidia/big']);
        const [d] = decideD_L4_3([{ ...small, recallAt10: 0.8 }], expected, [null], 0.05, refused);
        expect(d.status).toBe('BLOCKED');
        expect(d.blockedBy).toEqual(['nvidia/big']);
        // A refused reranker blocks its whole group, even with no embed record missing for its own reason.
        const [r] = decideD_L4_3([], expected, ['nvidia/rerank'], 0.05, new Set(['nvidia/rerank']));
        expect(r.status).toBe('BLOCKED');
        expect(r.blockedBy).toEqual(['nvidia/rerank']);
        // A missing candidate the engine did NOT refuse leaves it INCOMPLETE.
        const [i] = decideD_L4_3([{ ...small, recallAt10: 0.8 }], expected, [null], 0.05, new Set(['other/model']));
        expect(i.status).toBe('INCOMPLETE');
        expect(i.blockedBy).toEqual([]);
    });

    it('decides each reranker separately and never mixes their records', () => {
        const withRerank = { ...big, rerankModel: 'r', recallAt10: 0.95 };
        const [none, r] = decideD_L4_3([big, { ...small, recallAt10: 0.82 }, withRerank], expected, [null, 'r'], 0.05);
        expect(none.chosen?.embedModel).toBe('baai/small');
        expect(r.status).toBe('INCOMPLETE');
        expect(r.missing).toEqual(['baai/small']);
    });
});

// ─── The runner ─────────────────────────────────────────────────────────────

describe('the runner sends benchmark text to the loopback engine only', () => {
    it('builds a URL on the loopback container', () => {
        expect(teiUrl('http://127.0.0.1:18080/', 'embed')).toBe('http://127.0.0.1:18080/embed');
    });

    it.each(['http://example.com/', 'https://127.0.0.1:18080/', 'http://localhost:18080/', 'http://10.0.0.5/'])(
        'refuses %s',
        (base) => {
            expect(() => teiUrl(base, 'embed')).toThrow(/only the loopback TEI container/);
        },
    );

    it('ranks by dot product and breaks ties by corpus order, so a rerun ranks identically', () => {
        expect(topByCosine([1, 0], [[0, 1], [1, 0], [1, 0], [0.5, 0.5]], 3)).toEqual([1, 2, 3]);
    });

    it('summarises only scored records into the decision, and lists a refused one with its reason', () => {
        const set = tinySet();
        const good = validRecord(set);
        const bad = { ...validRecord(set), answers: [] };
        const s = summarise(set, [
            { file: 'good.json', record: good },
            { file: 'bad.json', record: bad },
        ]);
        expect(s.records.map((r) => [r.file, r.ok])).toEqual([['good.json', true], ['bad.json', false]]);
        expect(s.records[1].problems[0]).toMatch(/^NO_ANSWERS/);
        // The test records name no real candidate, so every decision is INCOMPLETE.
        expect(s.decisions.every((d) => d.status === 'INCOMPLETE')).toBe(true);
    });

    it('reports a comparison BLOCKED when a failure file says the engine refused its model', () => {
        const set = tinySet();
        const refusal: StageFailure = {
            stage: 'embed',
            model: 'nvidia/llama-nemotron-embed-1b-v2',
            code: 'ENGINE_REFUSES_ON_CPU',
            reason: 'TEI CPU refuses it',
            engineLog: null,
            at: '2026-11-12T00:00:00.000Z',
        };
        const blocked = summarise(set, [], [refusal]);
        expect(blocked.decisions.every((d) => d.status === 'BLOCKED')).toBe(true);
        const crashed = summarise(set, [], [{ ...refusal, code: 'STAGE_FAILED' }]);
        expect(crashed.decisions.every((d) => d.status === 'INCOMPLETE')).toBe(true);
    });
});

// ─── The commit a stage loads ───────────────────────────────────────────────

describe('a stage loads a commit resolved before the engine starts, never one TEI is asked for', () => {
    const SHA = 'c'.repeat(40);

    it('starts TEI with --revision and the commit, and refuses to start it without one', () => {
        const args = teiArgs('BAAI/bge-small-en-v1.5', SHA, '/cache', false);
        expect(args.slice(args.indexOf('--revision'), args.indexOf('--revision') + 2)).toEqual(['--revision', SHA]);
        expect(args).toContain(TEI_CPU_IMAGE);
        expect(args).not.toContain('HF_TOKEN');
        expect(teiArgs('BAAI/bge-small-en-v1.5', SHA, '/cache', true)).toEqual(expect.arrayContaining(['-e', 'HF_TOKEN']));
        for (const bad of ['main', '', 'unknown', SHA.slice(1)]) {
            expect(() => teiArgs('BAAI/bge-small-en-v1.5', bad, '/cache', false)).toThrow(/without a commit/);
        }
    });

    it('refuses TEI /info that does not echo the commit, which is what a run without --revision gives', () => {
        // TEI v1.9.4 router/src/lib.rs: `model_sha: revision` — null when no --revision was passed.
        expect(() => revisionOf({ model_id: 'm/x', model_sha: null }, 'm/x', SHA)).toThrow(/not the commit/);
        expect(() => revisionOf({ model_id: 'm/x', model_sha: 'd'.repeat(40) }, 'm/x', SHA)).toThrow(/not the commit/);
        expect(() => revisionOf({ model_id: 'm/other', model_sha: SHA }, 'm/x', SHA)).toThrow(/not m\/x/);
        expect(revisionOf({ model_id: 'm/x', model_sha: SHA }, 'm/x', SHA)).toBe(SHA);
    });

    it('asks the Hub, and only the Hub, at main or at the pinned commit', () => {
        expect(hubRevisionUrl('BAAI/bge-small-en-v1.5', null)).toBe(`${HUB_ORIGIN}/api/models/BAAI/bge-small-en-v1.5/revision/main`);
        expect(hubRevisionUrl('BAAI/bge-small-en-v1.5', SHA)).toBe(`${HUB_ORIGIN}/api/models/BAAI/bge-small-en-v1.5/revision/${SHA}`);
        expect(HUB_ORIGIN).toBe('https://huggingface.co');
        for (const bad of ['../x/y', 'x', 'a/b/c', 'a/b?x=1', 'https://evil.example/a']) {
            expect(() => hubRevisionUrl(bad, null)).toThrow(/not a Hub model id/);
        }
        expect(() => hubRevisionUrl('a/b', 'main')).toThrow(/40-character commit/);
    });

    it('takes a commit from the Hub answer and refuses anything that is not one', () => {
        const body = { id: 'a/b', sha: SHA, config: { model_type: 'bert' }, siblings: [{ rfilename: 'config.json' }] };
        expect(parseHubRevision(body, 'a/b', null)).toEqual({ model: 'a/b', sha: SHA, modelType: 'bert', files: ['config.json'] });
        expect(() => parseHubRevision({ ...body, sha: null }, 'a/b', null)).toThrow(/no commit/);
        expect(() => parseHubRevision({ ...body, sha: 'main' }, 'a/b', null)).toThrow(/no commit/);
        expect(() => parseHubRevision({ ...body, id: 'a/c' }, 'a/b', null)).toThrow(/not a\/b/);
        expect(() => parseHubRevision(body, 'a/b', 'd'.repeat(40))).toThrow(/resolved/);
        expect(parseHubRevision({ id: 'a/b', sha: SHA }, 'a/b', SHA)).toEqual({ model: 'a/b', sha: SHA, modelType: null, files: [] });
    });
});

describe('a candidate TEI CPU refuses is refused before a container starts', () => {
    it('refuses a Llama-based model with TEI\'s own sentence', () => {
        for (const modelType of ['llama', 'llama_bidirec', 'mistral', 'qwen2']) {
            expect(teiCpuRefusal({ modelType, files: ['model.safetensors'] })).toMatch(/only supported on Cuda devices/);
        }
    });

    it('lets TEI try one whose repository carries an ONNX export, which the ORT backend loads first', () => {
        expect(teiCpuRefusal({ modelType: 'llama_bidirec', files: ['onnx/model.onnx', 'onnx/model.onnx_data'] })).toBeNull();
        expect(teiCpuRefusal({ modelType: 'llama', files: ['model.onnx'] })).toBeNull();
    });

    it('does not refuse a model type it serves, or one the Hub did not name', () => {
        for (const modelType of ['bert', 'xlm-roberta', null]) expect(teiCpuRefusal({ modelType, files: [] })).toBeNull();
    });
});

// ─── The candidates and the workflow ────────────────────────────────────────

describe('the benchmark compares what D-L4-3 names, on a pinned engine', () => {
    it('pins the TEI image by digest', () => {
        expect(TEI_CPU_IMAGE).toMatch(/^ghcr\.io\/huggingface\/text-embeddings-inference@sha256:[0-9a-f]{64}$/);
    });

    it('compares a Nemotron model with a smaller open one, for embedding and for reranking', () => {
        for (const list of [EMBED_CANDIDATES, RERANK_CANDIDATES]) {
            const nemotron = list.filter((c) => c.nemotron);
            const open = list.filter((c) => !c.nemotron);
            expect(nemotron.length).toBe(1);
            expect(open.length).toBeGreaterThan(0);
            for (const o of open) expect(o.parametersM).toBeLessThan(nemotron[0].parametersM);
        }
    });

    it('pins a revision as a commit or leaves it to the Hub to resolve, never a branch name', () => {
        for (const c of [...EMBED_CANDIDATES, ...RERANK_CANDIDATES]) {
            if (c.revision !== null) expect(c.revision).toMatch(/^[0-9a-f]{40}$/);
            expect(() => hubRevisionUrl(c.model, c.revision)).not.toThrow();
        }
    });

    it('reranks no more than 50 embed hits (Phase 2 bound)', () => {
        expect(RERANK_DEPTH).toBeLessThanOrEqual(50);
    });
});

describe('the workflow runs on a GitHub runner, by dispatch, and commits nothing', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf-8');
    const doc = yaml.load(text) as {
        on: Record<string, unknown>;
        permissions: Record<string, string>;
        jobs: Record<string, { 'runs-on': string; environment?: unknown; strategy?: { matrix?: { embed?: string[] } }; permissions?: unknown }>;
    };

    it('is dispatch-only', () => {
        expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    });

    it('holds contents: read and nothing else, at workflow level and in every job', () => {
        expect(doc.permissions).toEqual({ contents: 'read' });
        for (const job of Object.values(doc.jobs)) expect(job.permissions).toBeUndefined();
    });

    it('runs on GitHub-hosted runners, outside the production environment', () => {
        for (const job of Object.values(doc.jobs)) {
            expect(job['runs-on']).toBe('ubuntu-latest');
            expect(job.environment).toBeUndefined();
        }
        expect(text).not.toMatch(/gcloud|google-github-actions|compute ssh/);
    });

    it('benchmarks exactly the embed candidates the scripts know', () => {
        expect(doc.jobs.bench.strategy?.matrix?.embed).toEqual(EMBED_CANDIDATES.map((c) => c.id));
    });

    it('hands the summary the failure files, so a refused candidate reads BLOCKED', () => {
        expect(text).toMatch(/uses: actions\/download-artifact@v\d+\n\s+with:\n\s+pattern: retriever-failures-\*/);
        expect(text).toMatch(/run\.ts summarize[^\n]*\\\n[^\n]*--records retriever-records \\\n\s+--failures retriever-failures/);
    });

    it('uploads records as an artifact and never pushes them', () => {
        expect(text).toMatch(/uses: actions\/upload-artifact@v\d+\n\s+with:\n\s+name: retriever-records-/);
        expect(text).not.toMatch(/git (push|commit)|contents: write|pull-requests: write/);
    });
});
