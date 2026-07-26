/**
 * Epic G-2 — Control Test Automation Scheduler
 *
 * Repeatable BullMQ job that scans `ControlTestPlan` rows for due
 * scheduled runs and enqueues per-plan `control-test-runner` jobs.
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCAN CRITERIA
 * ═══════════════════════════════════════════════════════════════════
 *
 * A plan is considered due when ALL of:
 *   1. automationType IN (SCRIPT, INTEGRATION)  — MANUAL plans never
 *      get auto-scheduled; they appear in the scheduler scan only as
 *      noise we filter out at the DB layer.
 *   2. status = 'ACTIVE'                        — PAUSED plans skip.
 *   3. schedule IS NOT NULL                     — no cron, no auto-run.
 *   4. nextRunAt <= now OR nextRunAt IS NULL    — null = bootstrap path
 *      (compute first nextRunAt, do not enqueue this tick).
 *
 * The composite (tenantId, automationType, status) and (tenantId,
 * nextRunAt) indexes added by Epic G-2 prompt 1 keep the scan O(matches)
 * rather than O(plans).
 *
 * ═══════════════════════════════════════════════════════════════════
 * DUPLICATE-ENQUEUE PREVENTION
 * ═══════════════════════════════════════════════════════════════════
 *
 * Two complementary layers — neither alone is sufficient under
 * worker-restart edge cases.
 *
 * (1) DB OPTIMISTIC LOCK. The claim UPDATE includes the plan's
 *     stamped `nextRunAt` in its WHERE clause. If a parallel
 *     scheduler tick (same instant on a separate worker) has already
 *     advanced `nextRunAt`, our `updateMany` returns count=0 and we
 *     skip without enqueueing. The lock is the primary guarantee
 *     that one (planId, scheduledFor) pair produces at most one
 *     enqueue.
 *
 * (2) BULLMQ JOB ID. The enqueue uses
 *     `jobId = ctr:{planId}:{scheduledForIso}`. BullMQ refuses
 *     duplicate ids in the same queue, so a scheduler that crashed
 *     after the DB UPDATE but before the enqueue can retry safely:
 *     the second attempt uses the SAME jobId and BullMQ no-ops on
 *     conflict. Without this layer, retry-on-crash would double-
 *     enqueue.
 *
 * ═══════════════════════════════════════════════════════════════════
 * BOOTSTRAP PATH (`nextRunAt IS NULL`)
 * ═══════════════════════════════════════════════════════════════════
 *
 * A plan with a `schedule` but no `nextRunAt` (e.g. just-created or
 * just-given-a-schedule) is bootstrapped on the first tick that sees
 * it: we compute the first `nextRunAt` from cron-parser starting
 * "from now" and write it. We deliberately do NOT enqueue this tick
 * — the next tick will pick the plan up if due. One-tick latency is
 * a fair trade for a simpler invariant: every enqueued runner has
 * a non-null `scheduledForIso` derived from the plan's stamped
 * `nextRunAt`.
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE BOUNDARY
 * ═══════════════════════════════════════════════════════════════════
 *
 * This file does not execute the test plan. The `control-test-runner`
 * payload is wired into the type system (so this module's enqueue
 * call typechecks) but the runner executor is a forward declaration
 * for the next G-2 prompt. Until that lands, runner jobs will fail
 * with "no executor registered" — visible in metrics, expected and
 * inert.
 *
 * @module jobs/control-test-scheduler
 */
import { CronExpressionParser } from 'cron-parser';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { enqueue } from './queue';

// ─── Types ─────────────────────────────────────────────────────────

export interface ControlTestSchedulerOptions {
    tenantId?: string;
    /**
     * Override "now". Production uses real time; tests inject a
     * deterministic clock so cron-next computations are predictable.
     */
    now?: Date;
    /** Scan + log only; no DB writes, no enqueues. */
    dryRun?: boolean;
    /** Override the per-tick scan cap. Default 500. */
    batchSize?: number;
}

export interface ControlTestSchedulerResult {
    /** Total rows returned by the scan. */
    totalDue: number;
    /** Plans bootstrapped (had schedule but null nextRunAt). */
    bootstrapped: number;
    /** Plans claimed and enqueued for execution. */
    enqueued: number;
    /**
     * Plans whose claim UPDATE returned count=0 — another scheduler
     * tick already claimed this plan. Expected to be ~0 in single-
     * worker deployments; non-zero is a healthy signal in multi-
     * worker fleets, not an error.
     */
    skippedClaimRace: number;
    /** Plans whose `schedule` failed to parse — surfaced as a warn log. */
    skippedInvalidSchedule: number;
    /** Plans where enqueue threw (transient Redis/network issue). */
    enqueueFailures: number;
    dryRun: boolean;
    /** Run id for log correlation; flows through to the runner payload. */
    jobRunId: string;
}

// ─── DB Scan ───────────────────────────────────────────────────────

interface DuePlan {
    id: string;
    tenantId: string;
    schedule: string;
    scheduleTimezone: string | null;
    nextRunAt: Date | null;
}

/**
 * Find ControlTestPlan rows that are due (or null-bootstrap).
 *
 * Scoped by tenant when the option is supplied — useful for ad-hoc
 * CLI invocations and tests. Unbounded (all tenants) for the cron
 * tick.
 */
export async function findDueTestPlans(
    now: Date,
    tenantId?: string,
    batchSize = 500,
): Promise<DuePlan[]> {
    const plans = await prisma.controlTestPlan.findMany({
        where: {
            // Any ACTIVE plan carrying a cron `schedule` is due-eligible,
            // regardless of automationType. A MANUAL plan on a cadence is the
            // honest shape while no SCRIPT/INTEGRATION engine exists — each tick
            // instantiates a PLANNED "awaiting manual completion" run (the runner
            // routes MANUAL and no-handler SCRIPT/INTEGRATION plans through the
            // same manual path). The old `automationType IN (SCRIPT, INTEGRATION)`
            // filter excluded scheduled MANUAL plans entirely.
            status: 'ACTIVE',
            schedule: { not: null },
            OR: [{ nextRunAt: { lte: now } }, { nextRunAt: null }],
            ...(tenantId ? { tenantId } : {}),
        },
        select: {
            id: true,
            tenantId: true,
            schedule: true,
            scheduleTimezone: true,
            nextRunAt: true,
        },
        // NULLS FIRST — bootstrap rows (`nextRunAt IS NULL`) must be picked up
        // ahead of the backlog. Postgres sorts NULLS LAST by default, so a
        // plain `asc` buries a brand-new plan behind one tenant's due backlog
        // and it can starve indefinitely under the fleet-wide `take` cap.
        orderBy: [{ nextRunAt: { sort: 'asc', nulls: 'first' } }],
        take: batchSize,
    });

    // Re-narrow `schedule`. The WHERE clause guarantees non-null but
    // Prisma's generated type still says `string | null` because the
    // `not: null` filter is applied at runtime, not in the type
    // system.
    return plans
        .filter((p) => p.schedule !== null)
        .map((p) => ({
            id: p.id,
            tenantId: p.tenantId,
            schedule: p.schedule as string,
            scheduleTimezone: p.scheduleTimezone,
            nextRunAt: p.nextRunAt,
        }));
}

/**
 * Resolve a cron's next fire time, distinguishing the two failure modes
 * that both used to collapse to a bare `null`:
 *
 *   - `parseError: true`  — the expression is genuinely un-parseable. The
 *     plan can NEVER run until an operator fixes it; the tick escalates.
 *   - `parseError: false, next: null` — a valid cron whose iterator is
 *     exhausted (a bounded schedule past its final occurrence). This is a
 *     legitimate "nothing more to schedule", NOT a misconfiguration.
 *
 * When `rollPastInclusive` is supplied the iterator is advanced from `from`
 * along the cadence until the candidate is strictly AFTER it — used by the
 * claim path so a multi-tick outage advances from the plan's missed
 * `nextRunAt` (preserving the schedule's phase) instead of recomputing a
 * fresh "from now" instant that discards the missed cadence.
 */
function resolveNextRun(
    cron: string,
    timezone: string | null,
    from: Date,
    rollPastInclusive?: Date,
): { next: Date | null; parseError: boolean } {
    let it: ReturnType<typeof CronExpressionParser.parse>;
    try {
        it = CronExpressionParser.parse(cron, {
            currentDate: from,
            // Default to UTC explicitly — without a tz, cron-parser
            // uses the local process timezone, which would make a
            // plan with `scheduleTimezone=null` compute different
            // next-run instants depending on which worker host
            // picks it up. UTC is the contract documented at the
            // schema level (Epic G-2 prompt 1).
            tz: timezone ?? 'UTC',
        });
    } catch {
        return { next: null, parseError: true };
    }
    // Bound the roll-forward so a pathological cadence + long outage can
    // never spin unbounded within a single tick.
    const ROLL_CAP = 100_000;
    let next: Date | null = null;
    for (let i = 0; i < ROLL_CAP; i++) {
        let candidate: Date;
        try {
            candidate = it.next().toDate();
        } catch {
            // Valid cron, iterator exhausted — a legitimate "no next run",
            // NOT a parse error. Return whatever we have with parseError=false.
            break;
        }
        next = candidate;
        if (
            !rollPastInclusive ||
            candidate.getTime() > rollPastInclusive.getTime()
        ) {
            break;
        }
    }
    return { next, parseError: false };
}

/**
 * Compute the next scheduled fire time for a cron expression.
 *
 * Returns `null` when the expression is invalid OR has no further
 * occurrences — external callers only need the Date-or-null shape. The
 * scheduler tick uses {@link resolveNextRun} directly so it can tell the two
 * `null` reasons apart. We do NOT throw because one bad schedule must not
 * stop the whole tick.
 */
export function computeNextRunFromCron(
    cron: string,
    timezone: string | null,
    from: Date,
): Date | null {
    return resolveNextRun(cron, timezone, from).next;
}

// ─── Per-plan claim + enqueue ──────────────────────────────────────

/**
 * Atomic claim: advance the plan's scheduling cursor under an
 * optimistic lock keyed on the previous `nextRunAt` value.
 *
 * Returns true if the calling tick won the race for this plan and
 * should now enqueue a runner job; false if another tick already
 * claimed (no enqueue, no update).
 */
async function claimPlan(
    plan: DuePlan,
    now: Date,
    computedNextRunAt: Date,
): Promise<boolean> {
    const result = await prisma.controlTestPlan.updateMany({
        where: {
            id: plan.id,
            tenantId: plan.tenantId,
            // The optimistic lock — claim only succeeds if the row's
            // nextRunAt matches what we observed in the scan.
            nextRunAt: plan.nextRunAt,
        },
        data: {
            lastScheduledRunAt: now,
            nextRunAt: computedNextRunAt,
        },
    });
    return result.count === 1;
}

/**
 * Bootstrap path — the plan has `schedule` but `nextRunAt = null`.
 * Stamp the first nextRunAt; do not enqueue this tick.
 */
async function bootstrapPlan(
    plan: DuePlan,
    computedNextRunAt: Date,
): Promise<void> {
    await prisma.controlTestPlan.updateMany({
        where: {
            id: plan.id,
            tenantId: plan.tenantId,
            nextRunAt: null,
        },
        data: {
            nextRunAt: computedNextRunAt,
        },
    });
}

// ─── Tick entry point ──────────────────────────────────────────────

/**
 * Run a single scheduler tick.
 *
 * Wraps the scan + claim + enqueue pipeline in `runJob` for
 * structured observability — one log line on start, one on
 * completion, OTel span around the whole tick.
 */
export async function runControlTestScheduler(
    options: ControlTestSchedulerOptions = {},
): Promise<ControlTestSchedulerResult> {
    return runJob(
        'control-test-scheduler',
        async () => {
            const now = options.now ?? new Date();
            const dryRun = options.dryRun ?? false;
            const batchSize = options.batchSize ?? 500;
            const jobRunId = crypto.randomUUID();

            const plans = await findDueTestPlans(
                now,
                options.tenantId,
                batchSize,
            );

            logger.info('control-test-scheduler: scan complete', {
                component: 'control-test-scheduler',
                jobRunId,
                totalDue: plans.length,
                dryRun,
            });

            let bootstrapped = 0;
            let enqueued = 0;
            let skippedClaimRace = 0;
            let skippedInvalidSchedule = 0;
            let enqueueFailures = 0;

            for (const plan of plans) {
                // Claim path advances from the plan's MISSED `nextRunAt`
                // (rolling the cadence forward past `now`) so a multi-tick
                // outage keeps the schedule's phase instead of collapsing to a
                // fresh "from now" instant. Bootstrap has no prior instant, so
                // it computes the first occurrence from `now`.
                const { next: computedNext, parseError } =
                    plan.nextRunAt === null
                        ? resolveNextRun(plan.schedule, plan.scheduleTimezone, now)
                        : resolveNextRun(
                              plan.schedule,
                              plan.scheduleTimezone,
                              plan.nextRunAt,
                              now,
                          );

                if (parseError) {
                    // Genuinely un-parseable cron — the plan will never run
                    // until fixed. Escalate to error (distinct from the benign
                    // "no next run" case below) so it surfaces to on-call
                    // rather than dribbling a per-tick warn forever.
                    skippedInvalidSchedule++;
                    logger.error(
                        'control-test-scheduler: skipping plan with invalid schedule',
                        {
                            component: 'control-test-scheduler',
                            jobRunId,
                            planId: plan.id,
                            tenantId: plan.tenantId,
                            schedule: plan.schedule,
                        },
                    );
                    continue;
                }
                if (!computedNext) {
                    // Valid cron with no further occurrences (bounded schedule
                    // exhausted) — nothing to schedule, not a misconfiguration.
                    logger.info(
                        'control-test-scheduler: plan has no further scheduled runs',
                        {
                            component: 'control-test-scheduler',
                            jobRunId,
                            planId: plan.id,
                            tenantId: plan.tenantId,
                            schedule: plan.schedule,
                        },
                    );
                    continue;
                }

                if (dryRun) {
                    if (plan.nextRunAt === null) {
                        bootstrapped++;
                    } else {
                        enqueued++;
                    }
                    continue;
                }

                // Bootstrap path — first time this plan is being
                // scheduled. Stamp nextRunAt; let the next tick fire it.
                if (plan.nextRunAt === null) {
                    await bootstrapPlan(plan, computedNext);
                    bootstrapped++;
                    logger.info('control-test-scheduler: bootstrapped plan', {
                        component: 'control-test-scheduler',
                        jobRunId,
                        planId: plan.id,
                        tenantId: plan.tenantId,
                        nextRunAt: computedNext.toISOString(),
                    });
                    continue;
                }

                // Claim path — optimistic lock on nextRunAt.
                const claimed = await claimPlan(plan, now, computedNext);
                if (!claimed) {
                    skippedClaimRace++;
                    continue;
                }

                // Scheduled execution instant for this run — same
                // value the runner sees, same value embedded in the
                // BullMQ jobId. The toISOString() rounds to ms;
                // Postgres also stores ms precision, so the two
                // sides agree.
                const scheduledForIso = plan.nextRunAt.toISOString();

                try {
                    await enqueue(
                        'control-test-runner',
                        {
                            tenantId: plan.tenantId,
                            testPlanId: plan.id,
                            scheduledForIso,
                            schedulerJobRunId: jobRunId,
                        },
                        {
                            // Deterministic id — second-layer dedupe in
                            // case the scheduler crashes after the DB
                            // claim and BullMQ retries the tick.
                            jobId: `ctr:${plan.id}:${scheduledForIso}`,
                        },
                    );
                    enqueued++;
                } catch (err) {
                    enqueueFailures++;
                    // The DB claim already advanced `nextRunAt`, so without
                    // intervention this plan would NOT be re-claimed next tick
                    // and the run would be silently lost. Roll the claim back
                    // to the observed `nextRunAt` (guarded on the value we just
                    // wrote, so a concurrent re-advance is never clobbered) so
                    // the next tick re-claims and retries the enqueue. The
                    // retry reuses the same `ctr:{planId}:{scheduledForIso}`
                    // jobId, so a partially-delivered enqueue cannot double-fire.
                    try {
                        await prisma.controlTestPlan.updateMany({
                            where: {
                                id: plan.id,
                                tenantId: plan.tenantId,
                                nextRunAt: computedNext,
                            },
                            data: { nextRunAt: plan.nextRunAt },
                        });
                    } catch (rollbackErr) {
                        logger.error(
                            'control-test-scheduler: claim rollback failed after enqueue failure',
                            {
                                component: 'control-test-scheduler',
                                jobRunId,
                                planId: plan.id,
                                tenantId: plan.tenantId,
                                scheduledForIso,
                                err: rollbackErr instanceof Error
                                    ? rollbackErr
                                    : new Error(String(rollbackErr)),
                            },
                        );
                    }
                    // Surface the failure loudly — it is recorded in the result
                    // (`enqueueFailures`) and error-logged, never swallowed into
                    // a silent success.
                    logger.error(
                        'control-test-scheduler: enqueue failed after claim (rolled back for retry)',
                        {
                            component: 'control-test-scheduler',
                            jobRunId,
                            planId: plan.id,
                            tenantId: plan.tenantId,
                            scheduledForIso,
                            err: err instanceof Error
                                ? err
                                : new Error(String(err)),
                        },
                    );
                }
            }

            logger.info('control-test-scheduler: tick complete', {
                component: 'control-test-scheduler',
                jobRunId,
                totalDue: plans.length,
                bootstrapped,
                enqueued,
                skippedClaimRace,
                skippedInvalidSchedule,
                enqueueFailures,
                dryRun,
            });

            return {
                totalDue: plans.length,
                bootstrapped,
                enqueued,
                skippedClaimRace,
                skippedInvalidSchedule,
                enqueueFailures,
                dryRun,
                jobRunId,
            };
        },
        { tenantId: options.tenantId },
    );
}
