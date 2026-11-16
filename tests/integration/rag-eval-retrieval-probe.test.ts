/**
 * The Ragas nightly's corpus and retrieval stages against a real database
 * (Ragas Phase 1; vector store Phase 3.6), with the deterministic stub
 * embedder in place of TEI.
 *
 *   1. The corpus is built through the product: three tenants (answer, probe,
 *      one filler), approved policies, the index job — and the probe tenant
 *      holds the stated size, the index the stated multiple.
 *   2. Every ANN and exact hit maps to one of the PROBE tenant's own sources:
 *      no other tenant's chunk ever reaches the probe (a hit on any other is
 *      refused, FOREIGN_SOURCE, and fails this test).
 *   3. The plans are read, not assumed: the stub model has no HNSW index, so
 *      every question — the product's 20-deep call, asked on the index path,
 *      `strategy: 'index'` — is planned exactly, and recall@10 of its first
 *      10 against the stage's own exact top 10 is measured.
 *   4. A record is keyed by the revision the `search_knowledge` mount gate
 *      compares (`knowledgeRetrieverRevision`), which states the HNSW index,
 *      so measurements whose questions were planned exactly cannot become
 *      one: the probe refuses them (PLANS_DISAGREE_WITH_REVISION) rather than
 *      let an exact scan's 1 stand for the index's recall. (Which plan the
 *      planner picks for a corpus this small depends on the table's
 *      statistics, so the suite does not try to force the indexed path; the
 *      nightly's 5,000-chunk probe tenant is planned on the index.)
 *   5. The measurements are a valid retrieval half of a record under that
 *      revision: probes and revision pass `RagEvaluationRecordSchema`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { checkRagEvaluationSet, ragSetHash, RagEvaluationRecordSchema, retrievalFloorFigures } from '@/lib/ai/evals/rag-record';
import { knowledgeRetrieverRevision } from '@/app-layer/services/knowledge-search-revision';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { prepareRagEvalCorpus, type CorpusManifest } from '../../scripts/rag-eval/corpus';
import { measureRetrieval, ProbeRefusal, runRetrievalProbe } from '../../scripts/rag-eval/probe';
import { embedderDeps } from '../../scripts/rag-eval/shared';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(300_000);

const ROOT = path.resolve(__dirname, '../..');
const SUITE = `rp${randomUUID().slice(0, 6)}-`;
const setCheck = checkRagEvaluationSet(JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/rag/fixtures/mini-set.json'), 'utf-8')));
if (!setCheck.ok) throw new Error(setCheck.detail);
const SET = setCheck.set;

/** A library holding the set's passages under the seed title, and prose to draw distractors from. */
const TEMPLATE_TITLES = ['Access Management Policy', `Distractor library ${SUITE}`];
const templateIds: string[] = [];

describeFn('the Ragas retrieval stage against pgvector under RLS', () => {
    let manifest: CorpusManifest;
    let measured: Awaited<ReturnType<typeof measureRetrieval>>;
    let probed: unknown;

    beforeAll(async () => {
        const passages = SET.cases.flatMap((c) => c.groundTruth.refs.map((r) => r.passage));
        const prose = Array.from({ length: 40 }, (_, i) =>
            `Requirement ${i} of the operating procedures states that each owner records the review of controls for that period.`,
        ).join(' ');
        for (const [title, contentText] of [
            [TEMPLATE_TITLES[0], `# Access Management Policy\n\n${passages.join('\n\n')}`],
            [TEMPLATE_TITLES[1], prose],
        ]) {
            const t = await prisma.policyTemplate.create({ data: { title, contentText, contentType: 'MARKDOWN', source: SUITE } });
            templateIds.push(t.id);
        }
        const deps = embedderDeps('stub', 384);
        manifest = await prepareRagEvalCorpus({ set: SET, probeTenantChunks: 120, scaleMultiple: 2, deps, slugPrefix: SUITE });
        measured = await measureRetrieval({ set: SET, manifest, host: 'integration-test', deps });
        probed = await runRetrievalProbe({ set: SET, manifest, host: 'integration-test', deps }).catch((e: unknown) => e);
    });

    afterAll(async () => {
        const tenants = await prisma.tenant.findMany({ where: { slug: { startsWith: SUITE } }, select: { id: true, slug: true } });
        const ids = tenants.map((t) => t.id);
        for (const id of ids) {
            await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
            await purgeSoftDeletedTenants({ tenantId: id });
        }
        await deleteAuditRowsForTenants(prisma, ids).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
        // The corpus stage's people, by the lookup hash of the addresses it gives them.
        const hashes = tenants.flatMap((t) => ['owner', 'approver'].map((who) => hashForLookup(`${who}@${t.slug}.rag-eval.test`)));
        await prisma.user.deleteMany({ where: { emailHash: { in: hashes } } });
        await prisma.policyTemplate.deleteMany({ where: { id: { in: templateIds } } });
        await prisma.$disconnect();
    });

    it('builds the stated corpus through the product', () => {
        const probeChunks = manifest.probeTenant.sources.reduce((s, x) => s + x.chunks, 0);
        expect(probeChunks).toBeGreaterThanOrEqual(120);
        expect(manifest.answerTenant.sources.map((s) => s.kind).sort()).toEqual(['injected', 'seed-policy']);
        expect(manifest.probeTenant.sources.some((s) => s.kind === 'distractor')).toBe(true);
        expect(manifest.fillerTenants).toHaveLength(1);
        expect(measured.probeCorpus.tenantChunks).toBe(probeChunks);
        expect(measured.probeCorpus.tableChunks).toBeGreaterThanOrEqual(2 * probeChunks);
        expect(measured.probeCorpus.tenants).toBeGreaterThanOrEqual(3);
    });

    it('every hit is the probe tenant’s own, at depth 10', () => {
        const keys = new Set(manifest.probeTenant.sources.map((s) => s.sourceKey));
        for (const c of measured.cases) {
            expect(c.retrievalProbe.exact).toHaveLength(10);
            // The product's 20-deep call, its first 10 kept.
            expect(c.retrievalProbe.ann).toHaveLength(10);
            for (const hit of [...c.retrievalProbe.ann, ...c.retrievalProbe.exact]) expect(keys.has(hit.sourceKey)).toBe(true);
        }
    });

    it('reads the plan the store ran: exact for a model with no HNSW index, and measures recall over every question', () => {
        expect(measured.model).toBe('stub-feature-hash@1');
        expect(measured.plans.filter((p) => p.hnswIndex)).toHaveLength(0);
        expect(measured.plans).toHaveLength(SET.cases.length);
        // Both arms are exact here, but recall is not 1 by construction: the
        // ANN arm keeps the first 10 of the product's 20-deep call, and the
        // stub's feature-hash vectors tie (same words, same vector), so a tie
        // across the 10th place can be filled by different chunks at depth 20
        // and at depth 10. Measured, never assumed.
        const figures = retrievalFloorFigures(measured.cases);
        expect(figures).toMatchObject({ recallScored: SET.cases.length, latencySamples: SET.cases.length });
        expect(figures.recallAt10VsExact).not.toBeNull();
        expect(figures.recallAt10VsExact).toBeGreaterThan(0.5);
    });

    it('refuses to key exact plans by the gate’s revision, which states the index', () => {
        expect(knowledgeRetrieverRevision({ model: measured.model, dimensions: measured.dims }).indexParams.method).toBe('hnsw');
        expect(probed).toBeInstanceOf(ProbeRefusal);
        expect((probed as ProbeRefusal).reason).toBe('PLANS_DISAGREE_WITH_REVISION');
    });

    it('is the retrieval half of a valid record', () => {
        const record = {
            setHash: ragSetHash(SET),
            corpus: 'seed',
            retrieverRevision: knowledgeRetrieverRevision({ model: measured.model, dimensions: measured.dims }),
            judgeRevision: { provider: 'anthropic', model: 'claude-haiku-4-5', embeddingModel: 'm', ragasVersion: '0.4.3', priceTableHash: `sha256:${'0'.repeat(64)}` },
            ranAt: new Date().toISOString(),
            status: 'BUDGET_EXHAUSTED',
            spendUsd: 0,
            probeCorpus: measured.probeCorpus,
            cases: [],
        };
        expect(RagEvaluationRecordSchema.safeParse(record).success).toBe(true);
        for (const c of measured.cases) expect(RagEvaluationRecordSchema.shape.cases.element.shape.retrievalProbe.safeParse(c.retrievalProbe).success).toBe(true);
    });
});
