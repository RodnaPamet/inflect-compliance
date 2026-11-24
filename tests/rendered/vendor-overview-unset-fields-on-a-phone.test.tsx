/**
 * On a phone, the vendor Overview does not print a row of "—" for every field
 * nobody filled in (#5884).
 *
 * A new vendor's Overview was ten "Label: —" rows in a two-column grid at
 * 360px. Below `sm` an unset field is now hidden and named once, in a
 * "Not set: …" line; a set field is a row in one column. From `sm` up the
 * two-column grid shows every field, "—" included, as before.
 *
 * The harness mirrors `vendor-detail-gates-and-refusals.test.tsx`.
 */
import * as React from 'react';
import { configure, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);
configure({ asyncUtilTimeout: 10_000 });

const mockCtx = {
    tenantSlug: 'acme',
    tenantName: 'Acme',
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: {
        tasks: { create: true, edit: true },
        vendors: { view: true, create: true, edit: true },
    } as Record<string, unknown>,
};
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useTenantContext: () => mockCtx,
        usePermissions: () => mockCtx.permissions,
        useCurrentUserId: () => 'user-1',
    };
});

jest.mock('@/components/ui/hooks', () => {
    const toast = { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() };
    return {
        ...jest.requireActual('@/components/ui/hooks'),
        useToast: () => toast,
        useToastWithUndo: () => jest.fn(),
    };
});

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) for (const [p, val] of Object.entries(params)) s = s.split(`{${p}}`).join(String(val));
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: (d: Date) => d.toISOString(), number: (n: number) => String(n) }),
    };
});

jest.mock('next/navigation', () => {
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/vendors/v1',
        useSearchParams: () => new URLSearchParams('tab=overview'),
        useParams: () => ({ tenantSlug: 'acme', vendorId: 'v1' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import VendorDetailPage from '@/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page';

const EN = jest.requireActual('../../messages/en.json') as {
    vendors: { detail: Record<string, string> };
};
const D = EN.vendors.detail;

const BASE = {
    id: 'v1', name: 'Acme Cloud', legalName: null, websiteUrl: null, domain: 'acme.example', country: null,
    description: null, criticality: 'MEDIUM', status: 'ONBOARDING', inherentRisk: null, residualRisk: null,
    dataAccess: null, isSubprocessor: false, tags: [], owner: null, nextReviewAt: null, contractRenewalAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    _count: { documents: 0, assessments: 0, links: 0 },
};

function json(status: number, body: unknown) {
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

function serve(vendor: Record<string, unknown>) {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((input: string) => {
        if (String(input).endsWith('/api/t/acme/vendors/v1')) return json(200, vendor);
        return json(200, []);
    });
}

function settled<T>(value: T): Promise<T> {
    return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

async function mount() {
    render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <VendorDetailPage params={settled({ tenantSlug: 'acme', vendorId: 'v1' })} />
        </SWRConfig>,
    );
    await screen.findAllByText('Acme Cloud');
    return screen.findByTestId('vendor-overview-facts');
}

describe('vendor Overview on a phone', () => {
    it('is one column below sm and two from sm', async () => {
        serve(BASE);
        const facts = await mount();
        expect(facts).toHaveClass('grid-cols-1', 'sm:grid-cols-2');
        expect(facts).not.toHaveClass('grid-cols-2');
    });

    it('hides each unset field below sm and names it once in the "Not set" line', async () => {
        serve(BASE);
        await mount();

        // Set: a row at every width.
        for (const key of ['domain', 'subprocessor']) {
            expect(screen.getByTestId(`vendor-fact-${key}`)).not.toHaveClass('hidden');
        }
        // Unset: hidden below sm, shown (with its "—") from sm.
        const unset = ['legalName', 'website', 'country', 'owner', 'dataAccess', 'inherentRisk', 'nextReview', 'contractRenewal'];
        for (const key of unset) {
            const row = screen.getByTestId(`vendor-fact-${key}`);
            expect(row).toHaveClass('hidden', 'sm:block');
            expect(row.textContent).toContain('—');
        }

        const line = screen.getByTestId('vendor-overview-unset');
        expect(line).toHaveClass('sm:hidden');
        const named = [D.legalName, D.website, D.country, D.owner, D.dataAccess, D.inherentRisk, D.nextReview, D.contractRenewal];
        expect(line.textContent).toBe(D.notSet.replace('{fields}', named.join(', ')));
    });

    it('shows no "Not set" line when every field is filled in', async () => {
        serve({
            ...BASE,
            legalName: 'Acme Cloud Ltd', websiteUrl: 'https://acme.example', country: 'BG',
            owner: { id: 'u1', name: 'Ada' }, dataAccess: 'HIGH', inherentRisk: 'HIGH',
            nextReviewAt: '2027-01-01T00:00:00.000Z', contractRenewalAt: '2027-06-01T00:00:00.000Z',
        });
        await mount();
        expect(screen.queryByTestId('vendor-overview-unset')).toBeNull();
        for (const row of screen.getByTestId('vendor-overview-facts').children) {
            expect(row).not.toHaveClass('hidden');
        }
        // The calendar deep link's anchor is still the contract-renewal row.
        expect(document.getElementById('vendor-contract-renewal')).toBe(screen.getByTestId('vendor-fact-contractRenewal'));
    });
});
