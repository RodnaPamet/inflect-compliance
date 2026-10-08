/**
 * Epic G-4 — Access review detail / reviewer page render test.
 *
 *   1. Renders the title + status + roster table.
 *   2. The decision dropdown opens the right modal (MODIFY shows
 *      the target-role select; CONFIRM/REVOKE don't).
 *   3. Close button is disabled while any decision is pending.
 *   4. Non-admin non-reviewer cannot see the decision dropdown.
 *   5. CLOSED campaigns hide the dropdown but show the download
 *      evidence button.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    // `useParams` is REQUIRED, not decoration: the prev/next stepper
    // resolves its published-order cache key through the route's
    // tenantSlug, so a mock without it throws the moment the client
    // mounts.
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/access-reviews/rev_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// The detail client now reads via `useTenantSWR`, which resolves the
// tenant-relative path through `useTenantApiUrl`. Mock that seam so the
// component renders without a real TenantProvider.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { AccessReviewDetailClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient';

function withClient(ui: React.ReactNode) {
    // Fresh per-render SWR cache; no React Query — this client has no
    // not-yet-migrated RQ children.
    return (
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            {ui}
        </SWRConfig>
    );
}

function makeReview(overrides: Record<string, unknown> = {}) {
    return {
        id: 'rev_1',
        name: 'Q1 access review',
        description: 'Routine SOC 2 quarterly review.',
        scope: 'ALL_USERS' as const,
        status: 'OPEN' as const,
        periodStartAt: null,
        periodEndAt: null,
        dueAt: null,
        closedAt: null,
        createdAt: new Date('2026-04-01').toISOString(),
        reviewerUserId: 'usr_reviewer',
        evidenceFileRecordId: null,
        reviewer: { id: 'usr_reviewer', email: 'r@example.test', name: null },
        createdBy: { id: 'usr_admin', email: 'a@example.test', name: null },
        closedBy: null,
        decisions: [
            {
                id: 'dec_1',
                subjectUserId: 'usr_alice',
                subjectUser: { id: 'usr_alice', email: 'alice@example.test', name: 'Alice' },
                snapshotRole: 'EDITOR' as const,
                snapshotMembershipStatus: 'ACTIVE',
                decision: null,
                decidedAt: null,
                decidedBy: null,
                notes: null,
                modifiedToRole: null,
                executedAt: null,
                membership: { id: 'mem_1', role: 'EDITOR' as const, status: 'ACTIVE' },
            },
            {
                id: 'dec_2',
                subjectUserId: 'usr_bob',
                subjectUser: { id: 'usr_bob', email: 'bob@example.test', name: 'Bob' },
                snapshotRole: 'READER' as const,
                snapshotMembershipStatus: 'ACTIVE',
                decision: null,
                decidedAt: null,
                decidedBy: null,
                notes: null,
                modifiedToRole: null,
                executedAt: null,
                membership: { id: 'mem_2', role: 'READER' as const, status: 'ACTIVE' },
            },
        ],
        // Step 5a — the page now counts BOTH subject populations. A member
        // campaign has an empty connected list, and vice versa.
        connectedDecisions: [],
        snapshotTruncated: false,
        lastActivityByUser: { usr_alice: new Date('2026-04-30').toISOString() },
        ...overrides,
    };
}

/** Step 5a — one CONNECTED_APP subject, with the HR context the page renders. */
function connectedSubject(overrides: Record<string, unknown> = {}) {
    return {
        id: 'cdec_1',
        subjectRef: 'conn-1:ext-a',
        decision: null,
        decidedAt: null,
        decidedBy: null,
        notes: null,
        executedAt: null,
        snapshotJson: {
            provider: 'entra-id',
            email: 'carol@example.test',
            displayName: 'Carol',
            isAdmin: true,
            mfaEnrolled: false,
            hr: {
                employeeId: 'emp_1',
                fullName: 'Carol Danvers',
                workEmail: 'carol@example.test',
                employmentStatus: 'ACTIVE',
                department: 'Finance',
                jobTitle: 'Analyst',
                managerName: 'Nick Fury',
                managerEmail: 'nick@example.test',
                matchMethod: 'EMAIL_EXACT',
                contradicted: false,
            },
        },
        ...overrides,
    };
}

beforeEach(() => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => makeReview(),
    }));
});

describe('AccessReviewDetailClient', () => {
    it('renders title, status badge, and one row per decision', () => {
        render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview()}
                    currentUserId="usr_reviewer"
                    isAdmin={false}
                />,
            ),
        );
        expect(screen.getByTestId('access-review-detail-title').textContent).toBe(
            'Q1 access review',
        );
        expect(screen.getByTestId('decision-row-dec_1')).toBeTruthy();
        expect(screen.getByTestId('decision-row-dec_2')).toBeTruthy();
    });

    it('reviewer can use the decision dropdown — picking CONFIRM opens the modal without a target-role select', () => {
        render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview()}
                    currentUserId="usr_reviewer"
                    isAdmin={false}
                />,
            ),
        );
        fireEvent.change(screen.getByTestId('decision-select-dec_1'), {
            target: { value: 'CONFIRM' },
        });
        // Modal opened — submit button is present.
        expect(screen.getByTestId('decision-modal-submit')).toBeTruthy();
        // CONFIRM shouldn't render the target-role select.
        expect(
            screen.queryByTestId('decision-modal-modified-to-role'),
        ).toBeNull();
    });

    it('picking MODIFY shows the target-role select', () => {
        render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview()}
                    currentUserId="usr_reviewer"
                    isAdmin={false}
                />,
            ),
        );
        fireEvent.change(screen.getByTestId('decision-select-dec_1'), {
            target: { value: 'MODIFY' },
        });
        expect(screen.getByTestId('decision-modal-modified-to-role')).toBeTruthy();
    });

    it('Close campaign button only renders for admins and is disabled while decisions are pending', () => {
        // Non-admin reviewer — no close button at all.
        const r1 = render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview()}
                    currentUserId="usr_reviewer"
                    isAdmin={false}
                />,
            ),
        );
        expect(screen.queryByTestId('access-review-close-button')).toBeNull();
        r1.unmount();

        // Admin — button visible but disabled (2 decisions pending).
        render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview()}
                    currentUserId="usr_admin"
                    isAdmin
                />,
            ),
        );
        const btn = screen.getByTestId('access-review-close-button') as HTMLButtonElement;
        expect(btn).toBeTruthy();
        expect(btn.disabled).toBe(true);
    });

    it('non-reviewer non-admin cannot see decision dropdowns', () => {
        render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview()}
                    currentUserId="usr_outsider"
                    isAdmin={false}
                />,
            ),
        );
        expect(screen.queryByTestId('decision-select-dec_1')).toBeNull();
        expect(screen.queryByTestId('decision-select-dec_2')).toBeNull();
    });

    it('CLOSED campaigns hide the dropdown but expose the download evidence button', () => {
        render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview({
                        status: 'CLOSED',
                        evidenceFileRecordId: 'file_pdf_1',
                        decisions: [
                            {
                                id: 'dec_1',
                                subjectUserId: 'usr_alice',
                                subjectUser: {
                                    id: 'usr_alice',
                                    email: 'alice@example.test',
                                    name: 'Alice',
                                },
                                snapshotRole: 'EDITOR',
                                snapshotMembershipStatus: 'ACTIVE',
                                decision: 'CONFIRM',
                                decidedAt: new Date().toISOString(),
                                decidedBy: {
                                    id: 'usr_reviewer',
                                    email: 'r@example.test',
                                    name: null,
                                },
                                notes: 'Still active and valid',
                                modifiedToRole: null,
                                executedAt: new Date().toISOString(),
                                membership: {
                                    id: 'mem_1',
                                    role: 'EDITOR',
                                    status: 'ACTIVE',
                                },
                            },
                        ],
                    })}
                    currentUserId="usr_admin"
                    isAdmin
                />,
            ),
        );
        expect(screen.queryByTestId('decision-select-dec_1')).toBeNull();
        expect(screen.getByTestId('access-review-download-evidence')).toBeTruthy();
    });
});

// ─── Step 5a — the CONNECTED_APP surface ─────────────────────────────────

describe('Step 5a — a CONNECTED_APP campaign renders and gates its own subjects', () => {
    function renderConnected(review: Record<string, unknown>, isAdmin = true) {
        return render(
            withClient(
                <AccessReviewDetailClient
                    tenantSlug="acme"
                    initialReview={makeReview(review) as never}
                    currentUserId="usr_admin"
                    isAdmin={isAdmin}
                />,
            ),
        );
    }

    it('renders the connected subjects, which the member table never showed', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [connectedSubject()],
        });
        expect(screen.getByTestId('access-review-connected-table')).toBeInTheDocument();
        expect(screen.getByTestId('connected-row-cdec_1')).toBeInTheDocument();
        expect(screen.getByText('Carol')).toBeInTheDocument();
        // The member roster is NOT rendered for a connected campaign.
        expect(screen.queryByTestId('access-review-roster-table')).not.toBeInTheDocument();
    });

    it('shows the HR context read from IdentityAccountLink', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [connectedSubject()],
        });
        expect(screen.getByText('Carol Danvers')).toBeInTheDocument();
        expect(screen.getByText(/Finance/)).toBeInTheDocument();
    });

    it('says so when an account is linked to no worker', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [
                connectedSubject({
                    snapshotJson: { provider: 'okta', email: 'svc@example.test', displayName: 'svc', isAdmin: false, mfaEnrolled: true, hr: null },
                }),
            ],
        });
        // `useTranslations` is mocked to the identity, so the key is the text.
        expect(screen.getByText('hrUnlinked')).toBeInTheDocument();
    });

    it('DISABLES Close while a connected subject is undecided', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [
                connectedSubject({ id: 'cdec_1', decision: 'CONFIRM' }),
                connectedSubject({ id: 'cdec_2', decision: null }),
            ],
        });
        expect(screen.getByTestId('access-review-close-button')).toBeDisabled();
    });

    it('ENABLES Close once every connected subject is decided', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [
                connectedSubject({ id: 'cdec_1', decision: 'CONFIRM' }),
                connectedSubject({ id: 'cdec_2', decision: 'REVOKE' }),
            ],
        });
        expect(screen.getByTestId('access-review-close-button')).not.toBeDisabled();
    });

    it('REGRESSION — Close is DISABLED on a campaign with zero subjects', () => {
        // The zero-equals-zero bug, in the UI. The gate was
        // `decided !== decisionsTotal`, which for 0 and 0 is false, so the
        // button was ENABLED: a connected campaign could be closed with every
        // subject undecided, from a page that showed no subjects at all.
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [],
        });
        expect(screen.getByTestId('access-review-close-button')).toBeDisabled();
    });

    it('REGRESSION — and disabled for a MEMBER campaign with zero subjects too', () => {
        // Same arithmetic, same answer. A member campaign that snapshotted
        // nobody evidences nothing either.
        renderConnected({ scope: 'ALL_USERS', decisions: [], connectedDecisions: [] });
        expect(screen.getByTestId('access-review-close-button')).toBeDisabled();
    });

    it('warns when the snapshot was truncated at the cap', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [connectedSubject({ decision: 'CONFIRM' })],
            snapshotTruncated: true,
        });
        expect(screen.getByTestId('access-review-snapshot-truncated')).toBeInTheDocument();
    });

    it('shows no truncation warning when the snapshot was complete', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [connectedSubject({ decision: 'CONFIRM' })],
            snapshotTruncated: false,
        });
        expect(screen.queryByTestId('access-review-snapshot-truncated')).not.toBeInTheDocument();
    });

    it('offers CONFIRM, REVOKE and MODIFY — every verdict the backend accepts', () => {
        renderConnected({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [connectedSubject()],
        });
        const select = screen.getByTestId('connected-decision-select-cdec_1');
        const values = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
        // `SubmitConnectedDecisionSchema` is z.enum(['CONFIRM','REVOKE','MODIFY'])
        // and the close path raises a remediation task for REVOKE *or* MODIFY,
        // so omitting MODIFY would drop a verdict the backend supports.
        expect(values).toEqual(['', 'CONFIRM', 'REVOKE', 'MODIFY']);
    });

    it('hides the verdict control from a non-admin non-reviewer', () => {
        renderConnected(
            { scope: 'CONNECTED_APP', decisions: [], connectedDecisions: [connectedSubject()] },
            false,
        );
        expect(screen.queryByTestId('connected-decision-select-cdec_1')).not.toBeInTheDocument();
    });
});
