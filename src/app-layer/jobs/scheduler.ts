/**
 * Scheduler — Platform-Agnostic Job Scheduler
 *
 * Provides a unified scheduling entrypoint that works across:
 *   - BullMQ (production: Redis-backed, repeatable jobs)
 *   - node-cron (self-hosted: in-process cron scheduler)
 *   - Vercel Cron / API route (serverless: HTTP-triggered)
 *   - Direct invocation (CLI scripts, tests)
 *
 * This module is the app-layer scheduling foundation. It does NOT
 * depend on any specific scheduling backend — it delegates to the
 * executor registry for job dispatch and provides cadence management.
 *
 * ═══════════════════════════════════════════════════════════════════
 * Architecture
 * ═══════════════════════════════════════════════════════════════════
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │              Scheduler (this module)                 │
 *   │                                                       │
 *   │  ┌─────────────┐  ┌───────────────┐  ┌────────────┐ │
 *   │  │ runOnce()   │  │ runAll()      │  │ tick()     │ │
 *   │  │ Execute one │  │ Execute all   │  │ Evaluate   │ │
 *   │  │ named job   │  │ scheduled     │  │ which jobs │ │
 *   │  │             │  │ jobs now      │  │ are due    │ │
 *   │  └──────┬──────┘  └──────┬────────┘  └─────┬──────┘ │
 *   │         │                │                  │        │
 *   │         └────────────────┴──────────────────┘        │
 *   │                         │                            │
 *   │              ┌──────────▼──────────┐                 │
 *   │              │ ExecutorRegistry    │                 │
 *   │              │ .execute(name, ...) │                 │
 *   │              └─────────────────────┘                 │
 *   └───────────────────────────────────────────────────────┘
 *
 * Usage:
 *   // Vercel Cron / API route handler:
 *   import { scheduler } from '@/app-layer/jobs/scheduler';
 *   const result = await scheduler.runOnce('daily-evidence-expiry', {});
 *
 *   // Run all scheduled jobs (useful for manual catch-up):
 *   const results = await scheduler.runAll();
 *
 *   // Tick-based evaluation (for node-cron wrapper):
 *   const results = await scheduler.tick();
 *
 * @module app-layer/jobs/scheduler
 */
import { logger } from '@/lib/observability/logger';
import { executorRegistry } from './executor-registry';
import { SCHEDULED_JOBS, type ScheduleDefinition } from './schedules';
import type { JobName, JobPayload, JobRunResult } from './types';

// ─── Cron Pattern Evaluation ────────────────────────────────────────

/**
 * Lightweight cron pattern matcher.
 * Evaluates whether a 5-part cron pattern matches a given Date.
 *
 * Supports: exact numbers, `*`, `*\/N` (step), comma-separated lists.
 * Does NOT support day-of-week names, month names, or `L`/`W`/`#`.
 *
 * This is intentionally minimal — just enough for tick() evaluation
 * without pulling in a full cron library dependency.
 */
/**
 * Per-field minimum value, used to anchor `*\/N` steps correctly. Cron's
 * `*\/N` means "every N starting from the field's minimum", so day-of-month
 * (min 1) and month (min 1) must NOT be anchored at 0 like minute/hour/dow.
 * Order matches `fields` below: minute, hour, day, month, day-of-week.
 */
const FIELD_MINS = [0, 0, 1, 1, 0] as const;

const WEEKDAY_INDEX: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * The cron fields (minute, hour, day, month, day-of-week) for `now` as seen
 * in the given IANA timezone. The BullMQ path evaluates each schedule's cron
 * in its configured `tz`; the tick() path must agree, or the two entry points
 * fire a schedule at different wall-clock times.
 */
function cronFieldsInTz(now: Date, tz: string): number[] {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        minute: '2-digit',
        hour: '2-digit',
        day: '2-digit',
        month: '2-digit',
        weekday: 'short',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return [
        Number(get('minute')),
        Number(get('hour')),
        Number(get('day')),
        Number(get('month')),
        WEEKDAY_INDEX[get('weekday')] ?? 0,
    ];
}

export function cronMatchesNow(
    pattern: string,
    now: Date = new Date(),
    tz?: string,
): boolean {
    const parts = pattern.split(' ');
    if (parts.length < 5) return false;

    // Honour the schedule's timezone (matching the BullMQ evaluator); default
    // to UTC when none is set.
    const fields =
        tz && tz !== 'UTC'
            ? cronFieldsInTz(now, tz)
            : [
                  now.getUTCMinutes(), // 0: minute
                  now.getUTCHours(), // 1: hour
                  now.getUTCDate(), // 2: day of month
                  now.getUTCMonth() + 1, // 3: month (1-12)
                  now.getUTCDay(), // 4: day of week (0-6, 0=Sunday)
              ];

    for (let i = 0; i < 5; i++) {
        if (!fieldMatches(parts[i], fields[i], FIELD_MINS[i])) return false;
    }
    return true;
}

function fieldMatches(expr: string, value: number, min: number): boolean {
    if (expr === '*') return true;

    // Handle comma-separated alternatives: "1,15,30"
    if (expr.includes(',')) {
        return expr.split(',').some(sub => fieldMatches(sub.trim(), value, min));
    }

    // Handle step: "*/15". Anchored at the field's minimum, NOT 0 — otherwise
    // `*/2` on day-of-month (min 1) matches 2,4,6,… instead of 1,3,5,….
    if (expr.startsWith('*/')) {
        const step = parseInt(expr.slice(2), 10);
        return !isNaN(step) && step > 0 && (value - min) % step === 0;
    }

    // Handle range: "1-5"
    if (expr.includes('-')) {
        const [rangeMin, rangeMax] = expr.split('-').map(s => parseInt(s, 10));
        return !isNaN(rangeMin) && !isNaN(rangeMax) && value >= rangeMin && value <= rangeMax;
    }

    // Exact match
    const num = parseInt(expr, 10);
    return !isNaN(num) && value === num;
}

// ─── Scheduler Run Results ──────────────────────────────────────────

export interface SchedulerRunSummary {
    /** ISO timestamp of when the scheduler tick started */
    startedAt: string;
    /** ISO timestamp of when the scheduler tick finished */
    completedAt: string;
    /** Total duration of the tick in ms */
    durationMs: number;
    /** Number of jobs that were evaluated */
    jobsEvaluated: number;
    /** Number of jobs that executed */
    jobsExecuted: number;
    /** Number of jobs that succeeded */
    jobsSucceeded: number;
    /** Number of jobs that failed */
    jobsFailed: number;
    /** Per-job results */
    results: JobRunResult[];
}

// ─── Scheduler Implementation ───────────────────────────────────────

export const scheduler = {
    /**
     * Execute a single named job with its payload.
     *
     * Use this from Vercel Cron routes, API endpoints, or CLI scripts
     * when you want to run exactly one job.
     *
     * @example
     *   // In a Vercel Cron route handler:
     *   const result = await scheduler.runOnce('daily-evidence-expiry', {});
     *   return Response.json(result);
     */
    async runOnce<T extends JobName>(
        name: T,
        payload: JobPayload<T>,
    ): Promise<JobRunResult> {
        logger.info('scheduler: runOnce', {
            component: 'scheduler',
            jobName: name,
        });

        const result = await executorRegistry.execute(name, payload);

        logger.info('scheduler: runOnce completed', {
            component: 'scheduler',
            jobName: name,
            success: result.success,
            durationMs: result.durationMs,
            itemsScanned: result.itemsScanned,
            itemsActioned: result.itemsActioned,
        });

        return result;
    },

    /**
     * Execute all registered scheduled jobs sequentially.
     *
     * Use this for manual catch-up, initial bootstrap, or testing.
     * Jobs run sequentially to avoid resource contention.
     * A failure in one job does NOT prevent subsequent jobs from running.
     */
    async runAll(): Promise<SchedulerRunSummary> {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const results: JobRunResult[] = [];

        logger.info('scheduler: runAll started', {
            component: 'scheduler',
            scheduledJobs: SCHEDULED_JOBS.length,
        });

        for (const schedule of SCHEDULED_JOBS) {
            const result = await executorRegistry.execute(
                schedule.name,
                schedule.defaultPayload as JobPayload<typeof schedule.name>,
            );
            results.push(result);
        }

        const durationMs = Math.round(performance.now() - startMs);
        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        logger.info('scheduler: runAll completed', {
            component: 'scheduler',
            durationMs,
            jobsExecuted: results.length,
            succeeded,
            failed,
        });

        return {
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            jobsEvaluated: SCHEDULED_JOBS.length,
            jobsExecuted: results.length,
            jobsSucceeded: succeeded,
            jobsFailed: failed,
            results,
        };
    },

    /**
     * Evaluate which scheduled jobs are due NOW and execute them.
     *
     * This is the entrypoint for a node-cron or setInterval-based
     * scheduler that fires every minute. It evaluates each job's
     * cron pattern against the current UTC time and runs only the
     * matching jobs.
     *
     * @param now — override current time (for testing)
     *
     * @example
     *   // In a node-cron minute ticker:
     *   cron.schedule('* * * * *', () => scheduler.tick());
     */
    async tick(now?: Date): Promise<SchedulerRunSummary> {
        const currentTime = now ?? new Date();
        const startedAt = currentTime.toISOString();
        const startMs = performance.now();
        const results: JobRunResult[] = [];
        let evaluated = 0;

        for (const schedule of SCHEDULED_JOBS) {
            evaluated++;
            // Evaluate the cron in the schedule's configured timezone so the
            // tick() path agrees with the BullMQ path (which honours `tz`).
            if (!cronMatchesNow(schedule.pattern, currentTime, schedule.tz)) continue;

            logger.info('scheduler: tick — job is due', {
                component: 'scheduler',
                jobName: schedule.name,
                pattern: schedule.pattern,
            });

            const result = await executorRegistry.execute(
                schedule.name,
                schedule.defaultPayload as JobPayload<typeof schedule.name>,
            );
            results.push(result);
        }

        const durationMs = Math.round(performance.now() - startMs);
        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        if (results.length > 0) {
            logger.info('scheduler: tick completed', {
                component: 'scheduler',
                durationMs,
                evaluated,
                executed: results.length,
                succeeded,
                failed,
            });
        }

        return {
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            jobsEvaluated: evaluated,
            jobsExecuted: results.length,
            jobsSucceeded: succeeded,
            jobsFailed: failed,
            results,
        };
    },

    /**
     * Get the list of schedule definitions (read-only).
     */
    getSchedules(): readonly ScheduleDefinition[] {
        return SCHEDULED_JOBS;
    },

    /**
     * Check if all scheduled jobs have registered executors.
     * Useful for startup validation / health checks.
     */
    validateRegistrations(): { valid: boolean; missing: string[] } {
        const missing = SCHEDULED_JOBS
            .filter(s => !executorRegistry.has(s.name))
            .map(s => s.name);
        return { valid: missing.length === 0, missing };
    },
};
