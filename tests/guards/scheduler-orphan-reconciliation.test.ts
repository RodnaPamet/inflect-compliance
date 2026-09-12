/**
 * GUARD — registerSchedules converges on SCHEDULED_JOBS, and its sweep cannot
 * reach a scheduler this codebase does not define (#2497).
 *
 * ═══ WHAT WENT WRONG ═══
 *
 * `register-schedules.ts` claimed in its own header that "calling this any
 * number of times converges on exactly the SCHEDULED_JOBS set". It converged on
 * a SUPERSET: the function upserted every entry and nothing enumerated existing
 * schedulers to remove ones no longer listed. So removing or renaming a
 * scheduled job left its scheduler live in Redis, firing on its old cadence
 * forever, with `scripts/worker.ts` logging "no executor registered for job —
 * skipping" every tick — 144 warn lines a day for a ten-minute job that no
 * longer exists. #2494's rollback paragraph asserted a revert needed no
 * cleanup, reasoning directly from that header.
 *
 * ═══ WHAT THIS GUARD PINS ═══
 *
 * Two assertions, and the SECOND is the load-bearing one:
 *
 *   1. an orphan — a scheduler id this app defines but no longer schedules —
 *      is removed on the next register;
 *   2. a scheduler id this app does NOT define is NOT removed, no matter that
 *      it is equally absent from SCHEDULED_JOBS.
 *
 * (2) is the whole safety argument for letting a deploy-time step issue DELETEs
 * against Redis at all. `QUEUE_NAME` scoping already means another application
 * on the same Redis is never even enumerated; the name check is what bounds the
 * blast radius in the one case queue scoping cannot cover — a second deployment
 * of this app sharing the queue name. Delete (2) and the sweep becomes "remove
 * everything I don't currently want", which is how a shared Redis loses a
 * scheduler that was never ours to touch.
 *
 * ═══ EMPTY-SELECTION NOTE ═══
 *
 * Every assertion below runs against a NON-EMPTY, hand-built scheduler
 * population, and `triage classifies a non-empty population on both sides`
 * exists solely to fail if that ever stops being true. A sweep over zero
 * schedulers removes nothing, spares everything, and would satisfy both
 * headline assertions while proving neither.
 */
import type { Queue } from 'bullmq';
import {
    registerSchedules,
    reconcileRetiredSchedulers,
    triageJobSchedulers,
} from '@/app-layer/jobs/register-schedules';
import {
    SCHEDULED_JOBS,
    RETIRED_SCHEDULED_JOB_NAMES,
} from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';

/**
 * A scheduler id belonging to something else on a shared Redis. Deliberately
 * shaped like a plausible neighbour rather than gibberish — the point is that
 * "looks like a job name" is not the test, "is one of OUR job names" is.
 */
const FOREIGN_SCHEDULER_ID = 'agrent-soil-fetch-nightly';

/**
 * A job this repo defines but deliberately does not schedule (schedules.ts:
 * "deadline-monitor, evidence-expiry-monitor and vendor-renewal-check are NOT
 * scheduled independently — they run as part of notification-dispatch to
 * prevent duplicate database scans"). A scheduler with this id is therefore
 * both recognisable and unwanted: precisely the orphan class.
 */
const ORPHAN_SCHEDULER_ID = 'deadline-monitor';

function makeQueue(preloaded: readonly string[]) {
    const schedulers = new Set<string>(preloaded);
    const removed: string[] = [];
    const queue = {
        upsertJobScheduler: async (id: string) => {
            schedulers.add(id);
        },
        // BullMQ's JobSchedulerJson carries `key` (the scheduler id, and the
        // argument removeJobScheduler takes) separately from the template
        // `name`. They are given DIFFERENT values here so a reconciliation that
        // reads `name` cannot pass by coincidence.
        getJobSchedulers: async () =>
            [...schedulers].map((key) => ({ key, name: `template:${key}` })),
        removeJobScheduler: async (id: string) => {
            removed.push(id);
            return schedulers.delete(id);
        },
    } as unknown as Queue;
    return { queue, schedulers, removed };
}

describe('GUARD: the reconciliation fixtures are what they claim', () => {
    // If these drift, every assertion below silently changes meaning — the
    // "orphan" could become a live schedule (so removing it would be a bug) or
    // the "foreign" id could become one of ours (so sparing it would be).
    it('the orphan id is defined by this repo and NOT scheduled', () => {
        expect(Object.keys(JOB_DEFAULTS)).toContain(ORPHAN_SCHEDULER_ID);
        expect(SCHEDULED_JOBS.map((s) => s.name)).not.toContain(ORPHAN_SCHEDULER_ID);
    });

    it('the foreign id is defined by neither JOB_DEFAULTS nor the retired list', () => {
        expect(Object.keys(JOB_DEFAULTS)).not.toContain(FOREIGN_SCHEDULER_ID);
        expect(RETIRED_SCHEDULED_JOB_NAMES).not.toContain(FOREIGN_SCHEDULER_ID);
    });
});

describe('GUARD: registerSchedules removes orphaned schedulers', () => {
    it('a job absent from SCHEDULED_JOBS has its scheduler removed on the next register', async () => {
        const { queue, schedulers, removed } = makeQueue([ORPHAN_SCHEDULER_ID]);

        await registerSchedules(queue);

        expect(removed).toContain(ORPHAN_SCHEDULER_ID);
        expect(schedulers.has(ORPHAN_SCHEDULER_ID)).toBe(false);
    });

    it('converges on exactly SCHEDULED_JOBS when nothing foreign is present', async () => {
        // The claim the old header made and the code did not keep. Seeded with
        // an orphan so "converged" is a real transition, not a no-op.
        const { queue, schedulers } = makeQueue([ORPHAN_SCHEDULER_ID]);

        await registerSchedules(queue);

        expect([...schedulers].sort()).toEqual(
            SCHEDULED_JOBS.map((s) => s.name).sort(),
        );
    });

    it('is idempotent — a second register neither re-removes nor drops anything', async () => {
        const { queue, schedulers, removed } = makeQueue([ORPHAN_SCHEDULER_ID]);

        await registerSchedules(queue);
        const afterFirst = [...schedulers].sort();
        removed.length = 0;

        await registerSchedules(queue);

        expect([...schedulers].sort()).toEqual(afterFirst);
        expect(removed).toEqual([]);
    });
});

describe('GUARD: the sweep cannot reach a scheduler this app does not define', () => {
    it('a foreign scheduler survives a register that removes an orphan beside it', async () => {
        // THE SAFETY ASSERTION. Both ids are absent from SCHEDULED_JOBS; only
        // the one this repo defines may be deleted. Removing the orphan in the
        // same run is what stops this passing because the sweep did nothing.
        const { queue, schedulers, removed } = makeQueue([
            FOREIGN_SCHEDULER_ID,
            ORPHAN_SCHEDULER_ID,
        ]);

        await registerSchedules(queue);

        expect(removed).toEqual([ORPHAN_SCHEDULER_ID]);
        expect(removed).not.toContain(FOREIGN_SCHEDULER_ID);
        expect(schedulers.has(FOREIGN_SCHEDULER_ID)).toBe(true);
    });

    it('reports the foreign scheduler through warn instead of deleting it', async () => {
        // Silence would make an unrecognised id indistinguishable from a job
        // this repo retired and forgot to list, which is the case an operator
        // has to act on.
        const { queue } = makeQueue([FOREIGN_SCHEDULER_ID, ORPHAN_SCHEDULER_ID]);
        const warn = jest.fn();

        await reconcileRetiredSchedulers(queue, { info: jest.fn(), warn });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toEqual({
            schedulerIds: [FOREIGN_SCHEDULER_ID],
        });
        expect(warn.mock.calls[0][1]).toContain('NOT removed');
    });

    it('a queue holding only foreign schedulers loses none of them', async () => {
        const foreign = [FOREIGN_SCHEDULER_ID, 'other-app:digest', 'bull:legacy'];
        const { queue, schedulers, removed } = makeQueue(foreign);

        await registerSchedules(queue);

        expect(removed).toEqual([]);
        for (const id of foreign) {
            expect(schedulers.has(id)).toBe(true);
        }
    });
});

describe('GUARD: triage never proposes deleting a live schedule', () => {
    it('classifies a non-empty population on both sides', () => {
        // The positive control. An empty population produces two empty lists,
        // which satisfies every "was not removed" assertion in this file
        // vacuously; this test fails if the fixtures ever stop populating both
        // branches of the classifier.
        const { remove, foreign } = triageJobSchedulers([
            ORPHAN_SCHEDULER_ID,
            FOREIGN_SCHEDULER_ID,
        ]);
        expect(remove).toEqual([ORPHAN_SCHEDULER_ID]);
        expect(foreign).toEqual([FOREIGN_SCHEDULER_ID]);
    });

    it('spares every currently scheduled name even though all are "known"', () => {
        // Each SCHEDULED_JOBS name is also a JOB_DEFAULTS key, so the
        // known-names check alone would mark all of them removable. The
        // scheduled-set check is what has to come first.
        const scheduledNames = SCHEDULED_JOBS.map((s) => s.name);
        expect(scheduledNames.length).toBeGreaterThan(0);

        const { remove, foreign } = triageJobSchedulers(scheduledNames);

        expect(remove).toEqual([]);
        expect(foreign).toEqual([]);
    });

    it('refuses to classify a blank scheduler id as removable', () => {
        const { remove, foreign } = triageJobSchedulers(['', ORPHAN_SCHEDULER_ID]);
        expect(remove).toEqual([ORPHAN_SCHEDULER_ID]);
        expect(foreign).toEqual([]);
    });
});

describe('GUARD: RETIRED_SCHEDULED_JOB_NAMES is an allowlist, not a duplicate', () => {
    it('names nothing that is still scheduled', () => {
        // triage checks the scheduled set FIRST, so a name in both lists is
        // upserted and kept — the retired entry does nothing and reads as a
        // retirement that happened. Fail on the contradiction here rather than
        // let the list rot into fiction. (Were the order reversed, the same
        // overlap would delete a live schedule on every register; this test
        // holds in either implementation, which is why it is worth having.)
        // `Set<string>`, not `Set<JobName>` — a retired name is a plain string
        // precisely because the job it names may no longer exist in JobName.
        const scheduled = new Set<string>(SCHEDULED_JOBS.map((s) => s.name));
        const overlap = RETIRED_SCHEDULED_JOB_NAMES.filter((n) => scheduled.has(n));
        expect(overlap).toEqual([]);
    });

    it('holds no duplicates and no blanks', () => {
        expect(new Set(RETIRED_SCHEDULED_JOB_NAMES).size).toBe(
            RETIRED_SCHEDULED_JOB_NAMES.length,
        );
        expect(RETIRED_SCHEDULED_JOB_NAMES.filter((n) => !n.trim())).toEqual([]);
    });
});
