/**
 * WHO MAY ANSWER A SAMPLE AUDIT — the rule the write and the page both read.
 *
 * These are the three refusals `recordSampleAuditOutcome` reaches, extracted so
 * the review-quality page can decide whether to offer an Answer control at all
 * rather than posting and finding out. Two properties are worth more than the
 * rest and each is asserted on its own:
 *
 *   1. A FIRST SIGNER IS AN APPROVER. At the two-approver rung only the LAST
 *      signer lands on `AgentProposal.reviewedByUserId`, so a rule that reads
 *      that column alone lets the first signer re-review their own approval —
 *      on exactly the proposals held to the highest bar. That was #5112 in the
 *      usecase; this is the test that stops the page reintroducing it.
 *
 *   2. THE ORDER OF THE REFUSALS IS PART OF THE RULE. Self-review is reported
 *      ahead of already-answered, so an approver who opens an audit somebody
 *      else has already closed is told the true reason — the one that leaves an
 *      `AUTHZ_DENIED` row on the server — rather than being told about a race.
 */
import {
    sampleAuditAnswerRefusal,
    sampleAuditSelfReviewBasis,
} from '@/lib/agentic/sample-audit-answerability';

const NOBODY = { reviewedByUserId: null, countedApproverUserIds: [] as string[] };

describe('sampleAuditSelfReviewBasis', () => {
    it('names the recorded final reviewer', () => {
        expect(
            sampleAuditSelfReviewBasis(
                { reviewedByUserId: 'u1', countedApproverUserIds: ['u1'] },
                'u1',
            ),
        ).toBe('reviewed_by');
    });

    it('bars the FIRST signer of a two-approver proposal (#5112)', () => {
        // `reviewedByUserId` is the LAST signer. The first signer appears only
        // in the signature rows, and is just as much "the approver".
        expect(
            sampleAuditSelfReviewBasis(
                { reviewedByUserId: 'second', countedApproverUserIds: ['first', 'second'] },
                'first',
            ),
        ).toBe('recorded_signature');
    });

    it('lets a third party answer', () => {
        expect(
            sampleAuditSelfReviewBasis(
                { reviewedByUserId: 'second', countedApproverUserIds: ['first', 'second'] },
                'somebody-else',
            ),
        ).toBeNull();
    });

    it('does not match a caller with no user id against an unreviewed proposal', () => {
        // Both sides null is the shape a naive `===` turns into a refusal for
        // every machine caller on every proposal nobody is recorded against.
        expect(sampleAuditSelfReviewBasis(NOBODY, null)).toBeNull();
        expect(sampleAuditSelfReviewBasis(NOBODY, undefined)).toBeNull();
    });

    it('reports reviewed_by in preference to recorded_signature for the same person', () => {
        // The two are the same verdict and different facts; the audit row keeps
        // them apart, so a sole approver must not be recorded as a co-signer.
        expect(
            sampleAuditSelfReviewBasis(
                { reviewedByUserId: 'u1', countedApproverUserIds: ['u1'] },
                'u1',
            ),
        ).toBe('reviewed_by');
    });
});

describe('sampleAuditAnswerRefusal', () => {
    const clean = { canWrite: true, selfReviewBasis: null, alreadyAnswered: false } as const;

    it('offers the control when nothing bars it', () => {
        expect(sampleAuditAnswerRefusal(clean)).toBeNull();
    });

    it('refuses a reader', () => {
        expect(sampleAuditAnswerRefusal({ ...clean, canWrite: false })).toBe('NOT_A_WRITER');
    });

    it('refuses the approver', () => {
        expect(
            sampleAuditAnswerRefusal({ ...clean, selfReviewBasis: 'recorded_signature' }),
        ).toBe('SELF_REVIEW');
    });

    it('refuses an audit that already has an answer', () => {
        expect(sampleAuditAnswerRefusal({ ...clean, alreadyAnswered: true })).toBe(
            'ALREADY_ANSWERED',
        );
    });

    it('reports SELF_REVIEW ahead of ALREADY_ANSWERED', () => {
        expect(
            sampleAuditAnswerRefusal({
                canWrite: true,
                selfReviewBasis: 'reviewed_by',
                alreadyAnswered: true,
            }),
        ).toBe('SELF_REVIEW');
    });

    it('reports NOT_A_WRITER ahead of everything, as the write asks it first', () => {
        expect(
            sampleAuditAnswerRefusal({
                canWrite: false,
                selfReviewBasis: 'reviewed_by',
                alreadyAnswered: true,
            }),
        ).toBe('NOT_A_WRITER');
    });
});
