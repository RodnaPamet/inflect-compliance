/**
 * Shared repeatable-schedule registration (item 28).
 *
 * `upsertJobScheduler` is idempotent — BullMQ deduplicates a repeatable
 * by name, so calling this any number of times converges on exactly the
 * SCHEDULED_JOBS set. That idempotency is what lets BOTH entry points
 * register safely:
 *
 *   - `scripts/scheduler.ts` — the explicit deploy-time / CLI step.
 *   - `scripts/worker.ts`    — on every worker boot, so a running worker
 *     ALWAYS implies the cron schedules exist.
 *
 * The second caller is the durable fix for the task-due-notification
 * reminders silently never firing: the deploy previously relied solely
 * on the one-shot scheduler step running before the worker
 * (`node scheduler && node worker`). If that step was skipped or the
 * VM's hand-managed compose drifted off it, the repeatable jobs were
 * never registered and the worker sat idle — nothing ever enqueued the
 * daily `task-due-notification` scan. Registering from the worker's own
 * boot removes that single point of failure: you cannot have a running
 * worker without its schedules.
 *
 * This module is the single source of truth for the upsert shape — the
 * `tz` (DST-aware cron zone) and `limit` plumbing lives here once, not
 * duplicated across the two callers.
 *
 * ═══ WHY THE TEMPLATE CARRIES `opts` ═══
 *
 * It did not, and that made every job's `JOB_DEFAULTS` entry INERT on the
 * cron path. BullMQ builds a scheduled job's options as:
 *
 *     Object.assign({}, this.jobsOpts, jobTemplate?.opts)     // queue.js
 *
 * With `opts` absent that is exactly `jobsOpts` — the queue-level
 * `defaultJobOptions`, `attempts: 3` with exponential backoff. So all 30
 * scheduled jobs ran three attempts regardless of what their entry said, and
 * the entries read as policy while being documentation.
 *
 * `enqueue()` has always applied `JOB_DEFAULTS`, which is why the two paths
 * disagreed and why the divergence was invisible: nothing compared them.
 *
 * The direction of the correction is one-way. Every entry declares FEWER
 * attempts than the queue default (1 or 2, never more), so this can only
 * reduce retry pressure — most sharply on the jobs whose entries explain, in
 * writing, that retrying them is actively harmful: NVD's rate limit, a
 * Powerpipe shell-out against live AWS, a calendar fan-out where one blip
 * becomes a second pass over everyone's calendar.
 */
import type { Queue } from 'bullmq';
import { SCHEDULED_JOBS } from './schedules';
import { JOB_DEFAULTS } from './types';

/** Minimal structural logger both pino (worker/scheduler) shapes satisfy. */
export interface ScheduleRegLogger {
    info: (obj: object, msg?: string) => void;
}

/**
 * Upsert every repeatable in {@link SCHEDULED_JOBS} onto `queue`.
 * Idempotent. Returns the number of schedules registered.
 */
export async function registerSchedules(
    queue: Queue,
    log?: ScheduleRegLogger,
): Promise<number> {
    for (const schedule of SCHEDULED_JOBS) {
        // An entry's `tz` (or the legacy `options.tz`) is passed into the
        // BullMQ repeat options so the cron `pattern` is evaluated in that
        // zone — task-due-notification fires at 08:00 local.
        const tz = schedule.tz ?? schedule.options?.tz;
        await queue.upsertJobScheduler(
            schedule.name,
            {
                pattern: schedule.pattern,
                ...(tz ? { tz } : {}),
                ...(schedule.options?.limit ? { limit: schedule.options.limit } : {}),
            },
            {
                name: schedule.name,
                data: schedule.defaultPayload,
                // Without this the entry is documentation. See the header.
                opts: JOB_DEFAULTS[schedule.name],
            },
        );
        log?.info(
            {
                jobName: schedule.name,
                pattern: schedule.pattern,
                ...(tz ? { tz } : {}),
                description: schedule.description,
            },
            'repeatable registered',
        );
    }
    return SCHEDULED_JOBS.length;
}
