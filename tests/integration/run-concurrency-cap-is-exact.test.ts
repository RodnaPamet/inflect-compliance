/**
 * #3484 — the concurrent-run cap, against a real database.
 *
 * The claim that needs a database is the one the unit tests cannot make: that
 * the cap holds when starts arrive TOGETHER. A cap enforced by "read the
 * count, then insert" admits every simultaneous start, because they all read
 * the same count — and simultaneity is the whole thing being bounded, so an
 * overshoot proportional to concurrent starts is an overshoot proportional to
 * the burst. That is why there is an advisory-locked check inside the
 * inserting transaction as well as the cheap one at the door.
 *
 * So the load-bearing test here fires N starts with `Promise.all` and counts
 * how many rows exist afterwards. It also asserts the shape of the refusal: no
 * `WorkflowRun` row for a refused start, because a row left RUNNING with
 * nothing to advance it is reaped later as a crashed executor — a refusal
 * wearing the costume of an outage.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { inFlightRunCount } from '@/lib/agentic/run-concurrency-policy';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `conc-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
/** Parks at a checkpoint, so a started run STAYS in flight. */
const WF = `conc-wf-${SUITE}`;

const ctx = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

async function setCap(cap: number | null) {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        create: { tenantId: TENANT, agentMaxConcurrentRuns: cap },
        update: { agentMaxConcurrentRuns: cap },
    });
}

async function clearRuns() {
    await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } });
    await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
}

describeFn('the concurrent-run cap (real DB, real start path)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.create({
            data: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        // A checkpoint FIRST, so `startWorkflowRun` parks the run at
        // AWAITING_APPROVAL and it is still in flight when the next start
        // arrives. A workflow that completed immediately would leave nothing to
        // count and every assertion below would pass vacuously.
        registerWorkflow({
            key: WF,
            name: 'Parks at a checkpoint',
            description: 'stays in flight',
            steps: [
                { kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'done' }) },
            ],
        });
    });

    afterAll(async () => {
        await clearRuns().catch(() => {});
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await clearRuns();
    });

    it('a started run really STAYS in flight — otherwise every cap below is vacuous', async () => {
        await setCap(null);
        const { runId } = await startWorkflowRun(ctx(), WF, {});
        const row = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { status: true },
        });
        expect(row.status).toBe('AWAITING_APPROVAL');
        expect(await inFlightRunCount(ctx())).toBe(1);
    });

    it('no cap configured — a tenant starts as many as it likes', async () => {
        await setCap(null);
        await startWorkflowRun(ctx(), WF, {});
        await startWorkflowRun(ctx(), WF, {});
        await startWorkflowRun(ctx(), WF, {});
        expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(3);
    });

    it('a cap of 1 refuses the second start, and leaves NO row behind', async () => {
        await setCap(1);
        await startWorkflowRun(ctx(), WF, {});
        await expect(startWorkflowRun(ctx(), WF, {})).rejects.toThrow(/cap is 1|in flight/i);
        // The refusal is not a half-created run. A row left RUNNING with
        // nothing to advance it is reaped later as a crashed executor.
        expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(1);
    });

    it('a cap of 0 refuses the FIRST start', async () => {
        await setCap(0);
        await expect(startWorkflowRun(ctx(), WF, {})).rejects.toThrow(/disabled/i);
        expect(await prisma.workflowRun.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('SIMULTANEOUS starts cannot exceed the cap — the claim the lock exists for', async () => {
        // THE LOAD-BEARING TEST. Without the advisory-locked check inside the
        // inserting transaction, all six of these read "0 in flight" and all
        // six insert: the cap would admit six runs against a cap of 2.
        await setCap(2);
        const attempts = Array.from({ length: 6 }, () =>
            startWorkflowRun(ctx(), WF, {}).then(
                () => 'started' as const,
                () => 'refused' as const,
            ),
        );
        const outcomes = await Promise.all(attempts);

        const started = outcomes.filter((o) => o === 'started').length;
        const rows = await prisma.workflowRun.count({ where: { tenantId: TENANT } });
        // Both numbers, and they must agree: a start that "succeeded" without a
        // row, or a row without a successful start, is a different bug than
        // over-admission and would hide inside a single-number assertion.
        expect(rows).toBe(started);
        expect(rows).toBeLessThanOrEqual(2);
        // …and the cap must not refuse EVERYTHING either. A lock that threw for
        // every caller would satisfy "<= 2" perfectly.
        expect(rows).toBeGreaterThan(0);
    });

    it('a TERMINAL run does not count against the cap', async () => {
        // A cap that counted finished runs would refuse a tenant for work that
        // was already over — and it would do so permanently, since the ledger
        // never shrinks.
        await setCap(1);
        const { runId } = await startWorkflowRun(ctx(), WF, {});
        await prisma.workflowRun.update({
            where: { id: runId },
            data: { status: 'COMPLETED' },
        });
        expect(await inFlightRunCount(ctx())).toBe(0);
        await expect(startWorkflowRun(ctx(), WF, {})).resolves.toBeDefined();
    });

    it('the count is THIS tenant\'s — a neighbour\'s runs do not consume the cap', async () => {
        // The cap is per-tenant. A count that leaked across tenants would make
        // one tenant's burst refuse everybody, which is the opposite of what
        // this feature is for.
        await setCap(1);
        const other = `o-${SUITE}`;
        await prisma.tenant.create({ data: { id: other, name: other, slug: other } });
        try {
            await prisma.workflowRun.create({
                data: {
                    tenantId: other,
                    workflowKey: WF,
                    status: 'RUNNING',
                    startedByUserId: USER,
                },
            });
            expect(await inFlightRunCount(ctx())).toBe(0);
            await expect(startWorkflowRun(ctx(), WF, {})).resolves.toBeDefined();
        } finally {
            await prisma.workflowRun.deleteMany({ where: { tenantId: other } }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: other } });
        }
    });
});
