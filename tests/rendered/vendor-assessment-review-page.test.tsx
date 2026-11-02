/** @jest-environment jsdom */

/**
 * Reviewing one vendor assessment (#4936): the page words what it shows,
 * asks before closing, and offers pre-fill only while answers can change.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// A stable translator per namespace, as next-intl gives.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

// Stable, as the real provider's are: a new function each render would
// re-run the page's load effect forever.
jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path}`;
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const ctx = { permissions: { canAdmin: true, canWrite: true, canRead: true } };
    return { useTenantHref: () => href, useTenantApiUrl: () => apiUrl, useTenantContext: () => ctx };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/vendor-assessment-reviews/as-1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock(
    '@/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/_components/AssessmentPrefillPanel',
    () => ({ AssessmentPrefillPanel: () => <div data-testid="prefill-panel" /> }),
);

import { VendorAssessmentReviewClient } from '@/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/VendorAssessmentReviewClient';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: {
        assessmentReview: Record<string, string> & {
            modeLabel: Record<string, string>;
            verdictLabel: Record<string, string>;
        };
        vendorAnswerType: Record<string, string>;
    };
    vendors: { criticalityLabel: Record<string, string>; reviewQueue: Record<string, string> };
};
const AR = EN.admin.assessmentReview;

function view(status: string, overrides: Record<string, unknown> = {}) {
    return {
        assessmentId: 'as-1',
        status,
        vendor: { id: 'v-1', name: 'Acme Cloud' },
        template: { id: 't-1', key: 'soc2', version: 3, name: 'SOC 2 questionnaire', description: null },
        sections: [
            {
                id: 's-1',
                title: 'Access',
                description: null,
                questions: [
                    {
                        id: 'q-1',
                        sectionId: 's-1',
                        sortOrder: 0,
                        prompt: 'Do you enforce MFA?',
                        answerType: 'YES_NO',
                        required: true,
                        weight: 2,
                        optionsJson: null,
                        scaleConfigJson: null,
                    },
                ],
            },
        ],
        answers: [
            { questionId: 'q-1', answerJson: { value: 'YES' }, computedPoints: 2, reviewerOverridePoints: null, reviewerNotes: null },
        ],
        scoring: {
            mode: 'WEIGHTED_AVERAGE',
            score: 80,
            autoSum: 2,
            effectiveSum: 2,
            totalWeight: 2,
            suggestedRating: 'HIGH',
        },
        submittedAt: '2026-10-01T00:00:00.000Z',
        reviewedAt: null,
        reviewerNotes: null,
        riskRating: null,
        closedAt: null,
        ...overrides,
    };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => {
    (global.fetch as jest.Mock | undefined)?.mockReset?.();
});

describe('vendor assessment review page', () => {
    it('words the scoring mode, suggested rating, answer type and weight', async () => {
        global.fetch = jest.fn().mockResolvedValue(ok(view('SUBMITTED'))) as unknown as typeof fetch;
        render(<VendorAssessmentReviewClient assessmentId="as-1" />);

        expect(await screen.findByText(AR.modeLabel.WEIGHTED_AVERAGE)).toBeInTheDocument();
        expect(screen.getByText(EN.vendors.criticalityLabel.HIGH)).toBeInTheDocument();
        expect(screen.getByText(EN.admin.vendorAnswerType.YES_NO)).toBeInTheDocument();
        expect(screen.getByText(AR.weight.replace('{weight}', '2'))).toBeInTheDocument();
        for (const code of ['WEIGHTED AVERAGE', 'YES_NO', 'w=2']) {
            expect(screen.queryByText(code)).toBeNull();
        }
    });

    it('shows the trail back to the review queue', async () => {
        global.fetch = jest.fn().mockResolvedValue(ok(view('SUBMITTED'))) as unknown as typeof fetch;
        render(<VendorAssessmentReviewClient assessmentId="as-1" />);

        expect(await screen.findByRole('link', { name: EN.vendors.reviewQueue.title })).toHaveAttribute(
            'href',
            '/t/acme/admin/vendor-assessment-reviews',
        );
    });

    it('asks before closing, and closes only on confirmation', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(ok(view('REVIEWED', { riskRating: 'MEDIUM' }))) as unknown as typeof fetch;
        render(<VendorAssessmentReviewClient assessmentId="as-1" />);

        fireEvent.click(await screen.findByRole('button', { name: AR.closeAssessment }));
        expect((await screen.findAllByText(AR.closeConfirmTitle)).length).toBeGreaterThan(0);
        const posted = () =>
            (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).endsWith('/close'));
        expect(posted()).toHaveLength(0);

        const confirmButtons = screen.getAllByRole('button', { name: AR.closeAssessment });
        fireEvent.click(confirmButtons[confirmButtons.length - 1]);
        await waitFor(() => expect(posted()).toHaveLength(1));
    });

    it.each(['REVIEWED', 'CLOSED'])('offers no pre-fill on a %s assessment', async (status) => {
        global.fetch = jest.fn().mockResolvedValue(ok(view(status, { riskRating: 'LOW' }))) as unknown as typeof fetch;
        render(<VendorAssessmentReviewClient assessmentId="as-1" />);

        await screen.findByText(AR.modeLabel.WEIGHTED_AVERAGE);
        expect(screen.queryByTestId('prefill-panel')).toBeNull();
    });

    it('offers pre-fill while the assessment is under review', async () => {
        global.fetch = jest.fn().mockResolvedValue(ok(view('SUBMITTED'))) as unknown as typeof fetch;
        render(<VendorAssessmentReviewClient assessmentId="as-1" />);

        expect(await screen.findByTestId('prefill-panel')).toBeInTheDocument();
    });
});
