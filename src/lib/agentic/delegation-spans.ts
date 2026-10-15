/**
 * THE DELEGATIONS IN A RUN, AND THE STEPS EACH ONE PRODUCED (#3473 part 3).
 *
 * PURE, so the grouping is testable without rendering a timeline — and so the
 * rule lives in one place rather than inside a `.map()` in a client component.
 *
 * ## The shape of the evidence
 *
 * A delegation is a `TOOL_CALL` step naming `task`, recorded when the
 * delegation COMPLETED. Its `delegation.fromSeq` is the seq the ledger stood
 * at when the delegation started, captured before the runtime was handed
 * control; its own `seq` is where it finished. So the steps the delegate
 * produced are the ones strictly between.
 *
 * Those steps are the PARENT's rows. A delegate runs the parent's own tool
 * objects, so every read it makes goes through the parent's `wrapForLedger`
 * and lands in the parent's ledger with the parent's seq — which is what
 * charges them to the parent's budget, and is why the span is the only thing
 * that says whose work they were.
 *
 * ## Overlap is representable, not hidden
 *
 * Two delegations in one turn can interleave — the fan-out cap permits up to
 * the tenant's limit. Each span's BOUNDS are exact (they are captured in the
 * interceptor's own frame), but their ranges can overlap, and a step inside
 * two of them genuinely belongs to both as far as the ledger can say.
 *
 * So `steps` may share rows between spans, and `overlapping` says when that
 * happened. The alternative — assigning each step to one delegation by some
 * tie-break — would invent a precision the ledger does not have, and on a
 * governance surface attributing work to the wrong specialist is the error
 * that matters.
 */

/** The fields this grouping reads. Structural, so both callers fit. */
export interface SpannableStep {
    seq: number;
    costTokens: number | null;
    delegation: { agent: string; taskId: string; fromSeq: number | null } | null;
}

export interface DelegationSpan<T extends SpannableStep> {
    agent: string;
    taskId: string;
    /** The marker step itself — the one that closed the span. */
    marker: T;
    /** Exclusive lower bound, or null when the driver recorded none. */
    fromSeq: number | null;
    /** The steps the delegate produced: `fromSeq < seq < marker.seq`. */
    steps: T[];
    /**
     * Tokens spent inside the span, including the marker's own (always null
     * today — a delegation step spends none itself).
     *
     * `null` when NO step in the span reported a figure, which is a different
     * fact from zero: a delegate whose model calls went unreported and one
     * that spent nothing must not read the same. Same convention
     * `RunStepFeedRow.costTokens` already follows.
     */
    costTokens: number | null;
    /** Does this span share any step with another? */
    overlapping: boolean;
}

/**
 * Group a run's steps into its delegations, in ledger order.
 *
 * Steps are taken as given — this does not sort. The feed is ordered by `seq`
 * and the projection preserves that; sorting here would hide a caller that
 * handed over an unordered page, which is a bug worth seeing.
 */
export function delegationSpans<T extends SpannableStep>(steps: readonly T[]): DelegationSpan<T>[] {
    const markers = steps.filter((s) => s.delegation !== null);
    if (markers.length === 0) return [];

    const spans = markers.map((marker) => {
        const d = marker.delegation as NonNullable<T['delegation']>;
        const inSpan =
            d.fromSeq === null
                ? []
                : steps.filter((s) => s.seq > (d.fromSeq as number) && s.seq < marker.seq);
        const reported = inSpan
            .map((s) => s.costTokens)
            .filter((n): n is number => typeof n === 'number');
        return {
            agent: d.agent,
            taskId: d.taskId,
            marker,
            fromSeq: d.fromSeq,
            steps: inSpan,
            costTokens: reported.length === 0 ? null : reported.reduce((a, b) => a + b, 0),
            overlapping: false,
        };
    });

    // OVERLAP, computed after every span is known — a span cannot tell on its
    // own whether somebody else claims its steps.
    for (const span of spans) {
        span.overlapping = spans.some(
            (other) =>
                other !== span
                && other.steps.some((s) => span.steps.includes(s)),
        );
    }
    return spans;
}

/**
 * Which delegation a step belongs to, for marking it in a flat timeline.
 *
 * Returns the specialist names, because a step inside two overlapping spans
 * belongs to both and naming one would be a guess. Empty for the ordinary
 * case: a step no delegation claims.
 */
export function delegatesClaiming<T extends SpannableStep>(
    spans: readonly DelegationSpan<T>[],
    step: T,
): string[] {
    return spans.filter((s) => s.steps.includes(step)).map((s) => s.agent);
}
