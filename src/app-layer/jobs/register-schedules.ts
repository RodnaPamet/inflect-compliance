/**
 * Shared repeatable-schedule registration (item 28).
 *
 * `upsertJobScheduler` is idempotent — BullMQ deduplicates a scheduler by its
 * id — so calling this any number of times ADDS every SCHEDULED_JOBS entry
 * exactly once. That idempotency is what lets BOTH entry points register
 * safely:
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
 * ═══ WHAT THIS CONVERGES ON, AND WHAT IT DOES NOT (#2497) ═══
 *
 * Upserting alone converges on a SUPERSET of SCHEDULED_JOBS, never on the set
 * itself. The header used to claim the set, and that claim is what the rollback
 * paragraph of #2494 reasoned from when it said a revert needed no cleanup. It
 * did: removing or renaming an entry leaves the old scheduler LIVE IN REDIS,
 * firing on its old cadence forever, and `scripts/worker.ts` answers every tick
 * with "no executor registered for job — skipping". A ten-minute job becomes
 * 144 warn lines a day from code that no longer exists.
 *
 * {@link reconcileRetiredSchedulers} closes that gap, but only as far as it can
 * do so SAFELY, so state the post-condition precisely:
 *
 *     after a successful run, the queue's schedulers are
 *         SCHEDULED_JOBS  ∪  {live schedulers this app does not recognise}
 *
 * The second term is the deliberate residue. See {@link triageJobSchedulers}
 * for why it is not swept, and `RETIRED_SCHEDULED_JOB_NAMES` in `schedules.ts`
 * for how a name moves out of it.
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
import { SCHEDULED_JOBS, RETIRED_SCHEDULED_JOB_NAMES } from './schedules';
import { JOB_DEFAULTS } from './types';

/** Minimal structural logger both pino (worker/scheduler) shapes satisfy. */
export interface ScheduleRegLogger {
    info: (obj: object, msg?: string) => void;
    /**
     * Optional so the pre-existing `{ info }` call sites keep compiling. Both
     * real callers are pino and do have it; the reconciliation reports through
     * it, so a logger without `warn` simply reconciles silently.
     */
    warn?: (obj: object, msg?: string) => void;
    /** Optional, same reason. Used only for a failed (non-fatal) sweep. */
    error?: (obj: object, msg?: string) => void;
}

/**
 * The scheduler ids this app is willing to delete, split from the ones it is
 * not.
 *
 * ═══ THE SAFETY ARGUMENT (#2497) ═══
 *
 * A blind sweep — "remove every scheduler not in SCHEDULED_JOBS" — is the
 * obvious implementation and the wrong one, because the Redis instance may be
 * shared. Two scopes keep this deletion honest, and they are independent:
 *
 * 1. QUEUE SCOPE, free. `queue.getJobSchedulers()` reads only the scheduler set
 *    of the queue it is called on, and `QUEUE_NAME` is the hard-coded
 *    `'inflect-jobs'`. A DIFFERENT APPLICATION sharing this Redis uses its own
 *    queue name, so its schedulers are not merely spared — they are never
 *    enumerated here at all. This scope is absolute and needs no list.
 *
 * 2. NAME SCOPE, this function. What queue scope does NOT cover is a second
 *    deployment of THIS app pointed at the same Redis, because it shares the
 *    queue name. So a scheduler id is removable only when the id is one this
 *    codebase itself defines — a `JOB_DEFAULTS` key (which is
 *    `Record<JobName, …>`, so tsc keeps it exhaustive over every job that
 *    exists) or an explicitly retired name. Anything else is FOREIGN: reported,
 *    never removed.
 *
 * Be clear about what scope 2 does and does not buy in that second-deployment
 * case. It does NOT make the case safe — two deployments sharing one queue name
 * share the JOB QUEUE ITSELF, so each one's workers already consume the other's
 * jobs and already log "no executor registered" for anything they lack. That
 * configuration is broken before any sweep runs, and this function cannot
 * repair it. What scope 2 buys is that the blast radius of a sweep in that
 * already-broken state is bounded by names in THIS repository, and can never
 * reach a third party's scheduler.
 *
 * The `remove` list is therefore an allowlist intersection, not a complement:
 * grow it by naming a job in `RETIRED_SCHEDULED_JOB_NAMES`, not by failing to
 * recognise something.
 *
 * Pure and exported so the guard can drive it with populations a live Redis
 * would not hand us — in particular a non-empty one, since a sweep over zero
 * schedulers removes nothing and proves nothing.
 *
 * @param liveSchedulerIds scheduler ids as returned in `JobSchedulerJson.key`
 *        (the id passed to `upsertJobScheduler`, which is also what
 *        `removeJobScheduler` takes — NOT the job-template `name`).
 */
export function triageJobSchedulers(liveSchedulerIds: readonly string[]): {
    /** Recognised, no longer scheduled — safe to delete. */
    remove: string[];
    /** Not recognised by this codebase — left alone, reported. */
    foreign: string[];
} {
    const scheduled = new Set<string>(SCHEDULED_JOBS.map((s) => s.name));
    const known = new Set<string>([
        ...Object.keys(JOB_DEFAULTS),
        ...RETIRED_SCHEDULED_JOB_NAMES,
    ]);

    const remove: string[] = [];
    const foreign: string[] = [];
    for (const id of liveSchedulerIds) {
        if (!id) continue;               // defensive: a malformed key is not ours to delete
        if (scheduled.has(id)) continue; // still wanted — the upsert above just refreshed it
        if (known.has(id)) remove.push(id);
        else foreign.push(id);
    }
    return { remove, foreign };
}

/**
 * Delete the schedulers {@link triageJobSchedulers} marks removable.
 *
 * FAILURE DIRECTION, deliberately fail-OPEN: every error here is swallowed and
 * logged, and the orphan schedulers SURVIVE. That is the quiet direction, and
 * it is the right one only because of what the two directions cost. Failing
 * open costs exactly what the bug already costs — an orphan keeps firing and
 * the worker keeps logging "no executor registered". Failing closed would
 * propagate out of {@link registerSchedules} AFTER its upserts have already
 * succeeded, and `scripts/worker.ts` would then log "cron jobs may not fire
 * until the scheduler step runs" about schedules that were in fact registered
 * seconds earlier. Trading real log noise for a false alarm about the thing
 * this module exists to guarantee is a bad trade.
 *
 * This is not hypothetical plumbing. `getJobSchedulers()` THROWS on a legacy
 * BullMQ repeatable key (`getLegacyRepeatableJobError`, job-scheduler.js), so a
 * single pre-v5 leftover in a shared Redis would otherwise take down schedule
 * registration on every worker boot.
 *
 * @returns the number of schedulers actually removed — 0 on failure.
 */
export async function reconcileRetiredSchedulers(
    queue: Queue,
    log?: ScheduleRegLogger,
): Promise<number> {
    let live: Awaited<ReturnType<Queue['getJobSchedulers']>>;
    try {
        live = await queue.getJobSchedulers();
    } catch (err) {
        log?.error?.(
            { err: err instanceof Error ? err.message : String(err) },
            'could not enumerate job schedulers — retired schedules left in place',
        );
        return 0;
    }

    const { remove, foreign } = triageJobSchedulers(live.map((s) => s.key));

    let removed = 0;
    for (const id of remove) {
        try {
            await queue.removeJobScheduler(id);
            removed += 1;
            log?.info({ jobName: id }, 'retired schedule removed');
        } catch (err) {
            log?.error?.(
                { jobName: id, err: err instanceof Error ? err.message : String(err) },
                'failed to remove retired schedule — it will keep firing until the next run',
            );
        }
    }

    if (foreign.length > 0) {
        // NOT an error on this side of the fence: an unrecognised scheduler may
        // legitimately belong to something else on a shared Redis. It is a warn
        // because the other possibility — a job this repo removed WITHOUT
        // listing it in RETIRED_SCHEDULED_JOB_NAMES — looks identical from here
        // and is the case an operator must act on.
        log?.warn?.(
            { schedulerIds: foreign },
            'unrecognised job schedulers on this queue — NOT removed; if one is a job this app retired, add its name to RETIRED_SCHEDULED_JOB_NAMES',
        );
    }

    return removed;
}

/**
 * Upsert every repeatable in {@link SCHEDULED_JOBS} onto `queue`, then delete
 * the schedulers this app recognises but no longer schedules.
 *
 * Idempotent. Returns the number of schedules registered — the removal count is
 * deliberately NOT folded into it, because both callers log this number as
 * "repeatable schedules registered" and it must keep meaning that.
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

    // AFTER the upserts, never before. The sweep spares anything in
    // SCHEDULED_JOBS, so the order cannot change which ids it deletes — but
    // running it second means a wanted schedule is present in Redis for the
    // whole window rather than briefly absent if the process dies mid-run.
    await reconcileRetiredSchedulers(queue, log);

    return SCHEDULED_JOBS.length;
}
