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
 *   3. The record's revision says what the store ran: the stub model has no
 *      HNSW index, so every question is planned exactly and recall@10 against
 *      the stage's own exact scan is 1 — measured, not assumed.
 *   4. The output is a valid retrieval half of a record: its probes and
 *      revision pass `RagEvaluationRecordSchema`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { checkRagEvaluationSet, RagEvaluationRecordSchema, retrievalFloorFigures } from '@/lib/ai/evals/rag-record';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { prepareRagEvalCorpus, type CorpusManifest } from '../../scripts/rag-eval/corpus';
import { runRetrievalProbe, type ProbeOutput } from '../../scripts/rag-eval/probe';
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
    let output: ProbeOutput;

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
        output = await runRetrievalProbe({ set: SET, manifest, k: 10, host: 'integration-test', deps });
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
        expect(output.probeCorpus.tenantChunks).toBe(probeChunks);
        expect(output.probeCorpus.tableChunks).toBeGreaterThanOrEqual(2 * probeChunks);
        expect(output.probeCorpus.tenants).toBeGreaterThanOrEqual(3);
    });

    it('every hit is the probe tenant’s own, at depth 10', () => {
        const keys = new Set(manifest.probeTenant.sources.map((s) => s.sourceKey));
        for (const c of output.cases) {
            expect(c.retrievalProbe.exact).toHaveLength(10);
            for (const hit of [...c.retrievalProbe.ann, ...c.retrievalProbe.exact]) expect(keys.has(hit.sourceKey)).toBe(true);
        }
    });

    it('states the plan the store ran: exact for a model with no HNSW index, and recall is measured as 1', () => {
        expect(output.retrieverRevision).toMatchObject({ embeddingModel: 'stub-feature-hash@1', dimensions: 384, k: 10, rerankModel: null, chunker: 'paragraph@1' });
        expect(output.retrieverRevision.indexParams).toEqual({ method: 'exact', distance: 'cosine' });
        expect(output.annPlans).toEqual({ hnsw: 0, other: SET.cases.length });
        expect(retrievalFloorFigures(output.cases)).toMatchObject({ recallAt10VsExact: 1, recallScored: SET.cases.length, latencySamples: SET.cases.length });
    });

    it('is the retrieval half of a valid record', () => {
        const record = {
            setHash: output.setHash,
            corpus: 'seed',
            retrieverRevision: output.retrieverRevision,
            judgeRevision: { provider: 'anthropic', model: 'claude-haiku-4-5', embeddingModel: 'm', ragasVersion: '0.4.3', priceTableHash: `sha256:${'0'.repeat(64)}` },
            ranAt: output.ranAt,
            status: 'BUDGET_EXHAUSTED',
            spendUsd: 0,
            probeCorpus: output.probeCorpus,
            cases: [],
        };
        expect(RagEvaluationRecordSchema.safeParse(record).success).toBe(true);
        for (const c of output.cases) expect(RagEvaluationRecordSchema.shape.cases.element.shape.retrievalProbe.safeParse(c.retrievalProbe).success).toBe(true);
    });
});
