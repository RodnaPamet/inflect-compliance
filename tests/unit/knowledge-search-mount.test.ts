/**
 * The `search_knowledge` mount gate (vector store Phase 3.5): offered only when
 * the newest committed RAG evaluation record for THIS deployment's retriever
 * revision checks, answers an authored set, ran within budget, and its
 * recomputed retrieval figures clear D-L4-9's floors.
 *
 * Each case writes a tiny `evals/` tree under a temporary root, with the set
 * and cost meter copied from the repository's own, so the gate reads the
 * format Ragas Phase 0 defined and nothing invented here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { resolveKnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';
import { knowledgeRetrieverRevision } from '@/app-layer/services/knowledge-search-revision';
import { ragSetHash, RagEvaluationSetSchema, type RagEvaluationSet } from '@/lib/ai/evals/rag-record';
import { P95_SEARCH_LATENCY_MS_CEILING, RECALL_AT_10_VS_EXACT_FLOOR } from '@/lib/ai/evals/rag-retrieval-floors';

const REPO = path.resolve(__dirname, '../..');
const ROUTE = { model: 'intfloat/multilingual-e5-small', dimensions: 384 };
const SET_RAW = JSON.parse(fs.readFileSync(path.join(REPO, 'evals/rag/sets/seed-policies.json'), 'utf-8')) as unknown;
const SET: RagEvaluationSet = RagEvaluationSetSchema.parse(SET_RAW);
const PRICES = fs.readFileSync(path.join(REPO, 'evals/cost-meter/prices.json'));
const PRICE_HASH = `sha256:${createHash('sha256').update(PRICES).digest('hex')}`;

const chunk = (i: number) => ({ sourceModel: 'Policy', sourceKey: 'access-management-policy', chunkIndex: i });
const TOP = Array.from({ length: 10 }, (_, i) => chunk(i));

/** A COMPLETE record answering every case of the seed set, for `revision`, with each probe as given. */
function record(opts: { revision?: unknown; ranAt?: string; recallMiss?: number; latencyMs?: number; status?: string; spendUsd?: number } = {}) {
    const ann = TOP.slice(0, 10 - (opts.recallMiss ?? 0)).concat(Array.from({ length: opts.recallMiss ?? 0 }, (_, i) => chunk(100 + i)));
    return {
        setHash: ragSetHash(SET),
        corpus: 'seed',
        retrieverRevision: opts.revision ?? knowledgeRetrieverRevision(ROUTE),
        judgeRevision: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            embeddingModel: 'judge-embed',
            ragasVersion: '0.2.0',
            priceTableHash: PRICE_HASH,
        },
        ranAt: opts.ranAt ?? '2026-11-16T01:00:00.000Z',
        status: opts.status ?? 'COMPLETE',
        spendUsd: opts.spendUsd ?? 0.4,
        cases: SET.cases.map((c) => ({
            caseId: c.id,
            answer: 'an answer',
            retrieved: [],
            retrievalProbe: { ann, exact: TOP, latencyMs: opts.latencyMs ?? 40 },
            metrics: { faithfulness: 1, answerRelevancy: 1, contextPrecision: 1, contextRecall: 1 },
            abstained: false,
            judgeOutputs: [],
        })),
    };
}

let root: string;
function tree(records: Record<string, unknown>, set: unknown = SET_RAW): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mount-'));
    fs.mkdirSync(path.join(root, 'evals/rag/records'), { recursive: true });
    fs.mkdirSync(path.join(root, 'evals/rag/sets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'evals/cost-meter'), { recursive: true });
    fs.writeFileSync(path.join(root, 'evals/rag/sets/seed-policies.json'), JSON.stringify(set));
    fs.copyFileSync(path.join(REPO, 'evals/cost-meter/prices.json'), path.join(root, 'evals/cost-meter/prices.json'));
    fs.copyFileSync(path.join(REPO, 'evals/cost-meter/shares.json'), path.join(root, 'evals/cost-meter/shares.json'));
    for (const [file, body] of Object.entries(records)) {
        fs.writeFileSync(path.join(root, 'evals/rag/records', file), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return root;
}

afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

const resolve = (records: Record<string, unknown>, set?: unknown) =>
    resolveKnowledgeSearchMount({ storeEnabled: true, route: ROUTE, root: tree(records, set) });
const refusal = (m: ReturnType<typeof resolveKnowledgeSearchMount>) => (m.state === 'UNMOUNTED' ? m.reason : m.state);

describe('search_knowledge is offered only with a passing record for the current retriever revision', () => {
    it('nothing is read while the store is off or no embedding route is configured', () => {
        expect(resolveKnowledgeSearchMount({ storeEnabled: false, route: ROUTE, root: '/nonexistent' })).toEqual({
            state: 'ABSENT',
            reason: 'VECTOR_STORE_DISABLED',
        });
        expect(resolveKnowledgeSearchMount({ storeEnabled: true, route: null, root: '/nonexistent' })).toEqual({
            state: 'ABSENT',
            reason: 'EMBEDDING_NOT_CONFIGURED',
        });
    });

    it('refuses with no record at all', () => {
        expect(refusal(resolve({}))).toBe('NO_RECORD');
    });

    it('refuses a record for another revision — another model, another k, another index setting', () => {
        const other = knowledgeRetrieverRevision({ model: 'BAAI/bge-m3', dimensions: 1024 });
        const m = resolve({
            'a.json': record({ revision: other }),
            'b.json': record({ revision: { ...knowledgeRetrieverRevision(ROUTE), k: 10 } }),
            'c.json': record({
                revision: { ...knowledgeRetrieverRevision(ROUTE), indexParams: { method: 'exact', distance: 'cosine' } },
            }),
        });
        expect(refusal(m)).toBe('NO_RECORD');
        expect(m.state === 'UNMOUNTED' && m.detail).toContain('3 record(s) are for other revisions');
    });

    it('mounts on a passing record, whatever the file is called', () => {
        const m = resolve({ 'whatever-name.json': record() });
        expect(m.state).toBe('MOUNTED');
        expect(m.state === 'MOUNTED' && m.figures).toMatchObject({ recallAt10VsExact: 1, p95LatencyMs: 40 });
    });

    it('holds D-L4-9’s floors: recall@10 below 0.95 of exact, or p95 above 300 ms, refuses', () => {
        expect(RECALL_AT_10_VS_EXACT_FLOOR).toBe(0.95);
        expect(P95_SEARCH_LATENCY_MS_CEILING).toBe(300);
        expect(refusal(resolve({ 'r.json': record({ recallMiss: 1 }) }))).toBe('RECALL_BELOW_FLOOR');
        expect(refusal(resolve({ 'r.json': record({ latencyMs: 301 }) }))).toBe('LATENCY_ABOVE_CEILING');
        expect(resolve({ 'r.json': record({ latencyMs: 300 }) }).state).toBe('MOUNTED');
    });

    it('a run the budget stopped never opens the gate', () => {
        expect(refusal(resolve({ 'r.json': record({ status: 'BUDGET_EXHAUSTED' }) }))).toBe('BUDGET_EXHAUSTED');
    });

    it('a record over the Ragas share, or priced under another table, is refused by the record check', () => {
        expect(refusal(resolve({ 'r.json': record({ spendUsd: 2.51 }) }))).toBe('SPEND_OVER_SHARE');
        const reprice = record();
        reprice.judgeRevision.priceTableHash = `sha256:${'b'.repeat(64)}`;
        expect(refusal(resolve({ 'r.json': reprice }))).toBe('PRICE_TABLE_MISMATCH');
    });

    it('the newest record decides: a newer failure is not covered by an older pass', () => {
        const m = resolve({
            'old.json': record({ ranAt: '2026-11-15T01:00:00.000Z' }),
            'new.json': record({ ranAt: '2026-11-16T01:00:00.000Z', recallMiss: 2 }),
        });
        expect(refusal(m)).toBe('RECALL_BELOW_FLOOR');
    });

    it('a malformed record refuses rather than being skipped', () => {
        expect(refusal(resolve({ 'good.json': record(), 'bad.json': { ...record(), retrievalFloors: { recall: 1 } } }))).toBe(
            'MALFORMED_RECORD',
        );
        expect(refusal(resolve({ 'good.json': record(), 'broken.json': '{ not json' }))).toBe('RECORDS_UNREADABLE');
    });

    it('refuses a record whose set is not committed, and one answering a synthetic set', () => {
        const otherSet = { ...SET, version: 'other' };
        expect(refusal(resolve({ 'r.json': record() }, otherSet))).toBe('NO_SET');
        const synthetic = { ...SET, provenance: 'synthetic' };
        const r = { ...record(), setHash: ragSetHash(synthetic as RagEvaluationSet) };
        expect(refusal(resolve({ 'r.json': r }, synthetic))).toBe('SET_NOT_AUTHORED');
    });

    it('the repository as committed is readable by the gate: its records, sets and cost meter all parse', () => {
        // Whether the committed records open the gate is the records' business;
        // that the gate can READ them is this suite's. A record committed in a
        // shape the gate cannot place would otherwise close the tool silently.
        const m = resolveKnowledgeSearchMount({ storeEnabled: true, route: ROUTE, root: REPO });
        expect(['MALFORMED_RECORD', 'RECORDS_UNREADABLE', 'NO_SET', 'COST_METER_UNREADABLE']).not.toContain(refusal(m));
    });
});
