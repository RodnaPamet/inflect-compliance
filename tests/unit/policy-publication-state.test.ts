/**
 * The version-targeting rules shared by the policy usecases and the policy
 * detail page (`src/lib/policy/publication-state.ts`, #4127).
 */
import {
    isApprovalDecidable,
    isRevisionOf,
    isRevisionOfLiveVersion,
    liveVersion,
    newestVersion,
    publishableVersionId,
    type PublicationPolicy,
} from '@/lib/policy/publication-state';

const v1 = { id: 'v1', versionNumber: 1 };
const v2 = { id: 'v2', versionNumber: 2 };
const v3 = { id: 'v3', versionNumber: 3 };

function policy(over: Partial<PublicationPolicy>): PublicationPolicy {
    return { status: 'DRAFT', currentVersionId: null, versions: [v3, v2, v1], approvals: [], ...over };
}

describe('newestVersion', () => {
    it('is the highest version number, whatever the order', () => {
        expect(newestVersion([v1, v3, v2])).toBe(v3);
        expect(newestVersion([])).toBeNull();
        expect(newestVersion(undefined)).toBeNull();
    });
});

describe('liveVersion', () => {
    it('is the published pointer only while the policy is PUBLISHED', () => {
        expect(liveVersion(policy({ status: 'PUBLISHED', currentVersionId: 'v1' }))).toBe(v1);
        // A pointer seeded at creation, or left behind by an archive, is not live.
        expect(liveVersion(policy({ status: 'DRAFT', currentVersionId: 'v1' }))).toBeNull();
        expect(liveVersion(policy({ status: 'ARCHIVED', currentVersionId: 'v1' }))).toBeNull();
    });
});

describe('isRevisionOf', () => {
    it('is a strictly NEWER version than the live one', () => {
        expect(isRevisionOf(v1, v2)).toBe(true);
        expect(isRevisionOf(v2, v2)).toBe(false);
        expect(isRevisionOf(v2, v1)).toBe(false);
        expect(isRevisionOf(null, v2)).toBe(false);
    });

    it('needs a live version — nothing is a revision of a draft', () => {
        expect(isRevisionOfLiveVersion(policy({ status: 'DRAFT', currentVersionId: 'v1' }), 'v2')).toBe(false);
        expect(isRevisionOfLiveVersion(policy({ status: 'PUBLISHED', currentVersionId: 'v1' }), 'v2')).toBe(true);
    });
});

describe('publishableVersionId', () => {
    it('APPROVED: the version of the most recently decided approval', () => {
        expect(
            publishableVersionId(
                policy({
                    status: 'APPROVED',
                    approvals: [
                        { policyVersionId: 'v1', status: 'APPROVED', decidedAt: '2026-01-01' },
                        { policyVersionId: 'v2', status: 'APPROVED', decidedAt: '2026-02-01' },
                    ],
                }),
            ),
        ).toBe('v2');
    });

    it('PUBLISHED: an approved revision in the latest approval cycle', () => {
        const p = policy({
            status: 'PUBLISHED',
            currentVersionId: 'v1',
            approvals: [
                { policyVersionId: 'v1', status: 'APPROVED', createdAt: '2026-01-01', decidedAt: '2026-01-02' },
                { policyVersionId: 'v2', status: 'APPROVED', createdAt: '2026-02-01', decidedAt: '2026-02-02' },
            ],
        });
        expect(publishableVersionId(p)).toBe('v2');
    });

    it('PUBLISHED: a later request ends the earlier approval\'s standing', () => {
        const approvedThenAsked = (later: string) =>
            policy({
                status: 'PUBLISHED',
                currentVersionId: 'v1',
                approvals: [
                    { policyVersionId: 'v2', status: 'APPROVED', createdAt: '2026-02-01', decidedAt: '2026-02-02' },
                    { policyVersionId: 'v3', status: later, createdAt: '2026-03-01' },
                ],
            });
        expect(publishableVersionId(approvedThenAsked('PENDING'))).toBeNull();
        expect(publishableVersionId(approvedThenAsked('REJECTED'))).toBeNull();
    });

    it('PUBLISHED: the live version, or an older one, is never publishable this way', () => {
        // The live version's own approval.
        expect(
            publishableVersionId(
                policy({
                    status: 'PUBLISHED',
                    currentVersionId: 'v2',
                    approvals: [{ policyVersionId: 'v2', status: 'APPROVED', createdAt: '2026-02-01' }],
                }),
            ),
        ).toBeNull();
        // v1 approved, then v2 published past it with a bypass.
        expect(
            publishableVersionId(
                policy({
                    status: 'PUBLISHED',
                    currentVersionId: 'v2',
                    approvals: [{ policyVersionId: 'v1', status: 'APPROVED', createdAt: '2026-01-01' }],
                }),
            ),
        ).toBeNull();
    });

    it('nothing is publishable without a bypass in DRAFT, IN_REVIEW or ARCHIVED', () => {
        const approvals = [{ policyVersionId: 'v2', status: 'APPROVED', createdAt: '2026-02-01', decidedAt: '2026-02-02' }];
        for (const status of ['DRAFT', 'IN_REVIEW', 'ARCHIVED']) {
            expect(publishableVersionId(policy({ status, currentVersionId: 'v1', approvals }))).toBeNull();
        }
    });
});

describe('isApprovalDecidable', () => {
    it('a PENDING request on an IN_REVIEW policy is decidable', () => {
        expect(isApprovalDecidable(policy({ status: 'IN_REVIEW' }), { status: 'PENDING', policyVersionId: 'v1' })).toBe(true);
    });

    it('on a PUBLISHED policy only a request for a revision is', () => {
        const p = policy({ status: 'PUBLISHED', currentVersionId: 'v2' });
        expect(isApprovalDecidable(p, { status: 'PENDING', policyVersionId: 'v3' })).toBe(true);
        expect(isApprovalDecidable(p, { status: 'PENDING', policyVersionId: 'v2' })).toBe(false);
        expect(isApprovalDecidable(p, { status: 'PENDING', policyVersionId: 'v1' })).toBe(false);
    });

    it('a decided row, or one on a DRAFT/APPROVED/ARCHIVED policy, is not', () => {
        expect(isApprovalDecidable(policy({ status: 'IN_REVIEW' }), { status: 'APPROVED', policyVersionId: 'v1' })).toBe(false);
        for (const status of ['DRAFT', 'APPROVED', 'ARCHIVED']) {
            expect(isApprovalDecidable(policy({ status }), { status: 'PENDING', policyVersionId: 'v1' })).toBe(false);
        }
    });
});
