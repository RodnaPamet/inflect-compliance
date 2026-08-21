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
        lastActivityByUser: { usr_alice: new Date('2026-04-30').toISOString() },
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
