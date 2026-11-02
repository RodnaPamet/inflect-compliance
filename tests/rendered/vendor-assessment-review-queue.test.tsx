/** @jest-environment jsdom */

/**
 * The vendor assessment review queue words each risk rating and keeps HTTP
 * status codes out of its load error (#4935).
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

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
    return { useTenantHref: () => href, useTenantApiUrl: () => apiUrl };
});
jest.mock('@/lib/nav/use-guarded-push', () => ({ useGuardedPush: () => jest.fn() }));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/vendor-assessment-reviews',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { VendorAssessmentReviewsQueueClient } from '@/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/VendorAssessmentReviewsQueueClient';

const EN = jest.requireActual('../../messages/en.json') as {
    vendors: {
        criticalityLabel: Record<string, string>;
        reviewQueue: Record<string, string>;
    };
};

function row(id: string, riskRating: string | null) {
    return {
        id,
        vendorId: `v-${id}`,
        vendorName: `Vendor ${id}`,
        status: 'SUBMITTED',
        score: 72,
        riskRating,
        submittedAt: '2026-10-01T00:00:00.000Z',
        reviewedAt: null,
    };
}

afterEach(() => {
    (global.fetch as jest.Mock | undefined)?.mockReset?.();
});

describe('vendor assessment review queue', () => {
    it('words the risk rating rather than printing the stored code', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [row('a', 'CRITICAL'), row('b', 'LOW')],
        }) as unknown as typeof fetch;
        render(<VendorAssessmentReviewsQueueClient />);
        expect(await screen.findByText(EN.vendors.criticalityLabel.CRITICAL)).toBeInTheDocument();
        expect(screen.getByText(EN.vendors.criticalityLabel.LOW)).toBeInTheDocument();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('CRITICAL')).toBeNull();
    });

    it('says the queue could not load without naming an HTTP status', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({}),
        }) as unknown as typeof fetch;
        render(<VendorAssessmentReviewsQueueClient />);
        await waitFor(() =>
            expect(screen.getByText(EN.vendors.reviewQueue.loadError)).toBeInTheDocument(),
        );
        expect(screen.queryByText(/500/)).toBeNull();
    });
});
