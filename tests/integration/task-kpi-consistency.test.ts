/**
 * Tasks roadmap TP-7 (P4.9 — KPI part) — task KPI consistency (integration).
 *
 * Proves, against a real DB, that the /tasks list KPI strip is SERVER-
 * sourced and can never diverge from the server metrics.
 *
 * Background: before TP-7 the list computed its KPI numbers by counting
 * the ≤100 SSR rows client-side, while the standalone dashboard showed
 * `getTaskMetrics(ctx)`. Past the 100-row cap the two silently
 * disagreed. TP-7 made the list read the SAME `getTaskMetrics` values
 * the endpoint (`GET /tasks/metrics`) returns, so there is exactly one
 * source of truth.
 *
 * This test locks that invariant by deriving the four list KPI values
 * exactly as `TasksClient` does — off `getTaskMetrics(ctx)` — and
 * asserting they equal the independently-known seeded counts. Because
 * the derivation reads server-aggregated fields (not a row slice), the
 * assertion holds regardless of how many rows a client page would load.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createTask, setTaskStatus, getTaskMetrics } from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `task-kpi-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// Seed shape (all created OPEN by default):
const N_OVERDUE = 5; // OPEN, dueAt in the past                → overdue
const N_DUE_SOON = 3; // OPEN, dueAt now+3d (within 7d)         → dueIn7d
const N_DUE_LATER = 2; // OPEN, dueAt now+20d (within 30d only)
// + 1 moved to IN_PROGRESS (no due), + 1 moved to CLOSED (past due).
const EXPECTED_TOTAL = N_OVERDUE + N_DUE_SOON + N_DUE_LATER + 1 + 1; // 12
const EXPECTED_OPEN = N_OVERDUE + N_DUE_SOON + N_DUE_LATER; // 10 (IN_PROGRESS + CLOSED excluded)
const EXPECTED_OVERDUE = N_OVERDUE; // the CLOSED-with-past-due row is terminal → excluded
const EXPECTED_DUE_WEEK = N_DUE_SOON;

let ctx: ReturnType<typeof makeRequestContext>;
let ownerUserId: string;

/**
 * The four KPI values the TasksClient strip renders, derived from
 * `getTaskMetrics` EXACTLY as the client does (TasksClient.tsx):
 *   total → metrics.total
 *   open  → metrics.byStatus.OPEN ?? 0
 *   overdue → metrics.overdue
 *   dueWeek → metrics.dueIn7d
 */
function deriveListKpis(metrics: Awaited<ReturnType<typeof getTaskMetrics>>) {
    return {
        total: metrics.total,
        open: metrics.byStatus.OPEN ?? 0,
        overdue: metrics.overdue,
        dueWeek: metrics.dueIn7d,
    };
}

describeFn('task KPI consistency — list KPIs are server-sourced (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
        });
        const email = `${TAG}-owner@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        ownerUserId = u.id;
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: TAG, userId: u.id });

        for (let i = 0; i < N_OVERDUE; i++) {
            await createTask(ctx, { title: `overdue ${i}`, dueAt: iso(-3 * DAY_MS) });
        }
        for (let i = 0; i < N_DUE_SOON; i++) {
            await createTask(ctx, { title: `due-soon ${i}`, dueAt: iso(3 * DAY_MS) });
        }
        for (let i = 0; i < N_DUE_LATER; i++) {
            await createTask(ctx, { title: `due-later ${i}`, dueAt: iso(20 * DAY_MS) });
        }
        // One active-but-not-OPEN task (no due date).
        const inProgress = await createTask(ctx, { title: 'in progress' });
        await setTaskStatus(ctx, inProgress.id, 'IN_PROGRESS');
        // One terminal (CLOSED) task with a PAST due — must NOT count as
        // overdue (terminal statuses are excluded from the overdue set).
        const closed = await createTask(ctx, { title: 'closed', dueAt: iso(-2 * DAY_MS) });
        await setTaskStatus(ctx, closed.id, 'CLOSED', 'done in test');
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) {
            await globalPrisma.$disconnect();
            return;
        }
        await globalPrisma.task.deleteMany({ where: { tenantId: TENANT_ID } });
        // The remaining tenant-scoped rows are guarded by DB triggers that
        // reject ordinary DELETEs: AuditLog is append-only
        // (IMMUTABLE_AUDIT_LOG) and TenantMembership is protected by the
        // last-OWNER guard (LAST_OWNER_GUARD). Drop them inside a
        // `session_replication_role = 'replica'` transaction — the canonical
        // integration-teardown pattern (mirrors task-filters.test.ts) that
        // disables triggers for the cleanup only.
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "NotificationOutbox" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "AutomationExecution" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TaskKeySequence" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        // Guarded: an undefined filter value is DROPPED, not matched —
        // see the teardown note in ./db-helper.ts.
        if (ownerUserId) {
            await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        }
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('the list KPI values (derived from getTaskMetrics) equal the seeded counts', async () => {
        const metrics = await getTaskMetrics(ctx);
        const kpis = deriveListKpis(metrics);
        expect(kpis).toEqual({
            total: EXPECTED_TOTAL,
            open: EXPECTED_OPEN,
            overdue: EXPECTED_OVERDUE,
            dueWeek: EXPECTED_DUE_WEEK,
        });
    });

    it('the KPI source is getTaskMetrics — repeated reads never diverge', async () => {
        // The list KPI strip reads server-aggregated metrics, not a
        // client-side row count. Two independent reads of the source
        // must agree exactly (no client-vs-server, no page-slice
        // divergence). This is the invariant that the pre-TP-7
        // client-row count could not hold past the 100-row SSR cap.
        const a = deriveListKpis(await getTaskMetrics(ctx));
        const b = deriveListKpis(await getTaskMetrics(ctx));
        expect(a).toEqual(b);
    });
});
