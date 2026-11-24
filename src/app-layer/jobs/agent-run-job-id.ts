/**
 * The BullMQ job id of an `agent-run-execute` job (#5854 finding 2).
 *
 * ONE JOB PER RUN SEGMENT. BullMQ refuses to add a job whose id it already
 * holds (the second `add` is a no-op that returns the first), so an id derived
 * from the run makes a second enqueue of the same segment a duplicate BullMQ
 * itself drops, before any worker sees it. The enqueue sites were the only
 * thing between a run and two jobs for it, and they named no id at all.
 *
 * THE SEGMENT IS NAMED BY THE INSTANT OF THE TRANSITION THAT AUTHORISED IT, and
 * that is the choice that matters:
 *
 *   - a start: the run row's `startedAt`, written once, at its creation;
 *   - a person's resume, or a decided deferral: the row's `updatedAt` as the
 *     conditional claim that moved it back to RUNNING left it (#5119). That
 *     claim succeeds exactly once per pause, so each legitimate resume has its
 *     own instant, and a resume can never collide with an earlier segment of
 *     the same run whose job BullMQ still keeps among its completed jobs.
 *
 * A counter read off `stepCount` was rejected: a run can park twice at the same
 * step count (a guard FLAG writes no step), so a second resume would reuse the
 * first's id, BullMQ would drop the job, and the run would sit RUNNING with no
 * worker until the reaper failed it. A `Date.now()` taken at the enqueue was
 * rejected too: two enqueues of one segment would then differ, which is the
 * duplicate the id exists to refuse.
 *
 * Built by `scheduledJobId`, so the id is colon-free (#3554, #3557).
 *
 * The id only dedupes ENQUEUES. It does not stop BullMQ itself running one job
 * twice (a stalled-job redelivery, a retry while the first attempt still runs),
 * which keep the same id; the run lease (`src/lib/agentic/run-lease.ts`) is
 * what holds those to one executor.
 */
import { scheduledJobId } from './fan-out';

export function agentRunExecuteJobId(runId: string, segmentAt: Date): string {
    return scheduledJobId('agent-run', runId, segmentAt.getTime());
}
