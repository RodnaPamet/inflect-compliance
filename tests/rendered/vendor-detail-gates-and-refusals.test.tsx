/**
 * The vendor detail page's writes follow `vendors.edit`, and a refused write
 * says so (#5313).
 *
 *   - Every vendor write route asks `vendors.edit` alone; the page asked the
 *     coarse write tier, and showed "Resend invite" with no gate at all.
 *   - Creating a bundle or adding a sub-processor ignored the response, so a
 *     refused add cleared the form as if it had worked.
 *
 * The harness mirrors `vendor-detail-edit-refusal.test.tsx`.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);
configure({ asyncUtilTimeout: 10_000 });

// ONE instance per value: the page's loaders are `useCallback`s over them.
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

const mockToastError = jest.fn();
jest.mock('@/components/ui/hooks', () => {
    const toast = { error: (...a: unknown[]) => mockToastError(...a), success: jest.fn(), info: jest.fn(), warning: jest.fn() };
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

const mockSearch = { tab: 'overview' };
jest.mock('next/navigation', () => {
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/vendors/v1',
        useSearchParams: () => new URLSearchParams(`tab=${mockSearch.tab}`),
        useParams: () => ({ tenantSlug: 'acme', vendorId: 'v1' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import VendorDetailPage from '@/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page';

const VENDOR = {
    id: 'v1', name: 'Acme Cloud', legalName: null, websiteUrl: null, domain: 'acme.example', country: null,
    description: null, criticality: 'MEDIUM', status: 'ONBOARDING', inherentRisk: null, residualRisk: null,
    dataAccess: null, isSubprocessor: false, tags: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    _count: { documents: 0, assessments: 0, links: 0 },
};
const SENT_ASSESSMENT = {
    id: 'as-1', status: 'SENT', score: null, riskRating: null, templateName: 'SIG Lite',
    startedAt: null, sentAt: '2026-10-01T00:00:00.000Z', submittedAt: null, reviewedAt: null, closedAt: null,
    respondentEmail: 'sec@acme.example', inviteExpiresAt: '2099-01-01T00:00:00.000Z', inviteRevokedAt: null,
};

let bundleCreateStatus = 200;
function json(status: number, body: unknown) {
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

beforeEach(() => {
    mockSearch.tab = 'overview';
    bundleCreateStatus = 200;
    mockToastError.mockReset();
    mockCtx.permissions = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
    mockCtx.appPermissions = { tasks: { create: true, edit: true }, vendors: { view: true, create: true, edit: true } };
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.endsWith('/api/t/acme/vendors/v1')) return json(200, VENDOR);
        if (method === 'GET' && url.endsWith('/vendors/v1/assessments')) return json(200, [SENT_ASSESSMENT]);
        if (method === 'POST' && url.endsWith('/vendors/v1/bundles')) {
            return json(bundleCreateStatus, bundleCreateStatus < 400 ? { id: 'b1' } : { error: { code: 'FORBIDDEN', message: 'Bundles are not enabled on this plan.' } });
        }
        return json(200, []);
    });
});

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
}

describe('vendor detail — writes follow vendors.edit', () => {
    it('a write-tier role without vendors.edit is offered no edit, autofill or resend', async () => {
        mockCtx.appPermissions = { tasks: { create: true, edit: true }, vendors: { view: true, create: false, edit: false } };
        await mount();
        expect(document.getElementById('edit-vendor-btn')).toBeNull();
        expect(document.getElementById('enrich-vendor-btn')).toBeNull();
    });

    it('a write-tier role without vendors.edit is not offered "Resend invite"', async () => {
        mockSearch.tab = 'assessments';
        mockCtx.appPermissions = { tasks: { create: true, edit: true }, vendors: { view: true, create: false, edit: false } };
        await mount();
        await screen.findByText('sec@acme.example', { exact: false });
        expect(document.getElementById('resend-assessment-as-1')).toBeNull();
    });

    it('a role holding vendors.edit is offered them', async () => {
        mockSearch.tab = 'assessments';
        await mount();
        await screen.findByText('sec@acme.example', { exact: false });
        expect(document.getElementById('resend-assessment-as-1')).not.toBeNull();
    });
});

describe('vendor detail — a refused add says why and keeps what was typed', () => {
    it('a refused bundle create keeps its name and says why', async () => {
        mockSearch.tab = 'bundles';
        bundleCreateStatus = 403;
        await mount();
        const name = await waitFor(() => {
            const el = document.getElementById('bundle-name-input') as HTMLInputElement | null;
            expect(el).not.toBeNull();
            return el as HTMLInputElement;
        });
        fireEvent.change(name, { target: { value: 'Q4 evidence' } });
        await act(async () => { fireEvent.click(document.getElementById('create-bundle-btn') as HTMLElement); });
        await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Bundles are not enabled on this plan.'));
        expect((document.getElementById('bundle-name-input') as HTMLInputElement).value).toBe('Q4 evidence');
    });
});
