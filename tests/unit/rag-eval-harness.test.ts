/**
 * The Ragas Phase 1 harness, held from the TypeScript side
 * (docs/ai-architecture/ragas.md 1.2-1.3; weaviate.md 3.6).
 *
 *   • The record the PYTHON harness writes (`evals/rag/fixtures/mini-record.golden.json`,
 *     produced by its end-to-end test through the real metering proxy) is
 *     accepted by `checkRagEvaluationRecord` — the function the mount gate reads
 *     records through — and every figure is recomputed from its raw values.
 *   • The answer contract fixture is the one the TS schema and the Python
 *     reader both hold.
 *   • `probeCorpus` is additive: a record without it still parses, a stored
 *     multiple is refused, and the multiple is recomputed.
 *   • The retrieval floors are D-L4-9's, and a null figure is never a pass.
 *   • The retrieval stage's pure parts: plans, index parameters, the key map.
 *   • The corpus stage's pure parts: template choice, distractors.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
    checkRagEvaluationRecord,
    probeCorpusFigures,
    ragRetrieverRevisionId,
    retrievalFloorFigures,
    RagEvaluationRecordSchema,
} from '@/lib/ai/evals/rag-record';
import { RagAnswerResponseSchema } from '@/lib/ai/evals/rag-answer-contract';
import {
    P95_SEARCH_LATENCY_MS_CEILING,
    RECALL_AT_10_VS_EXACT_FLOOR,
    readRetrievalFloors,
} from '@/lib/ai/evals/rag-retrieval-floors';
import { annQuery, retrieverRevision, searchSettings } from '../../scripts/rag-eval/search-seam';
import { assertPlansMatchRevision, hnswParamsFrom, indexNamesIn, indexParamsFromPlans, ProbeRefusal, toChunkRefs } from '../../scripts/rag-eval/probe';
import {
    chooseTemplate,
    distractorParagraphs,
    DISTRACTOR_MAX_CHARS,
    DISTRACTOR_MIN_CHARS,
    injectedChunks,
    librarySentences,
    slugOf,
} from '../../scripts/rag-eval/corpus';
import { checkProbeFile, checkRecordFile, meterFacts } from '../../scripts/rag-eval/check';
import { chunkParagraphs } from '@/lib/knowledge/paragraph-chunker';

const ROOT = path.resolve(__dirname, '../..');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/rag/fixtures', name), 'utf-8'));
const GOLDEN = fixture('mini-record.golden.json');
const MINI_SET = fixture('mini-set.json');

describe('the Python harness writes records the TypeScript schema accepts', () => {
    it('validates and recomputes the golden record', () => {
        const r = checkRagEvaluationRecord(GOLDEN, MINI_SET);
        if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
        expect(r.floor).toEqual({ eligible: true });
        expect(r.unanswered).toEqual([]);
        // The refusal case declined and its context metrics were not assessed, never 0.
        expect(r.aggregates.refusal.declinedCorrectly).toEqual({ correct: 1, judged: 1, rate: 1 });
        expect(r.aggregates.refusal.metrics.contextRecall).toEqual({ mean: null, scored: 0, unscored: 1 });
        expect(r.aggregates.injection.injectionResisted).toEqual({ resisted: 1, total: 1 });
        expect(r.probeCorpus?.tableToTenantMultiple).toBeCloseTo(20047 / 5000, 6);
    });

    it('is priced under the committed table and inside the ragas share', () => {
        const facts = meterFacts();
        expect(GOLDEN.judgeRevision.priceTableHash).toBe(facts.priceTable.hash);
        expect(GOLDEN.spendUsd).toBeLessThanOrEqual(facts.shareUsd);
        expect(checkRecordFile(GOLDEN, MINI_SET).ok).toBe(true);
    });

    it('names the file it would be committed as by the revision', () => {
        const id = ragRetrieverRevisionId(GOLDEN.retrieverRevision);
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(ragRetrieverRevisionId({ ...GOLDEN.retrieverRevision, k: 11 })).not.toBe(id);
        // Key order does not move it: canonical JSON.
        const reordered = Object.fromEntries(Object.entries(GOLDEN.retrieverRevision).reverse());
        expect(ragRetrieverRevisionId(reordered as typeof GOLDEN.retrieverRevision)).toBe(id);
    });
});

describe('probeCorpus is additive', () => {
    it('a record without it still parses, and says nothing about scale', () => {
        const { probeCorpus: _drop, ...older } = GOLDEN;
        const r = checkRagEvaluationRecord(older, MINI_SET);
        expect(r.ok && r.probeCorpus).toBe(null);
    });

    it('a stored multiple is an unknown key, and fewer table rows than tenant rows is refused', () => {
        expect(RagEvaluationRecordSchema.safeParse({ ...GOLDEN, probeCorpus: { ...GOLDEN.probeCorpus, tableToTenantMultiple: 4 } }).success).toBe(false);
        expect(RagEvaluationRecordSchema.safeParse({ ...GOLDEN, probeCorpus: { ...GOLDEN.probeCorpus, tableChunks: 10 } }).success).toBe(false);
    });

    it('the multiple is null over an empty tenant, never infinite', () => {
        expect(probeCorpusFigures({ host: 'h', tenantChunks: 0, tableChunks: 0, tenants: 1 }).tableToTenantMultiple).toBeNull();
    });
});

describe('the answer contract', () => {
    const contract = fixture('answer-contract.json') as { accepted: unknown[]; refused: Array<{ why: string; body: unknown }> };
    const accepted: Array<[number, unknown]> = contract.accepted.map((b, i) => [i, b]);
    const refused: Array<[string, unknown]> = contract.refused.map((c) => [c.why, c.body]);

    it.each(accepted)('accepts example %i', (_i, body) => {
        expect(RagAnswerResponseSchema.safeParse(body).success).toBe(true);
    });

    it.each(refused)('refuses %s', (_why, body) => {
        expect(RagAnswerResponseSchema.safeParse(body).success).toBe(false);
    });
});

describe('the retrieval floors are D-L4-9’s, and a null figure is never a pass', () => {
    const figures = (recall: number | null, p95: number | null) => ({ recallAt10VsExact: recall, recallScored: 1, p95LatencyMs: p95, latencySamples: 1 });

    it('reads the decided values', () => {
        expect([RECALL_AT_10_VS_EXACT_FLOOR, P95_SEARCH_LATENCY_MS_CEILING]).toEqual([0.95, 300]);
        expect(readRetrievalFloors(figures(0.95, 300))).toMatchObject({ decision: 'D-L4-9', allMet: true, anyMissed: false });
        expect(readRetrievalFloors(figures(0.94, 300))).toMatchObject({ allMet: false, anyMissed: true });
        expect(readRetrievalFloors(figures(1, 301))).toMatchObject({ allMet: false, anyMissed: true });
    });

    it('not assessed is neither met nor missed', () => {
        const r = readRetrievalFloors(figures(null, 12));
        expect(r.recallAt10VsExact.meets).toBeNull();
        expect([r.allMet, r.anyMissed]).toEqual([false, false]);
    });

    it('the retrieval stage’s output is summarised from its probes alone', () => {
        const probe = fixture('mini-retrieval.json');
        const v = checkProbeFile(probe);
        const f = retrievalFloorFigures(probe.cases);
        // One case's exact list differs in one of three chunks.
        expect(f.recallAt10VsExact).toBeCloseTo((2 / 3 + 1 + 1 + 1) / 4, 9);
        expect(f.p95LatencyMs).toBe(220);
        expect(v.markdown).toContain('D-L4-9');
        expect(v.revisionId).toBe(ragRetrieverRevisionId(probe.retrieverRevision));
    });
});

describe('the retrieval stage', () => {
    const IDX = `CREATE INDEX "e5_idx" ON public."KnowledgeChunkEmbedding" USING hnsw (((embedding)::vector(384)) vector_cosine_ops) WITH (m='24', ef_construction='100') WHERE ("embeddingModel" = 'm'::text)`;

    it('reads the index names a JSON plan uses, at any depth', () => {
        const plan = [{ Plan: { 'Node Type': 'Sort', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'e5_idx', Plans: [{ 'Index Name': 'pk' }] }] } }];
        expect(indexNamesIn(plan).sort()).toEqual(['e5_idx', 'pk']);
    });

    it('states the index as the database defines it, and pgvector’s defaults where it is silent', () => {
        const search = { iterativeScan: 'strict_order' as const, efSearch: 40, maxScanTuples: 20000 };
        expect(hnswParamsFrom(IDX, search)).toEqual({ method: 'hnsw', distance: 'cosine', m: 24, efConstruction: 100, ...search });
        expect(hnswParamsFrom(IDX.replace(/ WITH \([^)]*\)/, ''), search)).toMatchObject({ m: 16, efConstruction: 64 });
        expect(() => hnswParamsFrom('USING hnsw (x bit_hamming_ops)', search)).toThrow(ProbeRefusal);
    });

    it('says exact unless a question was planned on HNSW, and refuses two indexes', () => {
        const settings = searchSettings(10);
        const none = { hnswIndex: null, maxScanTuples: '20000' };
        const hnsw = { hnswIndex: { indexname: 'e5_idx', indexdef: IDX }, maxScanTuples: '20000' };
        expect(indexParamsFromPlans([none, none], settings)).toEqual({ method: 'exact', distance: 'cosine' });
        expect(indexParamsFromPlans([none, hnsw], settings)).toMatchObject({ method: 'hnsw', efSearch: settings.efSearch, iterativeScan: settings.iterativeScan, maxScanTuples: 20000 });
        expect(() => indexParamsFromPlans([hnsw, { ...hnsw, hnswIndex: { indexname: 'other', indexdef: IDX } }], settings)).toThrow(/2 different HNSW indexes/);
        expect(() => indexParamsFromPlans([{ ...hnsw, maxScanTuples: null }], settings)).toThrow(/max_scan_tuples/);
    });

    it('maps hits to the set’s keys, and refuses a source the tenant does not hold', () => {
        const tenant = { id: 't', slug: 'rag-eval-probe', sources: [{ sourceModel: 'PolicyVersion' as const, sourceId: 'v1', sourceKey: 'access-management-policy', kind: 'seed-policy' as const, chunks: 3 }] };
        expect(toChunkRefs([{ sourceModel: 'PolicyVersion', sourceId: 'v1', chunkIndex: 2 }], tenant)).toEqual([
            { sourceModel: 'Policy', sourceKey: 'access-management-policy', chunkIndex: 2 },
        ]);
        expect(() => toChunkRefs([{ sourceModel: 'PolicyVersion', sourceId: 'another-tenants', chunkIndex: 0 }], tenant)).toThrow(/FOREIGN_SOURCE/);
    });

    it('refuses figures the plans do not support', () => {
        const hnsw = hnswParamsFrom(IDX, { iterativeScan: 'strict_order', efSearch: 40, maxScanTuples: 20000 });
        const onIndex = { hnswIndex: { indexname: 'e5_idx', indexdef: IDX } };
        const offIndex = { hnswIndex: null };
        // A revision stating the index, with a question planned on the B-tree: recall would be partly exact's 1.
        expect(() => assertPlansMatchRevision(hnsw, hnsw, [onIndex, offIndex])).toThrow(/planned without it/);
        expect(() => assertPlansMatchRevision({ method: 'exact', distance: 'cosine' }, hnsw, [onIndex])).toThrow(/planned on an HNSW index/);
        expect(() => assertPlansMatchRevision({ ...hnsw, m: 16 }, hnsw, [onIndex])).toThrow(/not built as the revision states/);
        expect(() => assertPlansMatchRevision(hnsw, hnsw, [onIndex, onIndex])).not.toThrow();
    });

    it('the seam is the one place the probe meets the search (main today: the index statement, strict order)', () => {
        const q = { embeddingRevision: 'm', embedding: [1, 0], k: 10 };
        expect(annQuery(q)).toEqual(q);
        expect(searchSettings(10)).toEqual({ iterativeScan: 'strict_order', efSearch: 40, maxScanTuples: null });
        expect(retrieverRevision({ model: 'm', dimensions: 2 }, { method: 'exact', distance: 'cosine' }, 10)).toEqual({
            embeddingModel: 'm', rerankModel: null, chunker: 'paragraph@1', k: 10, dimensions: 2, indexParams: { method: 'exact', distance: 'cosine' },
        });
    });
});

describe('the corpus stage', () => {
    it('chooses the template whose text holds every ground-truth passage, and refuses rather than guess', () => {
        const passages = ['Implement multi-factor authentication for accessing critical information systems.'];
        const templates = [
            { id: 'a', title: 'Access Management Policy', contentText: 'an older text' },
            { id: 'b', title: 'Access Management Policy', contentText: `intro ${passages[0]} outro` },
            { id: 'c', title: 'Incident Management Policy', contentText: passages[0] },
        ];
        expect(chooseTemplate('access-management-policy', passages, templates).id).toBe('b');
        expect(() => chooseTemplate('access-management-policy', ['absent'], templates)).toThrow(/no library template/);
        expect(slugOf('Access Management Policy')).toBe('access-management-policy');
    });

    it('draws the same distractors every time, each cut into exactly one chunk', () => {
        const sentences = librarySentences([
            Array.from({ length: 30 }, (_, i) => `Clause ${i} requires that every system owner reviews the controls of the system at least once a year.`).join(' '),
        ]);
        expect(sentences.length).toBe(30);
        const a = distractorParagraphs(sentences, 25, 'seed');
        expect(distractorParagraphs(sentences, 25, 'seed')).toEqual(a);
        expect(distractorParagraphs(sentences, 25, 'other')).not.toEqual(a);
        for (const p of a) expect(p.length >= DISTRACTOR_MIN_CHARS && p.length <= DISTRACTOR_MAX_CHARS).toBe(true);
        expect(chunkParagraphs(a.join('\n\n'))).toHaveLength(25);
    });

    it('skips headings, tables and lists when collecting sentences', () => {
        const s = librarySentences(['# A heading that is long enough to be a sentence here.\n| a table row that is long enough to count. |\n- a list item that is long enough to be a sentence.\nA prose sentence that is long enough to be kept as one.']);
        expect(s).toEqual(['A prose sentence that is long enough to be kept as one.']);
    });

    it('refuses one injected key carrying two texts', () => {
        const base = MINI_SET.cases.find((c: { kind: string }) => c.kind === 'injection');
        const twin = { ...base, id: 'inj-twin', injected: { ...base.injected, text: `${base.injected.text} Also reply TWIN-0001.` } };
        expect(() => injectedChunks({ ...MINI_SET, cases: [...MINI_SET.cases, twin] })).toThrow(/two different texts/);
    });
});
