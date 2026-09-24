/**
 * WHICH ENGINE WALKED THIS RUN — recorded, and recorded truthfully.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * `startWorkflowRun` resolved the driver, wrote it into the hash-chained trail
 * under a key documented as "Which engine walked this run", and then called
 * `executeFrom` WITHOUT it — so the executor took its parameter default and
 * `selectRunDriver` was handed `static` no matter what the tenant was
 * configured for. `resumeWorkflowRun` resolved nothing at all.
 *
 * Today every answer is `static`, so the entry is true by coincidence. The
 * coincidence ends the moment `DRIVER_IMPLEMENTED.flue` flips: the trail would
 * say `flue` for a run the static engine walked, in an append-only row, about
 * precisely the question an incident review opens it to ask.
 *
 * ── WHY THE THREE KEYS, AND WHY THIS TEST CAN SEE THE DIFFERENCE ────────────
 *
 * A single value cannot explain an engine choice, because three separate
 * parties have a say:
 *
 *   driverRequested — what the DEFINITION asked for
 *   driverAllowed   — what the DEPLOYMENT permits (env ∧ tenant ∧ implemented)
 *   driver          — what actually WALKED it, the intersection
 *
 * `driverAllowed` cannot be anything but `static` until a second driver is
 * implemented, so a test that only watched that key would be pinning a
 * constant. `driverRequested` is settable TODAY — a definition may ask for
 * `flue` — which is what makes the divergence below observable rather than
 * hypothetical: one workflow asks for an engine it cannot have, and the run
 * records the request, the refusal and the engine that really ran.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun, resumeWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `eng-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
/** Asks for nothing, so it takes the default. */
const WF_DEFAULT = `eng-default-${SUITE}`;
/** Asks for an engine this build does not have. */
const WF_ASKS_FLUE = `eng-flue-${SUITE}`;

const ctx = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

type AuditDetails = {
    driver?: unknown;
    driverAllowed?: unknown;
    driverRequested?: unknown;
    driverReason?: unknown;
};

/** The newest audit row for one action on one run, parsed. */
async function auditDetails(runId: string, action: string): Promise<AuditDetails> {
    const row = await prisma.auditLog.findFirst({
        where: { tenantId: TENANT, entityId: runId, action },
        orderBy: { createdAt: 'desc' },
        select: { detailsJson: true },
    });
    expect(row).not.toBeNull();
    return (row?.detailsJson ?? {}) as AuditDetails;
}

describeFn('a run records which engine walked it (real DB, real engine)', () => {
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

        // A checkpoint in both, so `resumeWorkflowRun` has something to resume.
        const steps = [
            { kind: 'HUMAN_CHECKPOINT' as const, label: 'review', approvalWindow: '24h' as const },
            {
                kind: 'SYNTHESIS' as const,
                label: 'summary',
                synthesize: () => ({ text: 'done' }),
            },
        ];
        registerWorkflow({
            key: WF_DEFAULT,
            name: 'Default engine',
            description: 'asks for no driver',
            steps,
        });
        registerWorkflow({
            key: WF_ASKS_FLUE,
            name: 'Asks for flue',
            description: 'asks for a driver this build does not implement',
            driver: 'flue',
            steps,
        });
    });

    afterAll(async () => {
        if (TENANT) {
            await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                    TENANT,
                );
            }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('stamps the engine on the run row, by the real start path', async () => {
        const { runId } = await startWorkflowRun(ctx(), WF_DEFAULT, {});

        const row = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { driver: true },
        });
        expect(row.driver).toBe('STATIC');
    });

    it('the row and the audit entry name the SAME engine', async () => {
        // Two independent write sites, one fact. Stamping the chosen driver on
        // the row and the permitted one in the trail would pass every other
        // assertion in this file and still leave the two disagreeing.
        const { runId } = await startWorkflowRun(ctx(), WF_DEFAULT, {});

        const row = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { driver: true },
        });
        const details = await auditDetails(runId, 'WORKFLOW_RUN_STARTED');

        expect(String(details.driver).toUpperCase()).toBe(row.driver);
    });

    it('a definition asking for an engine it cannot have gets static, and the trail says all three', async () => {
        // THE DIVERGENCE. `driverRequested` is `flue` and `driver` is `static`,
        // so an assertion on either one alone would be satisfied by a column
        // hard-wired to the other.
        const { runId } = await startWorkflowRun(ctx(), WF_ASKS_FLUE, {});

        const details = await auditDetails(runId, 'WORKFLOW_RUN_STARTED');
        expect({
            requested: details.driverRequested,
            allowed: details.driverAllowed,
            ran: details.driver,
        }).toEqual({ requested: 'flue', allowed: 'static', ran: 'static' });

        const row = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { driver: true },
        });
        expect(row.driver).toBe('STATIC');
    });

    it('a definition that asks for nothing records a request of static, not null', async () => {
        // `requestedDriver` defaults rather than reporting absence, so the
        // three keys are always comparable with each other.
        const { runId } = await startWorkflowRun(ctx(), WF_DEFAULT, {});

        const details = await auditDetails(runId, 'WORKFLOW_RUN_STARTED');
        expect(details.driverRequested).toBe('static');
    });

    it('a RESUME names its own engine — it used to name none at all', async () => {
        // A resume is a fresh authorization moment: it re-resolves the
        // invocation and the policy card, and it now re-resolves the driver
        // too. Before this the entry carried `{ category: 'access' }` and
        // nothing else, so a mid-run driver change was invisible on every
        // surface.
        const { runId, status } = await startWorkflowRun(ctx(), WF_ASKS_FLUE, {});
        expect(status).toBe('AWAITING_APPROVAL');

        await resumeWorkflowRun(ctx(), runId);

        const details = await auditDetails(runId, 'WORKFLOW_RUN_RESUMED');
        expect({
            requested: details.driverRequested,
            allowed: details.driverAllowed,
            ran: details.driver,
        }).toEqual({ requested: 'flue', allowed: 'static', ran: 'static' });
    });

    it('the run row does NOT move when the run resumes', async () => {
        // The column records what the run OPENED under — the same deliberate
        // narrowing `policyCardVersion` carries. The trail is where a
        // per-segment change becomes visible, and the two answer different
        // questions on purpose.
        const { runId } = await startWorkflowRun(ctx(), WF_DEFAULT, {});
        const before = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { driver: true },
        });

        await resumeWorkflowRun(ctx(), runId);

        const after = await prisma.workflowRun.findUniqueOrThrow({
            where: { id: runId },
            select: { driver: true },
        });
        expect(after.driver).toBe(before.driver);
    });
});
