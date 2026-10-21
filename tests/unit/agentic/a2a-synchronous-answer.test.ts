/**
 * THE SYNCHRONOUS ANSWER a host consumer gets (#3863): the bounded wait, and
 * the words for every way it can end.
 *
 * Both pieces are deliberately pure or seamed, so what Joule's user sees is
 * testable without a database, a clock, or a run. The reading half — which
 * column the text comes from — needs rows and lives in
 * `tests/integration/a2a-synchronous-answer.test.ts`.
 */
import {
    A2A_HOST_SYNCHRONOUS_WAIT_MS,
    awaitRunSettled,
} from '@/app-layer/usecases/a2a-synchronous-wait';
import { hostConsumerAnswerText } from '@/app-layer/usecases/a2a-run-answer';
import type { RequestContext } from '@/app-layer/types';

const RUN = 'run_abc123';

/**
 * A fake run whose status comes from a script, one entry per read. The seam
 * takes `now`/`sleep` so the test spends no real time: a wait test that slept
 * its own bound would make the suite as slow as the feature.
 */
function scripted(statuses: string[]) {
    let reads = 0;
    let clock = 0;
    const db = {
        workflowRun: {
            findFirst: async () => {
                const status = statuses[Math.min(reads, statuses.length - 1)];
                reads += 1;
                return { status };
            },
        },
    };
    const ctx = { tenantId: 't1' } as unknown as RequestContext;
    const seam = {
        now: () => clock,
        sleep: async (ms: number) => {
            clock += ms;
        },
    };
    return { ctx, db, seam, reads: () => reads };
}

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn((globalThis as unknown as { __db: unknown }).__db),
}));

const useDb = (db: unknown) => {
    (globalThis as unknown as { __db: unknown }).__db = db;
};

describe('the bounded wait', () => {
    it('returns as soon as the run settles, without spending the budget', async () => {
        const { ctx, db, seam, reads } = scripted(['RUNNING', 'RUNNING', 'COMPLETED']);
        useDb(db);
        const out = await awaitRunSettled(ctx, RUN, { ...seam, budgetMs: 10_000, pollMs: 400 });
        expect(out).toEqual({ status: 'COMPLETED', settled: true, parked: false });
        // Three reads, not twenty-five: it stopped on the answer rather than
        // polling out the window.
        expect(reads()).toBe(3);
    });

    it('gives up on the clock and reports the last status it saw', async () => {
        const { ctx, db, seam } = scripted(['RUNNING']);
        useDb(db);
        const out = await awaitRunSettled(ctx, RUN, { ...seam, budgetMs: 1_000, pollMs: 400 });
        expect(out).toEqual({ status: 'RUNNING', settled: false, parked: false });
    });

    it('stops AT ONCE when the run parks on a person, rather than waiting out the budget', async () => {
        // The behaviour that replaces mapping to `input-required`: waiting ten
        // seconds for a human approval is futile, and spending the budget on it
        // delays the response for nothing.
        const { ctx, db, seam, reads } = scripted(['AWAITING_APPROVAL']);
        useDb(db);
        const out = await awaitRunSettled(ctx, RUN, { ...seam, budgetMs: 10_000, pollMs: 400 });
        expect(out).toEqual({ status: 'AWAITING_APPROVAL', settled: false, parked: true });
        expect(reads()).toBe(1);
    });

    it('treats PAUSED as parked too, not as still-running', async () => {
        const { ctx, db, seam } = scripted(['PAUSED']);
        useDb(db);
        expect(await awaitRunSettled(ctx, RUN, { ...seam, budgetMs: 10_000 })).toMatchObject({ parked: true });
    });

    it('reads at least once even with a zero budget', async () => {
        // The deadline is checked AFTER the read, so a caller passing 0 gets the
        // current status rather than an invented default.
        const { ctx, db, seam, reads } = scripted(['COMPLETED']);
        useDb(db);
        const out = await awaitRunSettled(ctx, RUN, { ...seam, budgetMs: 0 });
        expect(out.settled).toBe(true);
        expect(reads()).toBe(1);
    });

    it('reports FAILED and ABORTED as settled', async () => {
        for (const status of ['FAILED', 'ABORTED']) {
            const { ctx, db, seam } = scripted([status]);
            useDb(db);
            expect(await awaitRunSettled(ctx, RUN, { ...seam, budgetMs: 1_000 })).toEqual({
                status,
                settled: true,
                parked: false,
            });
        }
    });

    it('survives a run it cannot read, reporting a status rather than throwing', async () => {
        useDb({ workflowRun: { findFirst: async () => null } });
        const ctx = { tenantId: 't1' } as unknown as RequestContext;
        let clock = 0;
        const out = await awaitRunSettled(ctx, RUN, {
            now: () => clock,
            sleep: async (ms: number) => {
                clock += ms;
            },
            budgetMs: 800,
        });
        expect(out.settled).toBe(false);
        expect(typeof out.status).toBe('string');
    });

    it('bounds the wait well inside the 30s SAP scaffold convention', () => {
        // The assumption documented in the module header, asserted so a later
        // raise is a deliberate diff rather than a drift: overshooting the
        // caller's limit turns a `working` answer into a timeout at the caller,
        // which loses the task id a follow-up needs.
        expect(A2A_HOST_SYNCHRONOUS_WAIT_MS).toBeLessThanOrEqual(15_000);
        expect(A2A_HOST_SYNCHRONOUS_WAIT_MS).toBeGreaterThan(0);
    });
});

describe('the words a host consumer is given', () => {
    const settled = (status: string) => ({ status, settled: true, parked: false });

    it('a completed run returns the answer itself', () => {
        const text = hostConsumerAnswerText(settled('COMPLETED'), 'Two documents breach CTL-SOD-01.', RUN);
        expect(text).toBe('Two documents breach CTL-SOD-01.');
    });

    it('a completed run with no recorded narrative says so, rather than answering emptily', () => {
        const text = hostConsumerAnswerText(settled('COMPLETED'), null, RUN);
        expect(text).toMatch(/recorded no written findings/i);
        // The failure this blocks: an empty answer reads as "nothing was found",
        // which is a finding nobody made.
        expect(text).not.toBe('');
    });

    it('a FAILED run is human-readable, names no internals, and says nothing changed', () => {
        const text = hostConsumerAnswerText(settled('FAILED'), null, RUN);
        expect(text).toMatch(/could not be completed/i);
        expect(text).toMatch(/nothing was changed/i);
        expect(text).toContain(RUN);
    });

    it('an ABORTED run says it was stopped, not that it failed', () => {
        const text = hostConsumerAnswerText(settled('ABORTED'), null, RUN);
        expect(text).toMatch(/stopped before it finished/i);
        expect(text).not.toMatch(/could not be completed/i);
    });

    it('an unrecognised terminal status is not reported as a result', () => {
        const text = hostConsumerAnswerText(settled('SOMETHING_NEW'), null, RUN);
        expect(text).toMatch(/does not recognise/i);
    });

    it('a parked run names WHO must act, and that the caller cannot', () => {
        // This is what stands in place of `input-required`. The state code would
        // have told Joule the CALLER must supply something; the words say the
        // opposite, which is the truth.
        const text = hostConsumerAnswerText({ status: 'AWAITING_APPROVAL', settled: false, parked: true }, null, RUN);
        expect(text).toMatch(/person in the Inflect workspace/i);
        expect(text).toMatch(/nobody outside that workspace/i);
        expect(text).toContain(RUN);
    });

    it('a still-running run hands back the task id to ask again with', () => {
        const text = hostConsumerAnswerText({ status: 'RUNNING', settled: false, parked: false }, null, RUN);
        expect(text).toMatch(/still running/i);
        expect(text).toContain(RUN);
    });

    it('never leaks an internal error string, in any arm', () => {
        // A run's `errorMessage` is written for an operator and can name a tool,
        // a column or a guard rule id. None of the arms forwards it, and this
        // asserts the whole surface rather than one case.
        const arms = [
            hostConsumerAnswerText(settled('COMPLETED'), null, RUN),
            hostConsumerAnswerText(settled('FAILED'), null, RUN),
            hostConsumerAnswerText(settled('ABORTED'), null, RUN),
            hostConsumerAnswerText({ status: 'RUNNING', settled: false, parked: false }, null, RUN),
            hostConsumerAnswerText({ status: 'PAUSED', settled: false, parked: true }, null, RUN),
        ];
        for (const text of arms) {
            expect(text).not.toMatch(/stack|Error:|at Object|prisma|undefined|null/i);
        }
    });

    it('every arm returns non-empty words', () => {
        // The denominator: an arm returning '' would satisfy most assertions
        // above by vacuity.
        for (const status of ['COMPLETED', 'FAILED', 'ABORTED', 'WEIRD']) {
            expect(hostConsumerAnswerText(settled(status), null, RUN).length).toBeGreaterThan(20);
        }
    });
});
