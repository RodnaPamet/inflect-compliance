/**
 * The asset page's status control says why a change was refused.
 *
 * The API's refusal is `{ error: { message } }`. The control read a top-level
 * `message`, which the API never sends, so every refusal showed the generic
 * "status change failed" sentence instead of the server's reason.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(120_000);
configure({ asyncUtilTimeout: 15_000 });

jest.mock('@/lib/tenant-context-provider', () => {
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    return {
        useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
        useTenantContext: () => ({
            tenantSlug: 'acme',
            tenantName: 'Acme',
            permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
            appPermissions: getPermissionsForRole('EDITOR'),
        }),
        usePermissions: () => getPermissionsForRole('EDITOR'),
        useCurrentUserId: () => 'user-1',
    };
});

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    // ONE instance, mutated per test before mount.
    const searchParams = new URLSearchParams();
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/assets/as-bravo',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme', id: 'as-bravo' }),
        __searchParams: searchParams,
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import AssetDetailPage from '@/app/t/[tenantSlug]/(app)/assets/[id]/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const en = require('../../messages/en.json');
const A = en.assets;

const ASSET = {
    id: 'as-bravo',
    key: 'AST-2',
    name: 'Bravo ledger',
    type: 'DATA_STORE',
    status: 'ACTIVE',
    classification: null,
    owner: null,
    ownerUserId: null,
    ownerUser: null,
    location: null,
    criticality: 'MEDIUM',
    dataResidency: null,
    externalRef: null,
    dependencies: null,
    businessProcesses: null,
    retention: null,
    retentionUntil: null,
    confidentiality: 3,
    integrity: 3,
    availability: 3,
    cpe: null,
    vendor: null,
    product: null,
    version: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    rollups: {
        risks: { count: 0 },
        controls: { count: 0 },
        vulnerabilities: { openCount: 2, maxSeverity: 'HIGH', maxScore: 8.1 },
        tasks: { openCount: 0, total: 0 },
    },
};

function installFetch(patch: { status: number; body: unknown }, asset: Record<string, unknown> = ASSET) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        let status = 200;
        let body: unknown = {};
        if (url.pathname === '/api/t/acme/assets/as-bravo' && init?.method === 'PATCH') {
            status = patch.status;
            body = patch.body;
        } else if (url.pathname === '/api/t/acme/assets/as-bravo') body = asset;
        else if (url.pathname.includes('/members')) body = [];
        else body = { rows: [] };
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <AssetDetailPage />
            </TooltipProvider>
        </SWRConfig>,
    );
}

async function retire() {
    await waitFor(() => expect(document.getElementById('asset-title-heading')?.textContent).toBe(ASSET.name));
    await act(async () => {
        fireEvent.click(document.getElementById('asset-status-select') as HTMLElement);
    });
    const option = await screen.findByRole('option', { name: A.detail.statusRetired });
    await act(async () => {
        fireEvent.click(option);
    });
}

describe('Asset page — a refused status change says why', () => {
    it("shows the server's reason", async () => {
        installFetch({
            status: 400,
            body: { error: { code: 'BAD_REQUEST', message: 'Retired assets cannot own open risks', requestId: 'r1' } },
        });
        mount();
        await retire();
        expect(await screen.findByText('Retired assets cannot own open risks')).toBeInTheDocument();
    });

    it('falls back to the page sentence when no reason came back', async () => {
        installFetch({ status: 502, body: {} });
        mount();
        await retire();
        const fallback = A.detail.changeStatusFailed.replace(/\{status[^}]*\}/, '502');
        expect(await screen.findByText(fallback)).toBeInTheDocument();
    });
});

describe('Asset page — stored codes read as words (#4693)', () => {
    it('labels criticality, status, classification and residency', async () => {
        // `INTERNAL` is what onboarding writes; the form writes `Internal`.
        installFetch(
            { status: 200, body: {} },
            { ...ASSET, criticality: 'HIGH', classification: 'INTERNAL', dataResidency: 'EU' },
        );
        mount();
        await waitFor(() => expect(document.getElementById('asset-title-heading')?.textContent).toBe(ASSET.name));

        expect(screen.getAllByText(A.filterEnums.criticality.HIGH).length).toBeGreaterThan(0);
        expect(screen.queryByText('HIGH')).toBeNull();
        expect(screen.queryByText('ACTIVE')).toBeNull();
        expect(await screen.findByText(A.formOptions.classification.Internal)).toBeInTheDocument();
        expect(screen.queryByText('INTERNAL')).toBeNull();
        expect(screen.getByText(A.formOptions.residency.EU)).toBeInTheDocument();
    });
});
