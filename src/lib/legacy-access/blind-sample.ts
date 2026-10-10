/**
 * The blind sample - the production outcome metric for adjudication.
 *
 * ===========================================================================
 * WHY A BLIND SAMPLE AND NOT THE VENDOR'S CALIBRATION
 * ===========================================================================
 *
 * The evaluation record says what a revision scored on a synthetic corpus. That
 * is what licenses a verdict at all, and it is not evidence about this tenant's
 * data: the corpus is ours, the legacy system is theirs, and a model that scores
 * perfectly on invented Bulgarian names can still be wrong about a particular
 * customer's naming convention.
 *
 * So 5 % of `AGREES` rows are shown to a reviewer WITHOUT the verdict and kept
 * out of bulk ratification. Their own decision is then compared with the model's
 * pick, and that comparison is a measurement of precision on real data that
 * nobody could have gamed - including us.
 *
 * ===========================================================================
 * DERIVED FROM THE VERDICT ID, NOT STORED
 * ===========================================================================
 *
 * Membership is `sha256(verdictId)` against a rate. No column, no sampler state,
 * no row to migrate, and the same row is blind every time it is listed - which
 * matters because a reviewer who refreshes the queue must not be shown the
 * verdict they were deliberately not shown.
 *
 * **The VERDICT id and not the resolution id.** A verdict is one per
 * `(resolution, revision)`, so a new model revision RE-SAMPLES the same
 * accounts. That is the point: each revision's `AGREES` precision needs its own
 * measurement, and a sample keyed on the resolution would hand every revision
 * the same 5 % of accounts and measure the same ones for ever.
 *
 * Deliberately NOT secret, and it does not need to be. The property that makes
 * the sample work is that the reviewer does not SEE the verdict, not that they
 * could not compute whether a row is in the sample. A reviewer who worked out
 * the membership function still has nothing to agree with.
 *
 * @module lib/legacy-access/blind-sample
 */

import { createHash } from 'node:crypto';

/**
 * The share of `AGREES` rows withheld.
 *
 * 5 % from the design. The trade it settles: every withheld row is a row a
 * person reviews one at a time instead of ratifying in bulk, so the sample is
 * paid for in reviewer time - and a rate too low to produce a disagreement in a
 * cycle buys nothing, because one disagreement is what closes the lane.
 */
export const BLIND_SAMPLE_RATE = 0.05;

/** 2^32, the denominator for the 32 bits of hash read below. */
const UINT32_SPAN = 0x1_0000_0000;

/**
 * Is this verdict withheld from its reviewer?
 *
 * Uniform in the id: SHA-256's output is indistinguishable from random for an
 * input nobody chose adversarially, and a cuid is not adversarial. Thirty-two
 * bits give a resolution of about one in four billion, which is four orders of
 * magnitude finer than the rate needs.
 *
 * An EMPTY id is not in the sample. It is not a verdict - there is nothing to
 * withhold and nothing to compare a decision against - and hashing the empty
 * string would otherwise put a whole class of malformed input into or out of the
 * sample by accident of one digest.
 */
export function isBlindHeld(verdictId: string, rate: number = BLIND_SAMPLE_RATE): boolean {
    if (!verdictId) return false;
    const digest = createHash('sha256').update(verdictId).digest();
    return digest.readUInt32BE(0) / UINT32_SPAN < rate;
}

/**
 * One blind row's outcome, as the lane gate reads it.
 *
 * `reviewerEmployeeId` is null when the reviewer decided something other than a
 * link - a non-person, an external, an orphan. That is NOT a disagreement with
 * the model's pick: those three answers are about what KIND of account it is,
 * and the model was asked which person holds it. Scoring them as disagreements
 * would close the lane on the first service account a reviewer classified.
 */
export interface BlindComparison {
    readonly verdictId: string;
    readonly modelEmployeeId: string | null;
    readonly reviewerEmployeeId: string | null;
}

/**
 * Did a blind row disagree?
 *
 * BOTH sides must name a person. A comparison with either side missing is not
 * evidence: the model may have produced no pick (then it was not an `AGREES`
 * and should not be here), and the reviewer may have answered a different
 * question (see {@link BlindComparison}).
 */
export function blindDisagreed(c: BlindComparison): boolean {
    if (!c.modelEmployeeId || !c.reviewerEmployeeId) return false;
    return c.modelEmployeeId !== c.reviewerEmployeeId;
}

/**
 * Is the bulk `AGREES` lane closed for this revision?
 *
 * ONE disagreement closes it, for the rest of the cycle. Not a rate and not a
 * threshold, which is deliberate and worth defending: bulk ratification is a
 * person confirming many rows on the strength of a claim that the model agrees
 * with the engine, and a single counter-example to that claim means the rows
 * they are about to ratify are not the kind of rows they were told they were.
 * A 2 % error rate sounds tolerable until it is the account somebody kept.
 *
 * Derived rather than stored. The alternative is a `laneClosedAt` column
 * somebody has to write, which can be missed, and which can disagree with the
 * decisions it was supposed to summarise - whereas this cannot be wrong unless
 * the decisions themselves are.
 */
export function agreesLaneClosed(comparisons: readonly BlindComparison[]): boolean {
    return comparisons.some(blindDisagreed);
}
