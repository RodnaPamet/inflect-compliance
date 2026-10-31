/**
 * The vendors dashboard reports a failed load when its request never
 * completes (#4585).
 *
 * Its loader had no `try`: a network rejection skipped `setLoading(false)`,
 * so the page showed its skeleton for ever and said nothing. The rejection
 * also floated, which is what `no-floating-promises` found. A non-ok response
 * already reached the "could not load" message; a rejection now reaches the
 * same one.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

// Stable, as the real `useTenantApiUrl` (a `useCallback` over the slug) is:
// a fresh function per render would re-run the loader's effect every render.
const apiUrl = (p: string) => `/api/t/acme${p}`;
const tenantHref = (p: string) => `/t/acme${p}`;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => apiUrl,
    useTenantHref: () => tenantHref,
}));

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/vendors/dashboard',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import VendorDashboardPage from '@/app/t/[tenantSlug]/(app)/vendors/dashboard/page';

describe('the vendors dashboard when its request fails', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    it('a network failure reads as a failed load, not a skeleton that never ends', async () => {
        global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch')) as typeof fetch;
        render(<VendorDashboardPage />);
        expect(await screen.findByText('dashboard.loadFailed')).toBeTruthy();
    });

    it('a non-ok response reads the same way, which is the state a network failure now reaches', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
        render(<VendorDashboardPage />);
        expect(await screen.findByText('dashboard.loadFailed')).toBeTruthy();
    });

    it('a 403 says the figures are not yours to see, with no retry (#4799)', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }) as unknown as typeof fetch;
        render(<VendorDashboardPage />);
        expect(await screen.findByText('dashboard.loadForbidden')).toBeTruthy();
        expect(document.getElementById('vendor-dashboard-retry')).toBeNull();
    });

    it('a failed load offers a retry that reads again (#4799)', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
            .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        global.fetch = fetchMock as unknown as typeof fetch;
        render(<VendorDashboardPage />);
        await screen.findByText('dashboard.loadFailed');
        fireEvent.click(document.getElementById('vendor-dashboard-retry') as HTMLElement);
        await screen.findByText('dashboard.loadFailed');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
