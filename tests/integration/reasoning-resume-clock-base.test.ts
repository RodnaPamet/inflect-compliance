/**
 * A PERSON'S RESUME OF A REASONING RUN MEASURES ITS CLOCK FROM THE RESUME (#5534).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * `resumeWorkflowRun` re-bases the engine clock on a resume, because
 * `RUNTIME_MS` is read from the clock and a person's deliberation is bounded by
 * `approvalExpiresAt` instead. The inline STATIC path did it. The reasoning
 * engines (Flue, the Tool Runner) take the other branch — they write the resume
 * point and enqueue `agent-run-execute` — and the worker then measured the
 * segment from `row.startedAt`. So a run a guard FLAGGED, approved more than an
 * hour after it started, halted at `RUNTIME_MS` before executing a step: the
 * exact case the static re-base exists to prevent.
 *
 * ── HOW THIS REACHES IT ─────────────────────────────────────────────────────
 *
 * Real database, the real resume and the real worker body. The workflow asks
 * for `flue`; the start path resolves the real (static-only) deployment and
 * parks the run at its checkpoint, and the resume is told the deployment now
 * permits `flue`, so it takes the REASONING branch and enqueues. The worker
 * call resolves the real deployment again and walks the remaining step
 * statically — the engine that walks it is not the subject; the clock it is
 * handed is, and every engine reads `RUNTIME_MS` off that same base.
 */
jest.mock('@/lib/agentic/agent-driver-policy', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-driver-policy');
    return { ...actual, resolveDriverForRun: jest.fn(actual.resolveDriverForRun) };
});
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import {
    executeQueuedWorkflowRun,
    resumeWorkflowRun,
    startWorkflowRun,
} from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { enqueue } from '@/app-layer/jobs/queue';
import type { AgentRunExecutePayload } from '@/app-layer/jobs/types';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `rclk-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const WF = `rclk-wf-${SUITE}`;
const HOUR_MS = 60 * 60 * 1000;

const person = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

/**
 * A run parked at its checkpoint, started `ageMs` ago, then resumed by a
 * person through the REASONING branch. Returns the run id and the payload the
 * resume enqueued.
 */
async function parkedThenResumed(ageMs: number): Promise<{ runId: string; payload: AgentRunExecutePayload }> {
    const started = await startWorkflowRun(person(), WF, {});
    expect(started.status).toBe('AWAITING_APPROVAL');
    // The run's age is a seeded fact, not two hours of waiting.
    await prisma.workflowRun.update({
        where: { id: started.runId },
        data: { startedAt: new Date(Date.now() - ageMs) },
    });

    const actual = jest.requireActual('@/lib/agentic/agent-driver-policy') as {
        resolveDriverForRun: typeof resolveDriverForRun;
    };
    jest.mocked(resolveDriverForRun).mockImplementationOnce(async (tenantId, opts) => ({
        ...(await actual.resolveDriverForRun(tenantId, opts)),
        driver: 'flue',
    }));
    jest.mocked(enqueue).mockClear();

    const resumed = await resumeWorkflowRun(person(), started.runId);
    // The reasoning branch: nothing ran in the request, the worker gets a job.
    expect(resumed.status).toBe('RUNNING');
    const call = jest.mocked(enqueue).mock.calls.find(([name]) => name === 'agent-run-execute');
    expect(call).toBeDefined();
    return { runId: started.runId, payload: call![1] as AgentRunExecutePayload };
}

async function settled(runId: string) {
    return prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, errorMessage: true },
    });
}

describeFn('a person’s resume of a reasoning run re-bases the engine clock (#5534)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.create({ data: { id: USER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        registerWorkflow({
            key: WF,
            name: 'Resume clock base',
            description: 'parks at a checkpoint, then synthesises one step',
            driver: 'flue',
            steps: [
                { kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' },
                { kind: 'SYNTHESIS', label: 'after', synthesize: () => ({ text: 'done' }) },
            ],
        });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    it('the resume puts its own clock base in the job payload', async () => {
        const before = Date.now();
        const { runId, payload } = await parkedThenResumed(2 * HOUR_MS);
        const after = Date.now();

        expect(payload).toMatchObject({ tenantId: TENANT, runId });
        expect(typeof payload.clockBase).toBe('number');
        expect(payload.clockBase).toBeGreaterThanOrEqual(before);
        expect(payload.clockBase).toBeLessThanOrEqual(after);
    });

    it('a flagged run approved two hours after its start runs its next step', async () => {
        // THE DEFECT. Measured from `startedAt` this segment had two hours
        // "already spent" against a sixty-minute cap and halted before the
        // synthesis ran.
        const { runId, payload } = await parkedThenResumed(2 * HOUR_MS);

        const outcome = await executeQueuedWorkflowRun(payload.tenantId, payload.runId, {
            clockBase: payload.clockBase,
        });

        expect(outcome).toMatchObject({ status: 'COMPLETED' });
        const row = await settled(runId);
        expect(row.status).toBe('COMPLETED');
        expect(row.errorMessage ?? '').not.toMatch(/RUNTIME_MS/);
    });

    it('a re-delivered job keeps the resume’s base and does not buy a fresh hour', async () => {
        // A SIGTERM retry re-delivers THE SAME payload. Delivered two hours
        // after the resume stamped it, the segment has spent two hours of
        // unattended execution and halts — a worker that re-based on its own
        // `Date.now()` would complete here, which is the wedged-run hole the
        // payload exists to close.
        const { runId } = await parkedThenResumed(3 * HOUR_MS);
        const resumedTwoHoursAgo = Date.now() - 2 * HOUR_MS;

        await executeQueuedWorkflowRun(TENANT, runId, { clockBase: resumedTwoHoursAgo });

        const row = await settled(runId);
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toMatch(/RUNTIME_MS/);
    });

    it('a job with no clock base (a start) still measures from the run’s start', async () => {
        const { runId } = await parkedThenResumed(2 * HOUR_MS);

        await executeQueuedWorkflowRun(TENANT, runId);

        const row = await settled(runId);
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toMatch(/RUNTIME_MS/);
    });

    it('a clock base in the future is ignored, never a way to buy time', async () => {
        const { runId } = await parkedThenResumed(2 * HOUR_MS);

        await executeQueuedWorkflowRun(TENANT, runId, { clockBase: Date.now() + 24 * HOUR_MS });

        const row = await settled(runId);
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toMatch(/RUNTIME_MS/);
    });
});
