/**
 * GROUPING A RUN'S STEPS INTO ITS DELEGATIONS (#3473 part 3).
 *
 * The owner's decision was to group by SEQUENCE with a delegation step marking
 * the span. This is the rule, in one place, so the run detail renders it rather
 * than deriving it inside a `.map()`.
 *
 * ── WHAT IS ACTUALLY AT STAKE ───────────────────────────────────────────────
 *
 * The steps in a span are the PARENT's rows. A delegate runs the parent's own
 * tool objects, so every read it makes lands in the parent's ledger with the
 * parent's seq — which is what charges them to the parent's budget, and is why
 * the span is the only thing that says whose work they were.
 *
 * So a wrong span attributes a specialist's work to the parent, or the
 * parent's to a specialist. On a governance surface that is the error that
 * matters, which is why overlap is REPORTED rather than tie-broken.
 */
import { delegationSpans, delegatesClaiming, type SpannableStep } from '@/lib/agentic/delegation-spans';

const step = (seq: number, over: Partial<SpannableStep> = {}): SpannableStep => ({
    seq,
    costTokens: null,
    delegation: null,
    ...over,
});

const marker = (seq: number, agent: string, fromSeq: number | null): SpannableStep =>
    step(seq, { delegation: { agent, taskId: `task_${agent}_${seq}`, fromSeq } });

describe('a run with no delegation', () => {
    it('has no spans, and says so by being empty', () => {
        expect(delegationSpans([step(0), step(1), step(2)])).toEqual([]);
    });

    it('claims no step', () => {
        const steps = [step(0), step(1)];
        expect(delegatesClaiming(delegationSpans(steps), steps[0])).toEqual([]);
    });
});

describe('one delegation', () => {
    //   seq 0  parent read
    //   seq 1  delegate read     <- fromSeq = 0, marker at 3
    //   seq 2  delegate read
    //   seq 3  the marker
    //   seq 4  parent read
    const steps = [
        step(0, { costTokens: 10 }),
        step(1, { costTokens: 100 }),
        step(2, { costTokens: 200 }),
        marker(3, 'evidence_assessor', 0),
        step(4, { costTokens: 20 }),
    ];

    it('takes the steps strictly BETWEEN the bounds', () => {
        // Strictly: the step AT `fromSeq` is the parent's last before
        // delegating, and the marker is the delegation itself. Including
        // either would attribute a parent step to the delegate.
        const [span] = delegationSpans(steps);
        expect(span.steps.map((s) => s.seq)).toEqual([1, 2]);
        expect(span.agent).toBe('evidence_assessor');
        expect(span.marker.seq).toBe(3);
        expect(span.overlapping).toBe(false);
    });

    it('sums the tokens inside the span and nothing outside it', () => {
        // 100 + 200. The parent's 10 and 20 are its own, and a rollup that
        // swept them would make a delegate look more expensive than it was —
        // which is the number an operator would act on.
        expect(delegationSpans(steps)[0].costTokens).toBe(300);
    });

    it('marks the steps it claims, and only those', () => {
        const spans = delegationSpans(steps);
        expect(delegatesClaiming(spans, steps[1])).toEqual(['evidence_assessor']);
        expect(delegatesClaiming(spans, steps[0])).toEqual([]);
        expect(delegatesClaiming(spans, steps[4])).toEqual([]);
    });
});

describe('two delegations, one after the other', () => {
    const steps = [
        step(0, { costTokens: 5 }),
        step(1, { costTokens: 50 }),
        marker(2, 'risk_analyst', 0),
        step(3, { costTokens: 70 }),
        marker(4, 'policy_drafter', 2),
    ];

    it('separates them, and neither claims the other\'s steps', () => {
        const spans = delegationSpans(steps);
        expect(spans.map((s) => s.agent)).toEqual(['risk_analyst', 'policy_drafter']);
        expect(spans[0].steps.map((s) => s.seq)).toEqual([1]);
        expect(spans[1].steps.map((s) => s.seq)).toEqual([3]);
        expect(spans.every((s) => !s.overlapping)).toBe(true);
    });

    it('rolls each one up on its own', () => {
        const spans = delegationSpans(steps);
        expect([spans[0].costTokens, spans[1].costTokens]).toEqual([50, 70]);
    });
});

describe('two delegations that overlap', () => {
    // Concurrent fan-out: both started at seq 0, both finished later, so the
    // steps between belong to both as far as the ledger can say.
    const steps = [
        step(0),
        step(1, { costTokens: 40 }),
        step(2, { costTokens: 60 }),
        marker(3, 'risk_analyst', 0),
        marker(4, 'vendor_reviewer', 0),
    ];

    it('reports the overlap rather than tie-breaking it', () => {
        // THE DECISION THIS ENCODES. Assigning each step to one delegation by
        // some rule would invent a precision the ledger does not have, and the
        // invented half would be a specialist credited with work it did not do.
        const spans = delegationSpans(steps);
        expect(spans.every((s) => s.overlapping)).toBe(true);
    });

    it('lets a step belong to BOTH, and names both', () => {
        const spans = delegationSpans(steps);
        expect(delegatesClaiming(spans, steps[1]).sort())
            .toEqual(['risk_analyst', 'vendor_reviewer']);
    });

    it('counts the shared tokens in both rollups, which is what overlap MEANS', () => {
        // Deliberate, and the reason `overlapping` is on the span: the two
        // figures do not sum to the run's total, and a reader has to be told
        // why rather than left to discover it.
        const spans = delegationSpans(steps);
        expect([spans[0].costTokens, spans[1].costTokens]).toEqual([100, 100]);
    });
});

describe('a delegation with no recorded bound', () => {
    const steps = [step(0, { costTokens: 9 }), marker(1, 'risk_analyst', null)];

    it('is still reported, with no steps claimed', () => {
        // `fromSeq` is null when the driver supplied no counter — a run bound
        // by a test or a caller predating delegation. The delegation HAPPENED,
        // so it is listed; what is unknown is which steps were its own.
        const [span] = delegationSpans(steps);
        expect(span.agent).toBe('risk_analyst');
        expect(span.fromSeq).toBeNull();
        expect(span.steps).toEqual([]);
    });

    it('claims no tokens rather than claiming the run\'s', () => {
        // The failure this avoids: an unbounded span sweeping every earlier
        // step would report the whole run's spend as one delegate's.
        expect(delegationSpans(steps)[0].costTokens).toBeNull();
    });
});

describe('tokens: unreported is not zero', () => {
    it('a span whose steps report nothing has a NULL rollup', () => {
        // The same convention `RunStepFeedRow.costTokens` follows: a delegate
        // whose model calls went unreported and one that spent nothing must not
        // read the same.
        const steps = [step(0), step(1), marker(2, 'risk_analyst', 0)];
        expect(delegationSpans(steps)[0].costTokens).toBeNull();
    });

    it('a span with one reported step sums only what was reported', () => {
        const steps = [step(0), step(1, { costTokens: 12 }), step(2), marker(3, 'risk_analyst', 0)];
        expect(delegationSpans(steps)[0].costTokens).toBe(12);
    });
});
