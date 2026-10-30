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
import { render, screen } from '@testing-library/react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
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
});
