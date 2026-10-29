/**
 * #3484 — the concurrent-run cap's decision, without a database.
 *
 * Every case here is a way the obvious implementation goes wrong:
 *
 *   - `cap || null` collapses 0 into "no cap", turning the one value that
 *     means "stop" into the one that means "unlimited".
 *   - `inFlight <= cap` admits one more run than the cap allows, and passes
 *     every test that only checks a tenant far from its cap.
 *   - A negative stored cap read as "unlimited" turns a typo into a bypass.
 *   - A status list that names a status the enum does not have looks correct
 *     and counts nothing.
 */
import { WorkflowRunStatus } from '@prisma/client';

import {
    CONCURRENCY_CAP_SETTING_MESSAGE,
    evaluateConcurrency,
    isSettableConcurrencyCap,
    MAX_CONCURRENCY_CAP,
    normaliseCap,
    concurrencyRefusalMessage,
    isLiveRunStatus,
    LIVE_RUN_STATUSES,
} from '@/lib/agentic/run-concurrency';

describe('normaliseCap', () => {
    it('keeps NULL and ZERO apart — they are opposite instructions', () => {
        // `cap ?? null` is right and `cap || null` is the bug: the latter turns
        // "no agentic run may start" into "no limit at all".
        expect(normaliseCap(null)).toBeNull();
        expect(normaliseCap(undefined)).toBeNull();
        expect(normaliseCap(0)).toBe(0);
    });

    it('floors a negative to ZERO, not to unlimited', () => {
        // A CHECK constraint refuses a negative at the database, so this should
        // never see one. It floors in the SAFE direction anyway: refusing runs
        // loudly beats reading a typo as "no cap".
        expect(normaliseCap(-1)).toBe(0);
        expect(normaliseCap(-9999)).toBe(0);
    });

    it('truncates a fractional cap rather than admitting a part-run', () => {
        expect(normaliseCap(2.9)).toBe(2);
    });

    it('treats a non-finite cap as no cap, and says so by returning null', () => {
        expect(normaliseCap(Number.NaN)).toBeNull();
        expect(normaliseCap(Number.POSITIVE_INFINITY)).toBeNull();
    });
});

describe('evaluateConcurrency', () => {
    it('allows everything when no cap is configured', () => {
        const v = evaluateConcurrency({ cap: null, inFlight: 1_000 });
        expect(v.allowed).toBe(true);
        // `headroom` is NULL and not a number: an unlimited tenant has no
        // headroom figure, and reporting one would invite a progress bar
        // against a denominator that does not exist.
        expect(v.headroom).toBeNull();
    });

    it('refuses AT the cap, not one past it', () => {
        // The off-by-one that `<=` produces. A tenant with 3 in flight and a
        // cap of 3 is AT the cap; a fourth is what the cap exists to prevent.
        expect(evaluateConcurrency({ cap: 3, inFlight: 2 }).allowed).toBe(true);
        expect(evaluateConcurrency({ cap: 3, inFlight: 3 }).allowed).toBe(false);
        expect(evaluateConcurrency({ cap: 3, inFlight: 4 }).allowed).toBe(false);
    });

    it('a cap of ZERO refuses the first run', () => {
        const v = evaluateConcurrency({ cap: 0, inFlight: 0 });
        expect(v.allowed).toBe(false);
        expect(v.headroom).toBe(0);
    });

    it('reports headroom, floored at zero when a tenant is over its cap', () => {
        // Over-cap is reachable: the cap can be LOWERED while runs are in
        // flight. A negative headroom would render as "-2 remaining".
        expect(evaluateConcurrency({ cap: 5, inFlight: 2 }).headroom).toBe(3);
        expect(evaluateConcurrency({ cap: 2, inFlight: 5 }).headroom).toBe(0);
    });

    it('floors a nonsense inFlight rather than trusting it', () => {
        expect(evaluateConcurrency({ cap: 1, inFlight: -3 }).inFlight).toBe(0);
    });
});

describe('concurrencyRefusalMessage', () => {
    it('names the cap, the count, and who can change it', () => {
        const msg = concurrencyRefusalMessage(
            evaluateConcurrency({ cap: 3, inFlight: 3 }),
        );
        expect(msg).toContain('3');
        expect(msg).toMatch(/administrator/i);
        // "try again later" is not actionable; this refusal has two legitimate
        // answers and the message offers both.
        expect(msg).toMatch(/wait/i);
    });

    it('a cap of zero gets its own message, and distinguishes itself from a kill switch', () => {
        // Reusing the plural message would read "already has 0 run(s) in
        // flight and its cap is 0", which tells an operator nothing about what
        // to do. And the distinction from a kill switch matters: a kill switch
        // also stops tool calls inside runs already going.
        const msg = concurrencyRefusalMessage(
            evaluateConcurrency({ cap: 0, inFlight: 0 }),
        );
        expect(msg).toMatch(/disabled/i);
        expect(msg).toMatch(/kill switch/i);
    });

    it('says nothing about the OTHER runs', () => {
        // Which workflows they are and who started them is tenant content, and
        // this message travels in an error body.
        const msg = concurrencyRefusalMessage(
            evaluateConcurrency({ cap: 1, inFlight: 1 }),
        );
        expect(msg).not.toMatch(/workflow|user|started by/i);
    });
});

describe('LIVE_RUN_STATUSES', () => {
    it('is a SUBSET of the generated WorkflowRunStatus enum', () => {
        // The control that catches a status that does not exist. The first
        // draft of this list carried `PENDING`, which sounds like a run status
        // and is not one — `WorkflowRunStatus` has no such member, so the cap
        // would have counted it and matched nothing while the list claimed
        // otherwise. Read off the GENERATED CLIENT, so the schema is the
        // authority rather than this file.
        const real = Object.keys(WorkflowRunStatus);
        for (const s of LIVE_RUN_STATUSES) expect(real).toContain(s);
    });

    it('and names every non-terminal one — the complement is exactly the terminal set', () => {
        // The other direction. A subset assertion alone passes for an EMPTY
        // list, which would make every cap unlimited.
        const real = Object.keys(WorkflowRunStatus);
        const notLive = real.filter((s) => !isLiveRunStatus(s));
        // EMPTY_CATALOGUE joined the terminal side in #3869 — a run that
        // resolved no tools is over. It reached this assertion rather than
        // slipping into the live set, which is this test doing its job: the
        // classification is deliberate, not inherited from where the value was
        // declared in the enum.
        expect(notLive.sort()).toEqual(['ABORTED', 'COMPLETED', 'EMPTY_CATALOGUE', 'FAILED']);
        expect(LIVE_RUN_STATUSES.length).toBe(real.length - notLive.length);
    });

    it('fails CLOSED on a status nobody taught it', () => {
        // A status added to the enum without being classified here must not
        // count as live: a cap that counted it would refuse tenants for a
        // state this module cannot reason about.
        expect(isLiveRunStatus('SOMETHING_NEW')).toBe(false);
    });
});

describe('isSettableConcurrencyCap (#4471)', () => {
    it('admits no cap, zero, and every whole number up to the limit', () => {
        expect(isSettableConcurrencyCap(null)).toBe(true);
        expect(isSettableConcurrencyCap(0)).toBe(true);
        expect(isSettableConcurrencyCap(7)).toBe(true);
        expect(isSettableConcurrencyCap(MAX_CONCURRENCY_CAP)).toBe(true);
    });

    it('refuses past the limit, below zero, and a fraction rather than flooring it', () => {
        expect(isSettableConcurrencyCap(MAX_CONCURRENCY_CAP + 1)).toBe(false);
        expect(isSettableConcurrencyCap(-1)).toBe(false);
        expect(isSettableConcurrencyCap(2.5)).toBe(false);
        expect(isSettableConcurrencyCap(Number.NaN)).toBe(false);
    });

    it('the refusal states the limit', () => {
        expect(MAX_CONCURRENCY_CAP).toBe(1000);
        expect(CONCURRENCY_CAP_SETTING_MESSAGE).toContain(String(MAX_CONCURRENCY_CAP));
    });
});
