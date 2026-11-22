/**
 * Two resumes of one paused run execute its remaining steps ONCE (#5119).
 *
 * `resumeWorkflowRun` checked the status with a read and then wrote RUNNING
 * unconditionally, so two approvers clicking at once both passed the check,
 * both moved the run, and both executed the rest of it — duplicate tool calls
 * and duplicate proposals. The transition is now a conditional claim from the
 * paused states: one resume wins, the other is refused before it touches the
 * checkpoint or the decision log. Against a real database, raced for real.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { resumeWorkflowRun, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `resume-once-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const CHECKPOINT_WF = `resume-once-wf-${SUITE}`;

const person = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

describeFn('a paused run resumes once (#5119)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${USER}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });
        registerWorkflow({
            key: CHECKPOINT_WF,
            name: 'checkpoint then synthesis',
            description: 'parks at a human checkpoint, then summarises',
            steps: [
                { kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'resumed' }) },
            ],
        });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { run: { tenantId: TENANT } } });
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
        await deleteAuditRowsForTenants(prisma, [TENANT]);
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    it('two concurrent resumes: one completes the run, the other is refused 409, and the rest runs once', async () => {
        const started = await startWorkflowRun(person(), CHECKPOINT_WF, {});
        expect(started.status).toBe('AWAITING_APPROVAL');

        const outcomes = await Promise.allSettled([
            resumeWorkflowRun(person(), started.runId),
            resumeWorkflowRun(person(), started.runId),
        ]);

        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as { status?: number }).status).toBe(409);

        // The remaining step executed ONCE.
        const summaries = await prisma.workflowStep.count({
            where: { runId: started.runId, kind: 'SYNTHESIS' },
        });
        expect(summaries).toBe(1);
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.runId }, select: { status: true } });
        expect(run.status).toBe('COMPLETED');
    });

    it('a run that is not paused is refused, not re-run', async () => {
        const started = await startWorkflowRun(person(), CHECKPOINT_WF, {});
        await resumeWorkflowRun(person(), started.runId);

        const err = (await resumeWorkflowRun(person(), started.runId).catch((e: unknown) => e)) as { status?: number };
        // The status read refuses a COMPLETED run with 400 before the claim.
        expect(err.status).toBe(400);
    });
});
