/**
 * `<ApprovalBanner>` rendered tests — Epic 45.3
 *
 * Locks the banner's UX contract:
 *   - PENDING / APPROVED / REJECTED states each render their own
 *     status copy + colour band + iconography.
 *   - Requester + reviewer (or "awaiting any admin reviewer") show
 *     unconditionally so non-acting readers stay informed.
 *   - Approve / Reject actions appear ONLY when the policy is
 *     PENDING + `canDecide=true`.
 *   - Reviewer-is-also-the-requester case disables the actions and
 *     surfaces the "can't approve your own request" hint.
 *   - Decide handler receives the right approvalId + decision +
 *     comment payload.
 *   - `busy` short-circuits decide attempts.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { ApprovalBanner } from '@/components/ui/ApprovalBanner';

const baseRequester = { id: 'u_alice', name: 'Alice', email: 'alice@example.com' };
const baseReviewer = { id: 'u_bob', name: 'Bob', email: 'bob@example.com' };

function pending(overrides: Record<string, unknown> = {}) {
    return {
        id: 'a_1',
        status: 'PENDING' as const,
        requestedBy: baseRequester,
        approvedBy: null,
        decidedAt: null,
        comment: null,
        versionNumber: 3,
        ...overrides,
    };
}

describe('<ApprovalBanner>', () => {
    it('renders the PENDING state with status + requester + version', () => {
        render(
            <ApprovalBanner
                approval={pending()}
                canDecide={false}
            />,
        );
        const banner = screen.getByTestId('approval-banner');
        expect(banner.getAttribute('data-status')).toBe('PENDING');
        expect(
            screen.getByTestId('approval-banner-status').textContent,
        ).toMatch(/Pending Review/);
        expect(
            screen.getByTestId('approval-banner-requester').textContent,
        ).toBe('Alice');
        expect(banner.textContent).toContain('Version 3');
        // Reviewer slot informs non-actors that no specific reviewer
        // is assigned yet.
        expect(
            screen.getByTestId('approval-banner-reviewer').textContent,
        ).toMatch(/awaiting any admin/i);
    });

    it('hides Approve / Reject actions when canDecide=false', () => {
        render(
            <ApprovalBanner approval={pending()} canDecide={false} />,
        );
        expect(screen.queryByTestId('approval-banner-approve')).toBeNull();
        expect(screen.queryByTestId('approval-banner-reject')).toBeNull();
    });

    it('shows Approve / Reject when canDecide=true and dispatches the decision', () => {
        const onDecide = jest.fn();
        render(
            <ApprovalBanner
                approval={pending()}
                canDecide
                onDecide={onDecide}
            />,
        );
        const approve = screen.getByTestId('approval-banner-approve');
        expect(approve).toBeInTheDocument();
        fireEvent.click(approve);
        expect(onDecide).toHaveBeenCalledWith('a_1', 'APPROVED', '');

        fireEvent.click(screen.getByTestId('approval-banner-reject'));
        expect(onDecide).toHaveBeenLastCalledWith('a_1', 'REJECTED', '');
    });

    it('forwards the optional reviewer comment', () => {
        const onDecide = jest.fn();
        render(
            <ApprovalBanner
                approval={pending()}
                canDecide
                onDecide={onDecide}
            />,
        );
        // Open the comment field, type, then approve.
        fireEvent.click(screen.getByTestId('approval-banner-add-comment'));
        const input = screen.getByTestId(
            'approval-banner-comment-input',
        ) as HTMLTextAreaElement;
        fireEvent.change(input, { target: { value: 'LGTM with edits' } });
        fireEvent.click(screen.getByTestId('approval-banner-approve'));
        expect(onDecide).toHaveBeenCalledWith('a_1', 'APPROVED', 'LGTM with edits');
    });

    it('blocks self-APPROVE but leaves self-REJECT available (a requester may withdraw)', () => {
        render(
            <ApprovalBanner
                approval={pending()}
                canDecide
                currentUserId="u_alice"
            />,
        );
        const approve = screen.getByTestId(
            'approval-banner-approve',
        ) as HTMLButtonElement;
        const reject = screen.getByTestId(
            'approval-banner-reject',
        ) as HTMLButtonElement;
        expect(approve.disabled).toBe(true);
        // Reject stays ENABLED. `decidePolicyApproval` refuses a self-APPROVAL
        // only — its guard is `decision === 'APPROVED' && requestedBy === me`
        // — and deliberately permits a self-REJECTION so the requester can
        // WITHDRAW instead of stranding the policy in IN_REVIEW. The banner
        // used to disable both and claim "reviewers cannot reject their own
        // request", a rule that does not exist anywhere in the server; the
        // one person who most needs to withdraw was the one person refused.
        expect(reject.disabled).toBe(false);
        // The rendered copy uses a typographic right-single-quote
        // (`&rsquo;`) — match either form so the assertion stays
        // robust under either render path.
        expect(screen.getByTestId('approval-banner').textContent).toMatch(
            /can[’']t approve your own request/i,
        );
    });

    it('disables actions when busy=true', () => {
        render(
            <ApprovalBanner
                approval={pending()}
                canDecide
                busy
            />,
        );
        expect(
            (screen.getByTestId(
                'approval-banner-approve',
            ) as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('APPROVED state renders the reviewer + status copy + drops the actions', () => {
        render(
            <ApprovalBanner
                approval={{
                    ...pending({
                        status: 'APPROVED',
                        approvedBy: baseReviewer,
                        decidedAt: '2026-04-30T00:00:00.000Z',
                    }),
                }}
                canDecide
            />,
        );
        const banner = screen.getByTestId('approval-banner');
        expect(banner.getAttribute('data-status')).toBe('APPROVED');
        expect(
            screen.getByTestId('approval-banner-reviewer').textContent,
        ).toBe('Bob');
        expect(screen.queryByTestId('approval-banner-approve')).toBeNull();
    });

    it('REJECTED state surfaces the comment when present', () => {
        render(
            <ApprovalBanner
                approval={{
                    ...pending({
                        status: 'REJECTED',
                        approvedBy: baseReviewer,
                        comment: 'Needs more detail',
                    }),
                }}
                canDecide={false}
            />,
        );
        expect(
            screen.getByTestId('approval-banner-comment').textContent,
        ).toBe('Needs more detail');
    });
});
