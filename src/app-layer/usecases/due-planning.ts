/**
 * Due Planning & Dashboard Metrics
 *
 * runDuePlanning()  — idempotent: creates PLANNED runs for due test plans
 * getDueQueue()     — returns overdue + due-soon plans
 * getTestDashboardMetrics() — computes all dashboard metrics server-side
 * listAllTestPlans() — lists all plans across controls (fixes N+1)
 */
import { Prisma, TestPlanStatus } from '@prisma/client';
import { RequestContext } from '../types';
import { assertCanReadTests, assertCanManageTestPlans } from '../policies/test.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext, runInTenantReadContext, type PrismaTx } from '@/lib/db-context';
import { parseEnumListFilter } from '../domain/list-filter';

// ─── Authoritative "due" signal (PR-Q) ───
//
// A test plan carries two due clocks that used to be queried separately and
// disagree:
//   • `nextDueAt` — derived from the `frequency` enum (incl. AD_HOC).
//   • `nextRunAt` — derived from the cron `schedule` (Epic G-2).
// The old queries filtered `frequency != 'AD_HOC'` and never looked at
// `nextRunAt`, so a plan given a cron cadence (nextRunAt set, frequency still
// AD_HOC — the NewTestPlanModal default) was permanently invisible in
// /tests/due and the dashboard overdue count.
//
// The reconciliation: a plan is "due" when its EARLIEST real next-occurrence
// (the min of the two non-null clocks) has reached the threshold. A plan with
// neither clock (a pure ad-hoc plan) is never due. `effectiveDueAt` is that one
// authoritative signal; `dueOrBeforeWhere` is the matching Prisma filter. Every
// due/overdue surface (getDueQueue, runDuePlanning, dashboard overduePlans,
// listAllTestPlans) is driven from these two so the counts can't diverge.

// R4-P3 #2 — defensive read cap for the "full population" list surfaces. The
// /tests and /tests/due pages consume the whole set (client-side KPI counts,
// filtering, sorting), so we can't cursor-page them without breaking those
// counts — but the read must still be bounded. 2000 is far beyond any realistic
// tenant's plan count; it exists only so a runaway tenant can't table-scan.
const PLAN_LIST_CAP = 2000;

export function effectiveDueAt(p: { nextDueAt: Date | null; nextRunAt: Date | null }): Date | null {
    const dates = [p.nextDueAt, p.nextRunAt].filter((d): d is Date => d != null);
    if (dates.length === 0) return null;
    return dates.reduce((a, b) => (a <= b ? a : b));
}

/** Plans whose earliest due-clock is at/before `threshold` (regardless of frequency). */
function dueOrBeforeWhere(threshold: Date): Prisma.ControlTestPlanWhereInput {
    return {
        OR: [{ nextDueAt: { lte: threshold } }, { nextRunAt: { lte: threshold } }],
    };
}

// ─── Due Queue ───

export async function getDueQueue(ctx: RequestContext) {
    assertCanReadTests(ctx);

    const now = new Date();
    const soon = new Date(now);
    soon.setDate(soon.getDate() + 7);

    const plans = await runInTenantContext(ctx, async (db: PrismaTx) => {
        return db.controlTestPlan.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
                ...dueOrBeforeWhere(soon),
            },
            include: {
                control: { select: { id: true, name: true, code: true } },
                owner: { select: { id: true, name: true, email: true } },
                runs: {
                    where: { status: { in: ['PLANNED', 'RUNNING'] } },
                    select: { id: true, status: true, createdAt: true },
                    take: 1,
                    orderBy: { createdAt: 'desc' },
                },
                _count: { select: { runs: true } },
            },
            take: PLAN_LIST_CAP,
        });
    });

    // Sort + flag by the reconciled effective-due signal (not nextDueAt alone),
    // computed in memory because Prisma can't order by min(nextDueAt, nextRunAt).
    return plans
        .map((p) => {
            const due = effectiveDueAt(p);
            return {
                ...p,
                effectiveDueAt: due,
                isOverdue: due ? due <= now : false,
                hasPendingRun: p.runs?.length > 0,
            };
        })
        .sort((a, b) => (a.effectiveDueAt?.getTime() ?? Infinity) - (b.effectiveDueAt?.getTime() ?? Infinity));
}

// ─── Due Planning (Idempotent) ───

export async function runDuePlanning(ctx: RequestContext) {
    assertCanManageTestPlans(ctx);

    return runInTenantContext(ctx, async (db: PrismaTx) => {
        const now = new Date();

        // Find ACTIVE plans that are due and don't already have a PLANNED/RUNNING run.
        // Reconciled due signal — either clock at/before now (see effectiveDueAt).
        //
        // DEDUPE vs THE SCHEDULER (`control-test-scheduler`): a cron-SCHEDULED
        // plan belongs to the scheduler, which claims it under an optimistic
        // lock on `nextRunAt` and enqueues a runner job. Between that claim and
        // the runner writing its ControlTestRun row there is a window where the
        // `runs: PLANNED/RUNNING` idempotency filter below sees nothing — so
        // this path would mint a SECOND PLANNED run for the same occurrence.
        //
        // The two are separated by OWNERSHIP rather than by a shared lock:
        // `schedule: null` here means due-planning only instantiates runs for
        // plans that have no cron (the ones nobody else will ever pick up).
        // Disjoint input sets make the double-run impossible by construction —
        // no cross-process coordination to get wrong, and no ambiguity about
        // which component is responsible for a given plan.
        const duePlans = await db.controlTestPlan.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
                schedule: null,
                ...dueOrBeforeWhere(now),
            },
            include: {
                runs: {
                    where: { status: { in: ['PLANNED', 'RUNNING'] } },
                    select: { id: true },
                    take: 1,
                },
            },
        });

        // Filter to only plans without pending runs (idempotent)
        const needsRun = duePlans.filter((p) => p.runs.length === 0);

        const created: string[] = [];
        for (const plan of needsRun) {
            const run = await db.controlTestRun.create({
                data: {
                    tenantId: ctx.tenantId,
                    controlId: plan.controlId,
                    testPlanId: plan.id,
                    status: 'PLANNED',
                    createdByUserId: ctx.userId,
                    requestId: ctx.requestId,
                },
            });
            created.push(run.id);
        }

        await logEvent(db, ctx, {
            action: 'DUE_PLANNING_EXECUTED',
            entityType: 'ControlTestPlan',
            entityId: 'batch',
            details: JSON.stringify({ checked: duePlans.length, created: created.length, runIds: created }),
            detailsJson: {
                category: 'custom',
                event: 'due_planning_executed',
                checked: duePlans.length,
                created: created.length,
                runIds: created,
            },
        });

        return {
            checked: duePlans.length,
            alreadyPending: duePlans.length - needsRun.length,
            created: created.length,
            runIds: created,
        };
    });
}

// ─── Dashboard Metrics ───

export async function getTestDashboardMetrics(ctx: RequestContext, periodDays: number = 30) {
    assertCanReadTests(ctx);

    return runInTenantReadContext(ctx, async (db: PrismaTx) => {
        const now = new Date();
        const periodStart = new Date(now);
        periodStart.setDate(periodStart.getDate() - periodDays);

        // R4-P3 #2 — aggregate in the DB instead of pulling every run (and every
        // run's evidence ids) into memory. One groupBy over status×result yields
        // totals + pass/fail/inconclusive; a count yields evidence coverage; a
        // per-control FAIL groupBy yields repeated failures.
        const statusResultGroups = await db.controlTestRun.groupBy({
            by: ['status', 'result'],
            where: { tenantId: ctx.tenantId, createdAt: { gte: periodStart } },
            _count: { _all: true },
        });
        let totalRuns = 0;
        let completed = 0;
        let passCount = 0;
        let failCount = 0;
        let inconclusiveCount = 0;
        for (const g of statusResultGroups) {
            totalRuns += g._count._all;
            if (g.status === 'COMPLETED') {
                completed += g._count._all;
                if (g.result === 'PASS') passCount += g._count._all;
                else if (g.result === 'FAIL') failCount += g._count._all;
                else if (g.result === 'INCONCLUSIVE') inconclusiveCount += g._count._all;
            }
        }

        // Completed runs carrying ≥1 evidence link.
        const runsWithEvidenceCount = await db.controlTestRun.count({
            where: { tenantId: ctx.tenantId, createdAt: { gte: periodStart }, status: 'COMPLETED', evidence: { some: {} } },
        });

        const completionRate = totalRuns > 0 ? Math.round((completed / totalRuns) * 100) : 0;
        const passRate = completed > 0 ? Math.round((passCount / completed) * 100) : 0;
        const failRate = completed > 0 ? Math.round((failCount / completed) * 100) : 0;
        const evidenceRate = completed > 0 ? Math.round((runsWithEvidenceCount / completed) * 100) : 0;

        // Overdue plans — the ONE authoritative overdue count, reconciled across
        // both clocks (same signal /tests/due and /tests use). `lt: now` on either
        // clock = overdue; the `dueOrBeforeWhere(now)` OR includes both.
        const overduePlans = await db.controlTestPlan.count({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
                ...dueOrBeforeWhere(now),
            },
        });

        // Controls with repeated failures (≥2 FAIL in period) — per-control groupBy.
        const failGroups = await db.controlTestRun.groupBy({
            by: ['controlId'],
            where: { tenantId: ctx.tenantId, createdAt: { gte: periodStart }, status: 'COMPLETED', result: 'FAIL' },
            _count: { _all: true },
        });
        const repeatedFailures = failGroups
            .filter((g) => g._count._all >= 2)
            .map((g) => ({ controlId: g.controlId as string, failCount: g._count._all }));

        // Get control names for repeated failures
        let repeatedFailureDetails: Array<{ controlId: string; controlName: string; controlCode: string | null; failCount: number }> = [];
        if (repeatedFailures.length > 0) {
            const controls = await db.control.findMany({
                where: { id: { in: repeatedFailures.map((f: { controlId: string }) => f.controlId) }, tenantId: ctx.tenantId },
                select: { id: true, name: true, code: true },
            });
            const cMap = new Map(controls.map((c) => [c.id, c]));
            repeatedFailureDetails = repeatedFailures.map(f => ({
                controlId: f.controlId,
                controlName: cMap.get(f.controlId)?.name || 'Unknown',
                controlCode: cMap.get(f.controlId)?.code || null,
                failCount: f.failCount,
            }));
        }

        // Total plans
        const totalPlans = await db.controlTestPlan.count({
            where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
        });

        return {
            periodDays,
            periodStart: periodStart.toISOString(),
            totalPlans,
            totalRuns,
            completedRuns: completed,
            passRuns: passCount,
            failRuns: failCount,
            inconclusiveRuns: inconclusiveCount,
            completionRate,
            passRate,
            failRate,
            evidenceRate,
            overduePlans,
            repeatedFailures: repeatedFailureDetails,
            runsWithEvidence: runsWithEvidenceCount,
        };
    });
}

// ─── All Plans (fixes N+1) ───

export interface TestPlanFilters {
    status?: string;
    controlId?: string;
    due?: 'overdue' | 'next7d';
    q?: string;
}

export async function listAllTestPlans(ctx: RequestContext, filters: TestPlanFilters = {}) {
    assertCanReadTests(ctx);

    return runInTenantContext(ctx, async (db: PrismaTx) => {
        const where: Prisma.ControlTestPlanWhereInput = { tenantId: ctx.tenantId };

        // Raw query-string values, NOT validated enums — see
        // `parseEnumListFilter`. The `as` cast this replaces 500'd on any
        // two-value selection from the /tests plan facet
        // (`?status=ACTIVE,PAUSED` reached Prisma as one literal string).
        where.status = parseEnumListFilter<TestPlanStatus>(
            filters.status,
            Object.values(TestPlanStatus),
            'test plan status',
        );
        if (filters.controlId) where.controlId = filters.controlId;
        // Reconciled due filters — either clock (nextDueAt / nextRunAt) counts, so
        // a cron-scheduled plan is never invisible here either.
        if (filters.due === 'overdue') {
            const now = new Date();
            where.OR = [{ nextDueAt: { lt: now } }, { nextRunAt: { lt: now } }];
        } else if (filters.due === 'next7d') {
            const now = new Date();
            const in7 = new Date(now.getTime() + 7 * 86400000);
            where.OR = [
                { nextDueAt: { gte: now, lte: in7 } },
                { nextRunAt: { gte: now, lte: in7 } },
            ];
        }
        if (filters.q) {
            where.name = { contains: filters.q, mode: 'insensitive' };
        }

        return db.controlTestPlan.findMany({
            where,
            include: {
                control: { select: { id: true, name: true, code: true } },
                owner: { select: { id: true, name: true, email: true } },
                runs: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { id: true, result: true, status: true, executedAt: true },
                },
                _count: { select: { runs: true, steps: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: PLAN_LIST_CAP,
        });
    });
}
