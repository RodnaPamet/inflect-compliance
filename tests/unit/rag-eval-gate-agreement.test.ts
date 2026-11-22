/**
 * The Ragas nightly and the `search_knowledge` mount gate agree
 * (Ragas Phase 1.2; vector store Phase 3.5-3.6; owner decisions 2026-11-16).
 *
 *   1. ONE REVISION. A record the nightly writes is keyed by the revision the
 *      probe builds (`scripts/rag-eval/search-seam.ts`), and the gate looks a
 *      record up by `knowledgeRetrieverRevision(route)`. For the same route the
 *      two are the same object, the same key and the same file name — and the
 *      settings the probe reads its plans under are the ones that revision
 *      states, so a probe of the deployment's index is not refused by its own
 *      plan check. A record keyed the way the harness keyed it before the
 *      wiring is not found: forgetting the wiring fails closed.
 *   2. ONE SET OF FLOORS. D-L4-9's two values are written once
 *      (`rag-retrieval-floors.ts`); the gate reads a record's figures through
 *      `readRetrievalFloors`, the function the nightly's checker reads them
 *      through. Over records straddling each floor, the gate mounts exactly
 *      when the nightly's reading says both are met.
 *   3. ONE CALL. The probe's ANN arm issues the store query `searchKnowledge`
 *      issues — the revision's depth (20) and the caller's source filter —
 *      pinned to the index path, and the probe's own context (the index job's)
 *      gets the same filter a reader's does. Captured from the usecase itself,
 *      so a change to either side's depth or filter fails here (owner
 *      decision 2026-11-16, D-L4-9 amended).
 */
jest.mock('@/app-layer/services/knowledge-index', () => ({
    ...jest.requireActual('@/app-layer/services/knowledge-index'),
    readResidency: jest.fn(async () => ({ residency: 'EXTERNAL' })),
}));

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gateModule from '@/app-layer/services/knowledge-search-mount';
import { resolveKnowledgeSearchMount, type KnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';
import { retrieverRevisionKey } from '@/lib/ai/embeddings';
import {
    RECALL_AT,
    ragRetrieverRevisionId,
    ragSetHash,
    RagEvaluationSetSchema,
    retrievalFloorFigures,
    type RagEvaluationRecord,
    type RagEvaluationSet,
} from '@/lib/ai/evals/rag-record';
import {
    P95_SEARCH_LATENCY_MS_CEILING,
    RECALL_AT_10_VS_EXACT_FLOOR,
    readRetrievalFloors,
} from '@/lib/ai/evals/rag-retrieval-floors';
import { assertPlansMatchRevision, indexParamsFromPlans } from '../../scripts/rag-eval/probe';
import { codeOf } from '../helpers/source-blocks';
import { annQuery, productQuery, retrieverRevision, searchSettings } from '../../scripts/rag-eval/search-seam';
import type { VectorRepository, VectorSearchQuery } from '@/app-layer/repositories/VectorRepository';
import { indexContext } from '@/app-layer/services/knowledge-index';
import { searchKnowledge } from '@/app-layer/usecases/knowledge-search';
import { StubEmbeddingProvider, STUB_EMBEDDING_MODEL } from '@/lib/ai/embeddings';
import { makeRequestContext } from '../helpers/make-context';

const REPO = path.resolve(__dirname, '../..');
const E5 = { model: 'intfloat/multilingual-e5-small', dimensions: 384 };
const ROUTES = [E5, { model: 'BAAI/bge-m3', dimensions: 1024 }, { model: 'stub-feature-hash@1', dimensions: 384 }];
const SET_RAW = JSON.parse(fs.readFileSync(path.join(REPO, 'evals/rag/sets/seed-policies.json'), 'utf-8')) as unknown;
const SET: RagEvaluationSet = RagEvaluationSetSchema.parse(SET_RAW);
const PRICE_HASH = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(REPO, 'evals/cost-meter/prices.json'))).digest('hex')}`;

/** The deployment's HNSW index as its migration creates it: what the probe reads the build parameters from. */
const MIGRATION_INDEX = (() => {
    const sql = fs.readFileSync(path.join(REPO, 'prisma/migrations/20261115190000_knowledge_vector_store/migration.sql'), 'utf-8');
    const stmt = /CREATE INDEX "KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx"[^;]*;/.exec(sql)?.[0];
    if (!stmt) throw new Error('the knowledge store migration no longer creates the e5-small HNSW index');
    return { indexname: 'KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx', indexdef: stmt };
})();

const chunk = (i: number) => ({ sourceModel: 'Policy', sourceKey: 'access-management-policy', chunkIndex: i });
const TOP = Array.from({ length: RECALL_AT }, (_, i) => chunk(i));

/** A COMPLETE record over every case of the seed set; the first `missing` cases each miss one exact hit. */
function record(revision: RagEvaluationRecord['retrieverRevision'], opts: { missing?: number; latencyMs?: number } = {}) {
    return {
        setHash: ragSetHash(SET),
        corpus: 'seed',
        retrieverRevision: revision,
        judgeRevision: { provider: 'anthropic', model: 'claude-haiku-4-5', embeddingModel: 'judge-embed', ragasVersion: '0.4.3', priceTableHash: PRICE_HASH },
        answerRevision: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        ranAt: '2026-11-16T01:00:00.000Z',
        status: 'COMPLETE',
        spendUsd: 0.4,
        cases: SET.cases.map((c, i) => ({
            caseId: c.id,
            answer: 'an answer',
            retrieved: [],
            retrievalProbe: {
                ann: i < (opts.missing ?? 0) ? [...TOP.slice(0, RECALL_AT - 1), chunk(100)] : TOP,
                exact: TOP,
                latencyMs: opts.latencyMs ?? 40,
            },
            metrics: { faithfulness: 1, answerRelevancy: 1, contextPrecision: 1, contextRecall: 1 },
            abstained: false,
            judgeOutputs: [],
        })),
    };
}

const roots: string[] = [];
function gateOver(records: Record<string, unknown>, route = E5): KnowledgeSearchMount {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-gate-agree-'));
    roots.push(root);
    for (const d of ['evals/rag/records', 'evals/rag/sets', 'evals/cost-meter']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'evals/rag/sets/seed-policies.json'), JSON.stringify(SET_RAW));
    for (const f of ['prices.json', 'shares.json']) fs.copyFileSync(path.join(REPO, 'evals/cost-meter', f), path.join(root, 'evals/cost-meter', f));
    for (const [file, body] of Object.entries(records)) fs.writeFileSync(path.join(root, 'evals/rag/records', file), JSON.stringify(body));
    return resolveKnowledgeSearchMount({ storeEnabled: true, route, root });
}

afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('1. the nightly keys its record by the revision the gate compares', () => {
    it.each(ROUTES.map((r) => [`${r.model} (${r.dimensions})`, r] as const))('%s: the harness’s revision IS the gate’s', (_name, route) => {
        const gate = gateOver({}, route);
        if (gate.state !== 'UNMOUNTED') throw new Error(`expected the empty tree to leave the gate unmounted, got ${gate.state}`);
        const harness = retrieverRevision(route);
        expect(harness).toEqual(gate.revision);
        expect(retrieverRevisionKey(harness)).toBe(retrieverRevisionKey(gate.revision));
        // The file name the nightly gives the record it uploads.
        expect(ragRetrieverRevisionId(harness)).toBe(ragRetrieverRevisionId(gate.revision));
    });

    it('a passing record the nightly would write opens the gate', () => {
        const harness = retrieverRevision(E5);
        const m = gateOver({ [`${ragRetrieverRevisionId(harness)}.json`]: record(harness) });
        expect(m.state).toBe('MOUNTED');
    });

    it('the probe reads its plans under exactly the settings the revision states, on the index the migration builds', () => {
        const revision = retrieverRevision(E5);
        // What the probe computes from its plans (`runRetrievalProbe`), given every question planned on that index.
        // At the depth the probe calls at: the product's, the revision's k.
        const plans = [{ hnswIndex: MIGRATION_INDEX, maxScanTuples: String(searchSettings(revision.k).maxScanTuples) }];
        const observed = indexParamsFromPlans(plans, searchSettings(revision.k));
        expect(observed).toEqual(revision.indexParams);
        expect(() => assertPlansMatchRevision(revision.indexParams, observed, plans)).not.toThrow();
    });

    it('a record keyed the way the harness keyed it before the wiring is not this deployment’s', () => {
        const revision = retrieverRevision(E5);
        if (revision.indexParams.method !== 'hnsw') throw new Error('the deployment revision is an HNSW search');
        const unwired = { ...revision, k: RECALL_AT, indexParams: { ...revision.indexParams, iterativeScan: 'strict_order' as const } };
        const m = gateOver({ 'unwired.json': record(unwired) });
        expect(m.state === 'UNMOUNTED' && m.reason).toBe('NO_RECORD');
    });
});

describe('2. one set of floors: the gate mounts exactly when the nightly’s reading is met', () => {
    it('the gate holds no floor of its own', () => {
        expect(Object.entries(gateModule).filter(([, v]) => typeof v === 'number')).toEqual([]);
        expect([RECALL_AT_10_VS_EXACT_FLOOR, P95_SEARCH_LATENCY_MS_CEILING]).toEqual([0.95, 300]);
        // The grid below resolves recall to 1/(10 × cases); a constant of the
        // gate's own closer to the floor than that is caught here instead: no
        // figure is compared anywhere but through readRetrievalFloors.
        const src = codeOf(fs.readFileSync(path.join(REPO, 'src/app-layer/services/knowledge-search-mount.ts'), 'utf-8'));
        expect(src).not.toMatch(/(recallAt10VsExact|p95LatencyMs)\s*(\?\?[^<>=!]*)?[<>]/);
    });

    // recall = 1 - missing / (RECALL_AT × cases): the case count at the floor, and one either side.
    const n = SET.cases.length;
    const atFloor = Math.round((1 - RECALL_AT_10_VS_EXACT_FLOOR) * RECALL_AT * n);
    const grid = [atFloor - 1, atFloor, atFloor + 1].flatMap((missing) =>
        [P95_SEARCH_LATENCY_MS_CEILING - 1, P95_SEARCH_LATENCY_MS_CEILING, P95_SEARCH_LATENCY_MS_CEILING + 1].map((latencyMs) => ({ missing, latencyMs })),
    );

    it.each(grid.map((g) => [`${g.missing} case(s) missing a hit, p95 ${g.latencyMs} ms`, g] as const))('%s', (_name, g) => {
        const r = record(retrieverRevision(E5), g);
        const reading = readRetrievalFloors(retrievalFloorFigures(r.cases));
        const m = gateOver({ 'r.json': r });
        expect(m.state === 'MOUNTED').toBe(reading.allMet);
        if (m.state === 'UNMOUNTED') {
            expect(m.reason).toBe(reading.recallAt10VsExact.meets ? 'LATENCY_ABOVE_CEILING' : 'RECALL_BELOW_FLOOR');
        }
    });

    it('the grid straddles both floors', () => {
        const readings = grid.map((g) => readRetrievalFloors(retrievalFloorFigures(record(retrieverRevision(E5), g).cases)));
        expect(new Set(readings.map((r) => r.recallAt10VsExact.meets))).toEqual(new Set([true, false]));
        expect(new Set(readings.map((r) => r.p95LatencyMs.meets))).toEqual(new Set([true, false]));
    });
});

describe('3. the probe issues the product’s own store call', () => {
    const DIMS = 64;
    const route = { model: STUB_EMBEDDING_MODEL, dimensions: DIMS };

    /** The query `searchKnowledge` sends the store for a caller, captured at the store. */
    async function productCall(ctx: ReturnType<typeof makeRequestContext>, k: number): Promise<VectorSearchQuery> {
        const seen: VectorSearchQuery[] = [];
        const vectors = { backend: 'pgvector', search: async (_c: unknown, q: VectorSearchQuery) => (seen.push(q), []) } as unknown as VectorRepository;
        const provider = new StubEmbeddingProvider(DIMS);
        const mount = {
            state: 'MOUNTED' as const,
            revision: retrieverRevision(route),
            record: { file: 'r.json', ranAt: '2026-11-16T00:00:00.000Z' },
            figures: { recallAt10VsExact: 1, recallScored: 1, p95LatencyMs: 1, latencySamples: 1 },
        };
        const r = await searchKnowledge(ctx, { query: 'access reviews', k }, { mount, vectors, embedder: () => ({ ok: true as const, provider }) });
        expect(r.available).toBe(true);
        expect(seen).toHaveLength(1);
        return seen[0];
    }

    it.each([1, 5, 20])('at a caller’s limit of %i, the store is asked the revision’s depth, and the probe asks the same', async (limit) => {
        const reader = makeRequestContext('READER');
        const call = await productCall(reader, limit);
        expect(call.k).toBe(retrieverRevision(route).k);
        expect(call.sourceModels?.length).toBeGreaterThan(0);
        const probe = productQuery(reader, call.embeddingRevision, call.embedding);
        expect(probe).toEqual(call);
        expect(annQuery(probe)).toEqual({ ...call, strategy: 'index' });
    });

    it('the probe’s own context (the index job’s) gets the filter a reader gets', async () => {
        const call = await productCall(makeRequestContext('READER'), 5);
        expect(productQuery(indexContext('probe-tenant'), call.embeddingRevision, call.embedding)).toEqual(call);
    });

    it('the plans are read at the depth the call is made at, under the settings the revision states', () => {
        const call = annQuery(productQuery(makeRequestContext('READER'), STUB_EMBEDDING_MODEL, [1, 0]));
        const revision = retrieverRevision(E5);
        if (revision.indexParams.method !== 'hnsw') throw new Error('the deployment revision is an HNSW search');
        expect(searchSettings(call.k)).toEqual({
            iterativeScan: revision.indexParams.iterativeScan,
            efSearch: revision.indexParams.efSearch,
            maxScanTuples: revision.indexParams.maxScanTuples,
        });
    });
});
