/**
 * THE GUARD VERDICT RECORD AND THE REVIEW LATCH, for every engine Inflect runs.
 *
 * Engine-neutral: no import of `@flue/*`, `valibot` or any ESM-only package
 * (enforced in `eslint.config.mjs`). Moved out of `flue/tools-adapter.ts` in
 * Step 0a of `docs/claude-agent-sdk-design.md`, unchanged, so a second engine
 * shares the latch, the observation shape and the verdict mapping rather than
 * growing a copy of each.
 */
import {
    assertGuardAllowed,
    assertNoReviewRequired,
    type GuardOutcome,
    type GuardVerdict,
    type GuardDirection,
} from '@/app-layer/ai/guard';
// The PERSISTED verdict vocabulary. `proposal-guard` declares it as mirroring
// the `AgentGuardVerdict` Prisma enum exactly, so importing it from there
// keeps this module free of a Prisma value import while still being checked
// against the enum the column accepts.
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';
import { forbidden } from '@/lib/errors/types';

/**
 * One guard flag. Rule ids and verdict only — never the content that tripped it.
 */
export interface ReviewFlag {
    readonly tool: string;
    /** Which slice of the sandwich fired: the model's ARGUMENTS, or the RESULT. */
    readonly slice: 'args' | 'result';
    readonly direction: GuardDirection;
    readonly verdict: GuardVerdict;
    readonly ruleIds: readonly string[];
}

/**
 * The invocation-scoped answer to "may this run carry on by itself?".
 *
 * ## Why refusing one call was not enough
 *
 * `GuardAction` has three values and the middle one is the default outcome.
 * Under `balanced` — the mode a tenant gets without configuring anything — a
 * SUSPICIOUS finding in either direction, and a MALICIOUS one on input,
 * resolve to `flag`, whose contract `policy.ts` states as "allow, but force
 * human review; NEVER auto-commit".
 *
 * This adapter honoured only `assertGuardAllowed`, which fires on `blocked`
 * alone. So a flag did nothing: flagged ARGUMENTS went on to the funnel, and a
 * flagged RESULT — tenant-authored text that reads as an instruction — was
 * returned into the model's context verbatim. The guard ran, recorded its
 * verdict, and changed nothing, which is the shape of a control that reports
 * itself working.
 *
 * Throwing on the flagged call is necessary and is NOT sufficient. A tool that
 * throws is, to a language model, a tool that did not work: it picks another
 * one and keeps going. Refusing call three of seven while calls four through
 * seven proceed is auto-continuation with an extra error in the transcript —
 * and the one thing a flag must never do is let the agent route around it.
 *
 * So the latch is one-way and invocation-wide. The first flag trips it, and
 * every later call in the same invocation refuses BEFORE the funnel, before
 * the guards, before anything. A tripped latch is the driver's signal to put
 * the run into `AWAITING_APPROVAL`: `required` is the question it asks, and
 * `flags` is what it shows the human who has to answer.
 *
 * Nothing is reset. There is no `clear()` and there must not be one — the run
 * is answered by a person, not by the next call going well.
 */
/**
 * WHAT THE GUARD SAID ABOUT ONE SLICE OF ONE TOOL CALL.
 *
 * Reported for EVERY scan, not only the refusing ones. "The guard ran and
 * found nothing" and "the guard never ran" are different facts, and a ledger
 * that records only refusals cannot tell them apart — the same reasoning that
 * put `guardInputDigest` on `AgentProposal`.
 */
export interface StepGuardObservation {
    /** Ties the observation to the call, so concurrent tools cannot cross. */
    toolCallId: string;
    tool: string;
    slice: ReviewFlag['slice'];
    verdict: AgentGuardVerdict;
    ruleIds: readonly string[];
}

export type GuardObserver = (observation: StepGuardObservation) => void;

/**
 * The scanner's answer, as the step ledger records it.
 *
 * NOT `proposal-guard`'s ladder, deliberately. That ladder quarantines a
 * malicious scan because a proposal becomes a live compliance record; a tool
 * call is a different question. Here the enforcement outcome IS the verdict:
 * a blocked call never returned data, a flagged one latched review, and
 * anything else was scanned and permitted.
 */
export function stepVerdictOf(outcome: GuardOutcome): AgentGuardVerdict {
    if (outcome.blocked) return 'QUARANTINED';
    if (outcome.reviewRequired) return 'FLAGGED';
    return 'CLEAN';
}

export class ReviewLatch {
    private readonly recorded: ReviewFlag[] = [];

    /**
     * Optional, because the latch's REFUSAL job does not depend on anyone
     * listening. A run with no observer behaves exactly as before.
     */
    constructor(private readonly observe?: GuardObserver) {}

    /** Did a guard flag anything in this invocation? */
    get required(): boolean {
        return this.recorded.length > 0;
    }

    /** The flags, in the order they fired. */
    get flags(): readonly ReviewFlag[] {
        return this.recorded;
    }

    /**
     * Refuse outright once anything has been flagged.
     *
     * Called at the TOP of every guarded call, so a tripped latch costs no
     * funnel call, no audit row and no guard scan. The message names the flag
     * that stopped the run rather than the call that just bounced off it,
     * because the second one is never the interesting half.
     */
    assertNotTripped(tool: string): void {
        const first = this.recorded[0];
        if (!first) return;
        throw forbidden(
            `ai_guard_review_required: awaiting human review since ` +
                `${first.slice} of ${first.tool} ` +
                `[${first.ruleIds.join(',')}] — refusing ${tool}`,
        );
    }

    /**
     * Record a verdict, then enforce it.
     *
     * The order is load-bearing: both assertions throw, and a flag recorded
     * after the throw would be a flag nobody could read — the latch would stay
     * down while the call that should have tripped it unwound.
     *
     * Both assertions, not one. `assertNoReviewRequired` subsumes
     * `assertGuardAllowed` (a block sets `reviewRequired` too), but running the
     * narrower one first keeps a block reporting itself as `ai_guard_blocked`
     * instead of being relabelled as something milder.
     */
    check(
        outcome: GuardOutcome,
        tool: string,
        slice: ReviewFlag['slice'],
        toolCallId = 'standalone',
    ): void {
        // REPORTED FIRST, before either assertion below can throw.
        //
        // A blocked or flagged scan is exactly the one the ledger most needs
        // to record, and both of those paths leave this method by throwing.
        // Observing after the asserts would record every CLEAN verdict and
        // silently drop every refusal — the inversion of what is wanted.
        this.observe?.({
            toolCallId,
            tool,
            slice,
            verdict: stepVerdictOf(outcome),
            // `?? []` because this runs INSIDE the guard seam. `GuardOutcome`
            // types `ruleIds` as required, so this should never fire — but a
            // scanner returning a malformed outcome would otherwise throw
            // here, turning a CLEAN scan into a 500 raised by the very code
            // that exists to observe it. The observation degrades; the call
            // does not.
            ruleIds: [...(outcome.ruleIds ?? [])],
        });

        if (outcome.reviewRequired) {
            this.recorded.push({
                tool,
                slice,
                direction: outcome.direction,
                verdict: outcome.verdict,
                ruleIds: [...outcome.ruleIds],
            });
        }
        assertGuardAllowed(outcome);
        assertNoReviewRequired(outcome);
    }
}
