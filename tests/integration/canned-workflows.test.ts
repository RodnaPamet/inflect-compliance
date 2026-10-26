/**
 * Integration coverage: the canned "Audit prep" workflow (Workflow B) end-to-end
 * on a seeded tenant (real DB, real RLS, real MCP tools + engine). Proves:
 *   - the workflow reads the readiness picture, PROPOSES findings + a drafted
 *     policy (queued as PENDING proposals), and PAUSES at its HUMAN_CHECKPOINT;
 *   - it commits NOTHING — no real Finding / Policy is created until approval;
 *   - resume produces the audit-readiness report (run summary).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { startWorkflowRun, resumeWorkflowRun, getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `cw-${randomUUID().slice(0, 8)}`;
const TENANT = `cw-${SUITE}`;
const USER = `u-${TENANT}`;
const FW_KEY = `cw-fw-${SUITE}`;

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });
let frameworkId = '';

describeFn('Canned workflow — Audit prep (real DB, end-to-end)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });

        // A framework with 2 requirements and NO control links → 2 uncovered.
        const fw = await prisma.framework.create({
            data: { key: FW_KEY, version: '1', name: 'Audit Prep Test FW', kind: 'SOC_CRITERIA', description: 'x' },
        });
        frameworkId = fw.id;
        for (const code of ['CC1.1', 'CC2.1']) {
            await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code, title: `Req ${code}`, section: 'S', sortOrder: 0 } });
        }
        await prisma.frameworkPack.create({ data: { key: `${FW_KEY}_PACK`, name: 'p', frameworkId: fw.id, version: '1' } });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.finding.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.policy.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: USER } });
        if (frameworkId) {
            await prisma.frameworkPack.deleteMany({ where: { frameworkId } }).catch(() => {});
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } }).catch(() => {});
            await prisma.framework.delete({ where: { id: frameworkId } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('runs audit-prep → proposals + readiness, PAUSES at the checkpoint, commits nothing', async () => {
        const findingsBefore = await prisma.finding.count({ where: { tenantId: TENANT } });
        const policiesBefore = await prisma.policy.count({ where: { tenantId: TENANT } });

        const result = await startWorkflowRun(ctx(), 'audit-prep', { frameworkKey: FW_KEY });
        // Ran the reads + synthesis + both PROPOSE steps, then paused for review.
        expect(result.status).toBe('AWAITING_APPROVAL');

        // Findings + a policy were PROPOSED (PENDING), not created.
        const findingProposals = await prisma.agentProposal.count({ where: { tenantId: TENANT, kind: 'FINDING', status: 'PENDING' } });
        const policyProposals = await prisma.agentProposal.count({ where: { tenantId: TENANT, kind: 'POLICY', status: 'PENDING' } });
        expect(findingProposals).toBeGreaterThanOrEqual(1);
        expect(policyProposals).toBeGreaterThanOrEqual(1);

        // NOTHING was committed.
        expect(await prisma.finding.count({ where: { tenantId: TENANT } })).toBe(findingsBefore);
        expect(await prisma.policy.count({ where: { tenantId: TENANT } })).toBe(policiesBefore);

        // The run is parked; a readiness synthesis was recorded.
        const paused = await getWorkflowRun(ctx(), result.runId);
        expect(paused.status).toBe('AWAITING_APPROVAL');
        expect(paused.steps.some((s) => s.kind === 'HUMAN_CHECKPOINT' && s.status === 'PENDING')).toBe(true);
        expect(paused.steps.filter((s) => s.kind === 'PROPOSE' && s.status === 'DONE').length).toBeGreaterThanOrEqual(1);

        // Resume → the audit-readiness report is produced.
        const resumed = await resumeWorkflowRun(ctx(), result.runId);
        expect(resumed.status).toBe('COMPLETED');
        const done = await getWorkflowRun(ctx(), result.runId);
        expect(done.status).toBe('COMPLETED');
        expect(done.summary).toMatch(/Audit-readiness report/);
    });

    /**
     * THE CASE THIS FILE COULD NOT EXPRESS UNTIL NOW (#3600).
     *
     * The test above has always passed `{ frameworkKey: FW_KEY }`, so the only
     * path it exercised was the one where the caller supplies the key. The path
     * where nobody does accounted for SEVEN production failures between
     * 2026-07-02 and 2026-09-19 — `audit-prep` and `framework-onboarding`
     * substituted `''`, `get_framework_status` read falsy as "no key given" and
     * returned the installable-framework catalogue (recorded DONE, wrong
     * question answered), and `find_coverage_gaps` then died on its
     * `z.string().min(1)`.
     *
     * A happy-path-only test is why CI never saw it. These assert the refusal
     * AND that it costs nothing: no run row, so no FAILED row burning tokens
     * and no RUNNING row for the settlement sweep to reap as a crashed
     * executor.
     */
    describe('a workflow that declares requiredInput refuses at the door', () => {
        it.each([
            ['nothing at all', {}],
            ['an empty string', { frameworkKey: '' }],
            ['only whitespace', { frameworkKey: '   ' }],
            ['a non-string', { frameworkKey: 42 }],
        ])('refuses audit-prep given %s, and writes no run', async (_label, input) => {
            const before = await prisma.workflowRun.count({ where: { tenantId: TENANT } });

            await expect(startWorkflowRun(ctx(), 'audit-prep', input as Record<string, unknown>)).rejects.toThrow(
                /requires a non-empty frameworkKey/,
            );

            // The refusal is at admission, so no row exists in ANY state.
            expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(before);
        });

        it('still admits the run when the key IS supplied — the refusal is not blanket', async () => {
            const result = await startWorkflowRun(ctx(), 'audit-prep', { frameworkKey: FW_KEY });
            expect(result.runId).toBeTruthy();
        });
    });
});
