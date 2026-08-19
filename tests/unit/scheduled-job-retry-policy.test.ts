/**
 * Cron-scheduled jobs must honour their own JOB_DEFAULTS entry.
 *
 * They did not. `registerSchedules` passed `{ name, data }` as the job
 * template with no `opts`, and BullMQ composes a scheduled job's options as:
 *
 *     Object.assign({}, this.jobsOpts, jobTemplate?.opts)   // queue.js:250
 *
 * With `opts` absent that is exactly `jobsOpts` — the queue-level
 * `defaultJobOptions`, `attempts: 3` with exponential backoff. So all 30
 * scheduled jobs ran three attempts no matter what their entry declared, and
 * the entries read as policy while being documentation.
 *
 * `enqueue()` has always applied JOB_DEFAULTS. Nothing compared the two paths,
 * which is why they could disagree for as long as they did.
 *
 * The regression this guards is silent in exactly the way the original was:
 * delete one line and 30 jobs revert to three attempts, with nothing failing.
 */
import { registerSchedules } from '@/app-layer/jobs/register-schedules';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import type { Queue } from 'bullmq';

interface Upsert {
    id: string;
    repeat: Record<string, unknown>;
    template: { name: string; data: unknown; opts?: Record<string, unknown> };
}

function fakeQueue(): { queue: Queue; calls: Upsert[] } {
    const calls: Upsert[] = [];
    const queue = {
        upsertJobScheduler: async (
            id: string,
            repeat: Record<string, unknown>,
            template: Upsert['template'],
        ) => {
            calls.push({ id, repeat, template });
        },
    } as unknown as Queue;
    return { queue, calls };
}

describe('the schedule template carries the job\'s own options', () => {
    it('passes opts for every scheduled job', async () => {
        const { queue, calls } = fakeQueue();
        await registerSchedules(queue);

        expect(calls).toHaveLength(SCHEDULED_JOBS.length);
        const missing = calls.filter((c) => !c.template.opts).map((c) => c.id);
        expect(missing).toEqual([]);
    });

    it('passes the entry that belongs to THAT job, not a shared object', async () => {
        // A single shared default would satisfy "opts is present" while giving
        // every job the same policy — which is the bug with extra steps.
        const { queue, calls } = fakeQueue();
        await registerSchedules(queue);

        for (const call of calls) {
            const expected = JOB_DEFAULTS[call.id as keyof typeof JOB_DEFAULTS];
            expect(expected).toBeDefined();
            expect(call.template.opts?.attempts).toBe(expected.attempts);
            expect(call.template.opts?.backoff).toEqual(expected.backoff);
        }
    });

    it('gives the jobs that declare a single attempt exactly one', async () => {
        // The sharp end. These are the entries whose comments say, in writing,
        // that retrying is actively harmful — NVD's rate limit, a Powerpipe
        // shell-out against live AWS, a fan-out where one blip becomes a
        // second pass over everyone's calendar. Every one of them was running
        // three attempts.
        const { queue, calls } = fakeQueue();
        await registerSchedules(queue);

        const singles = calls.filter(
            (c) => JOB_DEFAULTS[c.id as keyof typeof JOB_DEFAULTS].attempts === 1,
        );
        expect(singles.length).toBeGreaterThan(0);
        for (const c of singles) expect(c.template.opts?.attempts).toBe(1);
    });
});

describe('the two delivery paths agree', () => {
    it('every scheduled job has a JOB_DEFAULTS entry', () => {
        // `JOB_DEFAULTS[name]` would otherwise be `undefined`, which BullMQ
        // treats as "no opts" — silently restoring the old behaviour for that
        // one job while every sibling is correct. A partial fix that looks
        // total is worse than none.
        const orphans = SCHEDULED_JOBS.map((s) => s.name).filter(
            (n) => !(n in JOB_DEFAULTS),
        );
        expect(orphans).toEqual([]);
    });

    it('no scheduled job declares MORE attempts than the queue default', () => {
        // Documents the direction of the change: correcting this can only
        // reduce retry pressure, never increase it. If a future entry declares
        // 4+, that is a real escalation against a third party and should be a
        // deliberate, reviewed decision rather than a side effect of this fix.
        const louder = SCHEDULED_JOBS.map((s) => s.name).filter(
            (n) => JOB_DEFAULTS[n as keyof typeof JOB_DEFAULTS].attempts > 3,
        );
        expect(louder).toEqual([]);
    });
});
