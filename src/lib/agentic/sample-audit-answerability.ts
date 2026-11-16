/**
 * WHO MAY ANSWER ONE SAMPLE AUDIT — one rule, read by the write and by the
 * surface that offers it.
 *
 * `recordSampleAuditOutcome` refuses an answer for three reasons that a page can
 * know before the click: the caller cannot write in this context, the caller
 * approved the proposal under review, or the audit already has an answer. An
 * admin page offers a write only where the server takes it (#4467), so the
 * Answer control on `/agents/review-quality` has to reach those same three
 * verdicts — and a page that reimplements them is a page that drifts away from
 * them. The one that matters is the second: a copy that forgot a proposal's
 * FIRST signer (the defect #5112 fixed in the usecase) would offer the approver
 * a button, and the refusal would arrive as a 403 after the fact rather than as
 * an affordance that was never there.
 *
 * So both callers read these two functions, and neither spells the comparison
 * itself. This module is pure — no Prisma, no context, no permission import —
 * because the write resolves the facts from a row and the page resolves them
 * from a read, and only the VERDICT is shared.
 */

/**
 * Which condition bars the caller. The two are the same verdict and different
 * facts: `reviewed_by` is the recorded final reviewer of the proposal,
 * `recorded_signature` is a holder of one of its counted approval signatures —
 * at the two-approver rung the first signer is only ever the second of these.
 * The audit row carries the distinction so a reader can tell a sole-approver
 * self-review from a first-signer one; the 403 names neither.
 */
export type SampleAuditSelfReviewBasis = 'reviewed_by' | 'recorded_signature';

/** The approver facts of ONE proposal, as the write selects them. */
export type SampleAuditApproverFacts = {
    /** `AgentProposal.reviewedByUserId` — the LAST signer, or null. */
    reviewedByUserId: string | null;
    /**
     * The `approverUserId` of every `AgentProposalApproval` whose outcome counts
     * toward the requirement (ACCEPTED or EDITED). A REJECTED signature is not
     * an approval and a PENDING row records no judgement, so neither is here —
     * the caller filters, because the filter is a database `where`.
     */
    countedApproverUserIds: readonly (string | null)[];
};

/**
 * The self-review verdict, or null when the caller is not an approver.
 *
 * `reviewedByUserId` is compared only when it is non-null, so a proposal nobody
 * is recorded against never matches a caller with no user id; the signatures are
 * compared exactly as stored, so a nullable column cannot be widened underneath
 * this without the comparison changing meaning in the same diff.
 */
export function sampleAuditSelfReviewBasis(
    facts: SampleAuditApproverFacts,
    userId: string | null | undefined,
): SampleAuditSelfReviewBasis | null {
    if (facts.reviewedByUserId !== null && facts.reviewedByUserId === userId) {
        return 'reviewed_by';
    }
    if (facts.countedApproverUserIds.some((id) => id === userId)) {
        return 'recorded_signature';
    }
    return null;
}

/** Why the caller may not answer this audit, or null when they may. */
export type SampleAuditAnswerRefusal = 'NOT_A_WRITER' | 'SELF_REVIEW' | 'ALREADY_ANSWERED';

/**
 * The first refusal the write would reach, IN THE WRITE'S OWN ORDER.
 *
 * The order is not cosmetic. `recordSampleAuditOutcome` asks the coarse write
 * tier first, then self-review, and only then whether the audit is already
 * answered — so an approver who opens an audit somebody else has already closed
 * is told they may not review their own approval, which is the true reason, and
 * is the reason that leaves an `AUTHZ_DENIED` row on the server. Reversing the
 * last two would report a race as the verdict and hide the control.
 */
export function sampleAuditAnswerRefusal(facts: {
    canWrite: boolean;
    selfReviewBasis: SampleAuditSelfReviewBasis | null;
    alreadyAnswered: boolean;
}): SampleAuditAnswerRefusal | null {
    if (!facts.canWrite) return 'NOT_A_WRITER';
    if (facts.selfReviewBasis !== null) return 'SELF_REVIEW';
    if (facts.alreadyAnswered) return 'ALREADY_ANSWERED';
    return null;
}
