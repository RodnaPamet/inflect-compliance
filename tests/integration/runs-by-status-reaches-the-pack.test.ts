/**
 * #3484 — runs by status, as the governance pack actually reports them.
 *
 * `agentic-reports.test.ts` already holds that every emitted metric carries a
 * written definition and vice versa, in both directions. What that cannot
 * check is whether the six new figures are the RIGHT numbers: a parity test
 * passes just as happily for six zeros.
 *
 * So this creates runs in known statuses and reads them back out of the pack.
 * The two halves are deliberately different questions and the test holds both:
 *
 *   - The terminal three are OVER_WINDOW, on `startedAt`. A run that started
 *     before the window does not count however it ended.
 *   - The live three are AS_OF_GENERATION, UNWINDOWED. A run awaiting approval
 *     since last quarter is still awaiting approval now, and a windowed read
 *     would miss exactly the stuck ones a reviewer needs to see.
 *
 * That second case is the one a single windowed query gets wrong while looking
 * entirely reasonable, so it is asserted with a run started well outside the
 * window.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { buildIncidentHistoryReport } from '@/app-layer/usecases/agent-governance-reports';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rbs-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

const ctx = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

const DAY = 24 * 60 * 60 * 1000;

async function makeRun(status: string, startedAt: Date) {
    await prisma.workflowRun.create({
        data: {
            tenantId: TENANT,
            workflowKey: 'audit-prep',
            status: status as never,
            startedByUserId: USER,
            startedAt,
        },
    });
}

/**
 * The measured value of one metric, or `null` when it is not a measurement.
 *
 * `state`, not `kind` — `Measure` discriminates on `state`, and a reader that
 * looked for the wrong field would return null for every metric and fail every
 * assertion below for the wrong reason.
 */
function value(
    metrics: Record<string, { state: string; value: number | null }>,
    id: string,
): number | null {
    const m = metrics[id];
    return m && m.state === 'MEASURED' ? m.value : null;
}

describeFn('runs by status reach the governance pack (real DB)', () => {
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

        const now = Date.now();
        const inWindow = new Date(now - 2 * DAY);
        // Well outside a 90-day window, so a windowed read of the LIVE
        // statuses reports zero and the unwindowed read reports one.
        const longAgo = new Date(now - 400 * DAY);

        await makeRun('COMPLETED', inWindow);
        await makeRun('COMPLETED', inWindow);
        await makeRun('FAILED', inWindow);
        await makeRun('ABORTED', inWindow);
        await makeRun('RUNNING', inWindow);
        await makeRun('PAUSED', inWindow);
        await makeRun('AWAITING_APPROVAL', longAgo);
        // A terminal run from long ago: it must NOT appear in the window
        // counts, which is the other half of the window claim.
        await makeRun('COMPLETED', longAgo);
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await deleteAuditRowsForTenants(prisma, TENANT).catch(() => {});
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('counts the terminal three over the window, and excludes an older run', async () => {
        const report = await buildIncidentHistoryReport(ctx(), { windowDays: 90 });
        const m = report.metrics as Record<string, { state: string; value: number | null }>;
        // TWO completed inside the window; the third completed 400 days ago
        // and must not be here.
        expect(value(m, 'runs.completed')).toBe(2);
        expect(value(m, 'runs.failed')).toBe(1);
        expect(value(m, 'runs.aborted')).toBe(1);
    });

    it('counts the live three as of NOW, including one older than the window', async () => {
        // The claim a windowed read gets wrong. The AWAITING_APPROVAL run
        // started 400 days ago and is still waiting; a reviewer's queue does
        // not reset at a quarter boundary.
        const report = await buildIncidentHistoryReport(ctx(), { windowDays: 90 });
        const m = report.metrics as Record<string, { state: string; value: number | null }>;
        expect(value(m, 'runs.in_flight')).toBe(1);
        expect(value(m, 'runs.paused')).toBe(1);
        expect(value(m, 'runs.awaiting_approval')).toBe(1);
    });

    it('reports a status with no runs as a MEASURED zero, not as absent', async () => {
        // `measured(0)` and "not assessed" are different facts, and `Measure`
        // keeps them apart on purpose. An omitted key would render as the
        // latter — "we did not look" — for a tenant we did look at.
        const report = await buildIncidentHistoryReport(ctx(), { windowDays: 1 });
        const m = report.metrics as Record<string, { state: string; value: number | null }>;
        // A one-day window contains none of the fixture's runs.
        expect(m['runs.completed'].state).toBe('MEASURED');
        expect(value(m, 'runs.completed')).toBe(0);
    });

    it('every one of the six carries a written definition', async () => {
        // The file-level parity test covers this across the whole pack; naming
        // the six here means a definition deleted with its metric still fails
        // in the place a reader is looking.
        const report = await buildIncidentHistoryReport(ctx(), { windowDays: 90 });
        const defined = new Set(report.definitions.map((d) => d.id));
        for (const id of [
            'runs.completed', 'runs.failed', 'runs.aborted',
            'runs.in_flight', 'runs.awaiting_approval', 'runs.paused',
        ]) {
            expect(defined.has(id)).toBe(true);
        }
    });
});
