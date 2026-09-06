/**
 * THE PROPOSAL WINDOW — how long a human has to decide, and what happens after.
 *
 * OWASP ASI09 (human-agent trust exploitation) is not a bug in the approval
 * gate; it is a bug in the human behind it. The propose-not-commit queue is
 * only worth what the review is worth, and the single most reliable way to
 * make a review worthless is to make the queue long. Queue depth is therefore
 * part of the THREAT MODEL, not a housekeeping matter: an unbounded backlog is
 * how "approve" stops meaning "I read this" and starts meaning "clear the
 * list".
 *
 * So a proposal carries a deadline, pinned at propose time, after which it
 * cannot be approved. Nothing is deleted — see the note on evidence below.
 *
 * ── The clock, stated rather than left implicit ──────────────────────
 *
 * THE CLOCK STARTS AT PROPOSE TIME AND NEVER RESTARTS. In particular it does
 * NOT restart when a first approver signs a proposal whose card requires a
 * second. That is a deliberate answer to a real question, and the reasoning
 * runs the other way from the intuition:
 *
 *   A window that restarts on partial progress can be held open forever by
 *   one person. One approver signing every seventh day keeps a proposal alive
 *   indefinitely, and the rung that demands the MOST scrutiny becomes the one
 *   with no deadline at all. That is the automation-bias failure wearing the
 *   costume of the control that was supposed to prevent it.
 *
 * What DOES vary by rung is the window's LENGTH, and it is decided once, at
 * creation, from the approval rung of the policy-card version in force
 * (`AgentPolicyCardVersion.approvalRung`, already pinned onto the proposal as
 * `policyCardVersion`). A rung that needs two humans found gets twice as long
 * to find them. It is a longer window GRANTED AT THE START, never an extension
 * EARNED BY PROGRESS — those are different rules and only the first one bounds
 * the queue.
 *
 * ── Why the deadline is a stored column, not a computed one ──────────
 *
 * `expiresAt` is written onto the row. It is not recomputed from
 * `createdAt + windowFor(currentRung)` at read time, for the same reason
 * `policyCardVersion` is pinned rather than re-read: a card can be edited, and
 * a card edit must not silently move the deadline of a proposal already in
 * flight — in either direction. Recomputing would let a policy change retire a
 * live proposal, or resurrect one whose window had closed.
 *
 * ── Expiry does not delete evidence ──────────────────────────────────
 *
 * An expired proposal is the record of something an agent asked for and no
 * human ever agreed to. That is worth keeping — it is the raw material for
 * "what is this agent trying to do that nobody wants?", and it is the only
 * evidence that the queue was too long to serve. So expiry is a STATUS
 * TRANSITION to a terminal `EXPIRED`, with the payload, the rationale, the
 * guard verdict, the agent attribution and the pinned card version all intact,
 * plus one hash-chained audit row. Nothing is erased and nothing is
 * hard-deleted.
 *
 * NO SERVER IMPORTS — the admin client renders the same windows, and this is
 * the module both sides read. The only import is a TYPE, which is erased.
 */
import type { ApprovalRung } from './policy-card';

/**
 * How many days each approval rung gets, keyed by the rung name.
 *
 * Read as "time to find the humans this rung requires", which is why the
 * strictest rung gets the LONGEST window rather than the shortest — the
 * opposite of the reflex. Two humans is not twice as much scrutiny if the
 * second one is never reachable in time; a deadline that cannot be met is a
 * deadline that trains people to widen the rung.
 *
 * `AUTO_APPROVAL` falls back to the single-human window rather than to zero.
 * A rung that permits an automatic approval does not COMPEL one, and a
 * proposal sitting at that rung unapproved is a proposal that still needs a
 * person — the rung says how many signatures are required, not whether anybody
 * turned up.
 */
export const PROPOSAL_WINDOW_DAYS: Readonly<Record<ApprovalRung, number>> = {
    SECOND_APPROVER: 14,
    SINGLE_APPROVER: 7,
    AUTO_APPROVAL: 7,
};

/**
 * The window for a proposal made under NO policy card at all — an agent
 * without one, or a human-driven assistant proposal (`NO_POLICY_CARD`, 0).
 *
 * The SHORTEST window on the table, and that direction is the point: an absent
 * card contributes no narrowing term anywhere else in this subsystem
 * (`policy-card.ts` says so explicitly), so the absence must not buy a LONGER
 * deadline than any rung a card could have declared. Fail-closed here means
 * "less time", not "more".
 */
export const UNCARDED_PROPOSAL_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long this proposal's window is, in days.
 *
 * `null` means no card governed the proposal. An UNRECOGNISED rung — a row
 * written by a build that knew a rung this one does not — is treated the same
 * as no card, i.e. the shortest window. Same failure direction as `rungOf`
 * in `policy-card.ts`: a value this build cannot rank buys nothing.
 */
export function proposalWindowDays(rung: ApprovalRung | null | undefined): number {
    if (!rung) return UNCARDED_PROPOSAL_WINDOW_DAYS;
    const days = PROPOSAL_WINDOW_DAYS[rung];
    return typeof days === 'number' ? days : UNCARDED_PROPOSAL_WINDOW_DAYS;
}

/** The deadline to pin onto a proposal created at `createdAt` under `rung`. */
export function proposalExpiresAt(
    createdAt: Date,
    rung: ApprovalRung | null | undefined,
): Date {
    return new Date(createdAt.getTime() + proposalWindowDays(rung) * MS_PER_DAY);
}

/**
 * Has this proposal's window closed?
 *
 * A NULL `expiresAt` is NOT expired, and that is the one place this module
 * fails open on purpose. The column is nullable because it was added to a
 * populated table, and because a container running the previous build writes
 * rows without it during a rolling deploy. Treating "no deadline recorded" as
 * "deadline passed" would retire every pre-existing proposal at the moment of
 * deploy — an outage dressed as a control. The sweep stamps a deadline onto
 * those rows instead; see `backfillMissingProposalWindows` in the job.
 *
 * The comparison is `<=`, not `<`: a deadline is the first instant the window
 * is CLOSED, so a proposal is expired exactly at `expiresAt`. An open interval
 * would leave a one-tick window whose behaviour depends on clock resolution.
 */
export function isProposalExpired(
    expiresAt: Date | null | undefined,
    now: Date,
): boolean {
    if (!expiresAt) return false;
    return expiresAt.getTime() <= now.getTime();
}
