/**
 * Epic G-2 — Test Scheduling usecases.
 *
 * Three application-layer entry points sit beneath the new G-2 API
 * surface:
 *
 *   • scheduleTestPlan  — set/clear a plan's cron schedule, IANA TZ,
 *                         automation type, and per-type config blob.
 *                         Recomputes nextRunAt so the next scheduler
 *                         tick picks the plan up at the right instant.
 *
 *   • getTestDashboard  — G-2-specific dashboard slice. Emits an
 *                         `automation` summary, a top-N upcoming
 *                         list, and a per-day pass/fail/inconclusive
 *                         trend over the requested period. Layered
 *                         alongside the existing `getTestDashboardMetrics`
 *                         (which is keyed on the legacy
 *                         frequency/nextDueAt model) — both can be
 *                         merged into one API response so callers
 *                         pick the slice they need.
 *
 * All three are tenant-scoped and authorisation-gated through the
 * existing `assertCanReadTests` / `assertCanManageTestPlans`
 * policies. Free-text fields are sanitised at the persistence
 * boundary before write.
 *
 * @module usecases/test-scheduling
 */
import type { RequestContext } from '../types';
import {
    assertCanReadTests,
    assertCanManageTestPlans,
} from '../policies/test.policies';
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { computeNextRunFromCron } from '../jobs/control-test-scheduler';
import { computeNextDueAt } from '../utils/cadence';
import { deriveMethodFromAutomationType } from './control/test-plans';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';

// ─── 1. scheduleTestPlan ───────────────────────────────────────────

export interface ScheduleTestPlanInput {
    /** Cron expression. Pass null to clear the schedule (MANUAL fallback). */
    schedule: string | null;
    /** IANA timezone id (e.g. 'UTC', 'Europe/London'). */
    scheduleTimezone?: string | null;
    automationType: 'MANUAL' | 'SCRIPT' | 'INTEGRATION';
    /** Per-handler config blob — shape validated by the handler later. */
    automationConfig?: unknown;
}

/**
 * Apply or clear a plan's automation schedule.
 *
 * Cross-field invariants (enforced here, not at the zod boundary, so
 * the error message can reference the plan):
 *
 *   • SCRIPT or INTEGRATION ⇒ `schedule` MUST be non-null. Without
 *     a cron the scheduler never picks the plan up — silently
 *     accepting null would create plans that look automated but
 *     never run.
 *   • MANUAL ⇒ `schedule` is OPTIONAL. A MANUAL plan MAY carry a cron
 *     (a "scheduled manual review": each tick instantiates a PLANNED
 *     "awaiting manual completion" run — see control-test-runner's
 *     MANUAL / no-handler path) OR omit it (pure ad-hoc). This is the
 *     honest shape while no SCRIPT/INTEGRATION engine exists; a cadence
 *     no longer forces the misleading SCRIPT label.
 *   • `schedule`, when present, MUST parse via cron-parser.
 *   • `scheduleTimezone`, when present, MUST be accepted by the
 *     ECMAScript Intl tz tables (we test with `toLocaleString`).
 *
 * Mutation effects:
 *   • Sets the four scheduling columns on ControlTestPlan.
 *   • Recomputes `nextRunAt` from the new cron+TZ, anchored to "now".
 *   • Clears `lastScheduledRunAt` — the prior bookkeeping is
 *     meaningless once the schedule changes.
 *
 * The next scheduler tick (within 5 min) will pick the plan up
 * if `nextRunAt <= now`, or wait until it is.
 */
export async function scheduleTestPlan(
    ctx: RequestContext,
    planId: string,
    input: ScheduleTestPlanInput,
) {
    assertCanManageTestPlans(ctx);

    // ─── Cross-field validation ────────────────────────────────────
    // MANUAL plans MAY carry a cron (scheduled manual review) or omit it
    // (ad-hoc) — both are valid. Only SCRIPT/INTEGRATION require a cron, since
    // without one the scheduler never picks them up and they'd look automated
    // but never run.
    if (input.automationType !== 'MANUAL' && input.schedule === null) {
        throw badRequest(
            `${input.automationType} plans require a non-null cron schedule.`,
        );
    }

    if (input.schedule !== null) {
        const tz = input.scheduleTimezone ?? null;
        if (tz && !isValidTimezone(tz)) {
            throw badRequest(
                `Unknown timezone "${tz}". Use an IANA tz id like "UTC" or "Europe/London".`,
            );
        }
        // Parse-test the cron — computeNextRunFromCron returns null on
        // invalid input rather than throwing, so we treat null as the
        // validation failure signal here.
        if (computeNextRunFromCron(input.schedule, tz, new Date()) === null) {
            throw badRequest(
                `Invalid cron expression "${input.schedule}".`,
            );
        }
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const plan = await db.controlTestPlan.findFirst({
            where: { id: planId, tenantId: ctx.tenantId },
            select: {
                id: true,
                tenantId: true,
                automationType: true,
                schedule: true,
                scheduleTimezone: true,
                nextRunAt: true,
                frequency: true,
            },
        });
        if (!plan) throw notFound('Test plan not found');

        // Recompute nextRunAt under the NEW (or just-cleared) schedule.
        const tz = input.scheduleTimezone ?? null;
        const nextRunAt = input.schedule
            ? computeNextRunFromCron(input.schedule, tz, new Date())
            : null;

        // R4-P3 #6 — the two clocks are INDEPENDENT (see controls.prisma:
        //   • `nextDueAt` — the human review cadence (frequency: "review monthly")
        //   • `nextRunAt` — the automation cadence (cron: "the script runs daily")
        // Overwriting nextDueAt with nextRunAt collapsed them, erasing the human
        // cadence for every scheduled plan. Keep nextDueAt frequency-derived;
        // the due/overdue surfaces reconcile the pair via effectiveDueAt =
        // min(nextDueAt, nextRunAt), so whichever fires first still wins.
        const method = deriveMethodFromAutomationType(input.automationType);
        const nextDueAt = computeNextDueAt(plan.frequency, new Date());

        const updated = await db.controlTestPlan.update({
            where: { id: planId },
            data: {
                automationType: input.automationType,
                method,
                schedule: input.schedule
                    ? sanitizePlainText(input.schedule)
                    : null,
                scheduleTimezone:
                    input.scheduleTimezone === undefined
                        ? plan.scheduleTimezone
                        : input.scheduleTimezone === null
                            ? null
                            : sanitizePlainText(input.scheduleTimezone),
                automationConfig:
                    input.automationConfig === undefined
                        ? undefined
                        : (input.automationConfig as never),
                nextRunAt,
                nextDueAt,
                // Schedule context shifted — prior tick bookkeeping
                // is meaningless under the new cron.
                lastScheduledRunAt: null,
            },
        });

        await logEvent(db, ctx, {
            action: 'TEST_PLAN_SCHEDULED',
            entityType: 'ControlTestPlan',
            entityId: planId,
            details:
                input.schedule === null
                    ? `Cleared schedule (now MANUAL)`
                    : `Set ${input.automationType} schedule "${input.schedule}" (${tz ?? 'UTC'})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ControlTestPlan',
                operation: 'updated',
                changes: {
                    automationType: input.automationType,
                    schedule: input.schedule,
                    scheduleTimezone: tz,
                    nextRunAt: nextRunAt?.toISOString() ?? null,
                },
                summary: `Test plan schedule updated`,
            },
        });

        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

// PR-Q — the standalone `getUpcomingTests` usecase + its `GET /tests/upcoming`
// route were removed (dead surface — no UI consumer). `getTestDashboard` below
// still builds its own top-N "upcoming" list from `nextRunAt`; this DTO is the
// shape of those items and is now used solely by the dashboard.
export interface UpcomingTestDto {
    planId: string;
    planName: string;
    controlId: string;
    controlName: string;
    automationType: 'MANUAL' | 'SCRIPT' | 'INTEGRATION';
    schedule: string | null;
    scheduleTimezone: string | null;
    /** ISO timestamp; never null for items in this list. */
    nextRunAtIso: string;
    /** Negative = overdue. Useful for sort + visual badging. */
    daysUntilRun: number;
}

// ─── 3. getTestDashboard (G-2 slice) ───────────────────────────────

export interface TestDashboardG2 {
    periodDays: number;
    automation: {
        plansManual: number;
        plansScript: number;
        plansIntegration: number;
        /** Active plans with a non-null schedule (SCRIPT or INTEGRATION). */
        plansScheduledActive: number;
        /** Active scheduled plans whose nextRunAt is already in the past. */
        overdueScheduled: number;
    };
    /** Top-N upcoming runs over the next 30 days. */
    upcoming: UpcomingTestDto[];
    /**
     * Per-day completed-run counts for the period — drives the
     * sparkline. Aligned arrays: `days[i]` ↔ `pass[i]` etc. Days are
     * UTC-anchored so the chart matches the dashboard tooltip across
     * tenants in different zones.
     */
    trend: {
        days: string[];
        pass: number[];
        fail: number[];
        inconclusive: number[];
    };
}

export async function getTestDashboard(
    ctx: RequestContext,
    periodDays: number = 30,
): Promise<TestDashboardG2> {
    assertCanReadTests(ctx);

    const validPeriod = [30, 90, 180, 365].includes(periodDays)
        ? periodDays
        : 30;
    const now = new Date();
    const periodStart = new Date(now.getTime() - validPeriod * 86_400_000);

    return runInTenantReadContext(ctx, async (db) => {
        // ─── Automation plan counts (4 grouped reads) ──────────────
        const [
            plansManual,
            plansScript,
            plansIntegration,
            plansScheduledActive,
            overdueScheduled,
        ] = await Promise.all([
            db.controlTestPlan.count({
                where: { tenantId: ctx.tenantId, automationType: 'MANUAL' },
            }),
            db.controlTestPlan.count({
                where: { tenantId: ctx.tenantId, automationType: 'SCRIPT' },
            }),
            db.controlTestPlan.count({
                where: {
                    tenantId: ctx.tenantId,
                    automationType: 'INTEGRATION',
                },
            }),
            // R4-P3 #7 — align the "scheduled" KPIs with what the scheduler
            // actually scans: findDueTestPlans executes ANY ACTIVE plan carrying
            // a cron `schedule`, regardless of automationType (a scheduled MANUAL
            // plan is the honest shape while no SCRIPT/INTEGRATION engine exists).
            // The old `automationType IN (SCRIPT, INTEGRATION)` filter made every
            // scheduled MANUAL plan — the only kind that runs today — invisible
            // in these counts even as the scheduler ran them each tick.
            db.controlTestPlan.count({
                where: {
                    tenantId: ctx.tenantId,
                    status: 'ACTIVE',
                    schedule: { not: null },
                },
            }),
            db.controlTestPlan.count({
                where: {
                    tenantId: ctx.tenantId,
                    status: 'ACTIVE',
                    schedule: { not: null },
                    nextRunAt: { lt: now },
                },
            }),
        ]);

        // ─── Upcoming top-10 ───────────────────────────────────────
        const upcomingRows = await db.controlTestPlan.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
                schedule: { not: null },
                nextRunAt: { not: null },
                // #7 — match the scan (any scheduled ACTIVE plan), so a scheduled
                // MANUAL plan the scheduler runs also appears in "upcoming".
            },
            select: {
                id: true,
                name: true,
                controlId: true,
                automationType: true,
                schedule: true,
                scheduleTimezone: true,
                nextRunAt: true,
                control: { select: { id: true, name: true } },
            },
            orderBy: { nextRunAt: 'asc' },
            take: 10,
        });

        const upcoming: UpcomingTestDto[] = upcomingRows.map((p) => {
            const next = p.nextRunAt as Date;
            return {
                planId: p.id,
                planName: p.name,
                controlId: p.controlId,
                controlName: p.control?.name ?? 'Unknown',
                automationType: p.automationType as
                    | 'MANUAL'
                    | 'SCRIPT'
                    | 'INTEGRATION',
                schedule: p.schedule,
                scheduleTimezone: p.scheduleTimezone,
                nextRunAtIso: next.toISOString(),
                daysUntilRun: Math.floor(
                    (next.getTime() - now.getTime()) / 86_400_000,
                ),
            };
        });

        // ─── Per-day trend ─────────────────────────────────────────
        // We bucket COMPLETED runs in the period by UTC date of
        // executedAt. This deliberately aligns to UTC so dashboards
        // across tenants in different zones display the same trend.
        // R4-P3 #2 — bounded: per-day bucketing needs the rows (Prisma can't
        // groupBy a date-truncated column without raw SQL), but the read is
        // capped so a high-volume tenant can't scan the whole run table. The
        // window is already narrow (status COMPLETED within the period).
        const completedRuns = await db.controlTestRun.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'COMPLETED',
                executedAt: { gte: periodStart, not: null },
            },
            select: { result: true, executedAt: true },
            take: 10_000,
        });

        const dayKeys: string[] = [];
        const dayIdx = new Map<string, number>();
        for (let i = validPeriod - 1; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 86_400_000);
            const key = isoDateUTC(d);
            dayIdx.set(key, dayKeys.length);
            dayKeys.push(key);
        }
        const pass = new Array(dayKeys.length).fill(0) as number[];
        const fail = new Array(dayKeys.length).fill(0) as number[];
        const inconclusive = new Array(dayKeys.length).fill(0) as number[];
        for (const r of completedRuns) {
            const at = r.executedAt as Date;
            const idx = dayIdx.get(isoDateUTC(at));
            if (idx === undefined) continue;
            if (r.result === 'PASS') pass[idx]++;
            else if (r.result === 'FAIL') fail[idx]++;
            else if (r.result === 'INCONCLUSIVE') inconclusive[idx]++;
        }

        return {
            periodDays: validPeriod,
            automation: {
                plansManual,
                plansScript,
                plansIntegration,
                plansScheduledActive,
                overdueScheduled,
            },
            upcoming,
            trend: { days: dayKeys, pass, fail, inconclusive },
        };
    });
}

// ─── helpers ───────────────────────────────────────────────────────

function isoDateUTC(d: Date): string {
    // YYYY-MM-DD in UTC — toISOString() always emits Z; slice the date.
    return d.toISOString().slice(0, 10);
}

/**
 * IANA tz validation via Intl. Avoids pulling an external timezone
 * database; the standard library already knows the canonical list
 * because it's used by `toLocaleString`.
 */
function isValidTimezone(tz: string): boolean {
    try {
        // Throws RangeError on unknown timezones.
        new Date().toLocaleString('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}
