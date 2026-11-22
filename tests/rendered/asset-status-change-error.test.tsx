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

// Overridable per test: `mockTier` is the coarse tier, `mockAppPermissions`
// the granular keys (undefined: the EDITOR built-in role's).
let mockTier = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
let mockAppPermissions: unknown;
jest.mock('@/lib/tenant-context-provider', () => {
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    const keys = () => mockAppPermissions ?? getPermissionsForRole('EDITOR');
    return {
        useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
        useTenantContext: () => ({
            tenantSlug: 'acme',
            tenantName: 'Acme',
            permissions: mockTier,
            appPermissions: keys(),
        }),
        usePermissions: () => keys(),
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
        // The page's own sentence, and no status code (#4987).
        expect(await screen.findByText(A.detail.changeStatusFailedGeneric)).toBeInTheDocument();
        expect(screen.queryByText(/502/)).toBeNull();
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

// ─── A refused vulnerability change says why (#4963) ────────────────

const VULN = {
    id: 'av-1',
    status: 'OPEN',
    matchedVia: 'CPE',
    remediationDueAt: null,
    note: null,
    ownerUserId: null,
    cve: { id: 'CVE-2026-0001', cvssScore: 8.1, cvssSeverity: 'HIGH', summary: 'Heap overflow' },
    ownerUser: null,
};

/** The asset, one vulnerability on it, and the PATCH answering `patch`. */
function installVulnFetch(patch: { status: number; body: unknown }) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        let status = 200;
        let body: unknown = { rows: [] };
        if (url.pathname === '/api/t/acme/vulnerabilities/av-1' && init?.method === 'PATCH') {
            status = patch.status;
            body = patch.body;
        } else if (url.pathname === '/api/t/acme/vulnerabilities') body = { rows: [VULN] };
        else if (url.pathname === '/api/t/acme/assets/as-bravo') body = ASSET;
        else if (url.pathname.includes('/members')) body = [];
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function markMitigated() {
    const sp = jest.requireMock('next/navigation').__searchParams as URLSearchParams;
    sp.set('tab', 'vulnerabilities');
    mount();
    await screen.findByText('CVE-2026-0001');
    const picker = screen.getByRole('combobox', { name: A.detail.vuln.status });
    await act(async () => {
        fireEvent.click(picker);
    });
    const option = await screen.findByRole('option', { name: en.vulnerabilities.filterEnums.status.MITIGATED });
    await act(async () => {
        fireEvent.click(option);
    });
}

describe('Asset page — a refused vulnerability change says why', () => {
    afterEach(() => {
        (jest.requireMock('next/navigation').__searchParams as URLSearchParams).delete('tab');
    });

    it("shows the server's reason, not the generic sentence", async () => {
        installVulnFetch({
            status: 403,
            body: { error: { code: 'FORBIDDEN', message: 'Only the owner may close this vulnerability', requestId: 'r1' } },
        });
        await markMitigated();
        expect(await screen.findByText('Only the owner may close this vulnerability')).toBeInTheDocument();
        expect(screen.queryByText(A.detail.vuln.updateFailed)).toBeNull();
    });

    it('falls back to the page sentence when no reason came back, never a status code', async () => {
        installVulnFetch({ status: 502, body: {} });
        await markMitigated();
        expect(await screen.findByText(A.detail.vuln.updateFailed)).toBeInTheDocument();
        expect(screen.queryByText(/HTTP 502/)).toBeNull();
    });
});

describe('Asset page — controls follow the keys the routes take (#5160)', () => {
    afterEach(() => {
        mockTier = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
        mockAppPermissions = undefined;
    });

    it('an EDITOR-based role without assets.edit is offered no edit or status change', async () => {
        const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
        const editor = getPermissionsForRole('EDITOR');
        mockAppPermissions = { ...editor, assets: { ...editor.assets, edit: false } };
        installFetch({ status: 200, body: {} });
        mount();
        await waitFor(() => expect(document.getElementById('asset-title-heading')?.textContent).toBe(ASSET.name));
        expect(document.getElementById('asset-status-select')).toBeNull();
        expect(document.getElementById('edit-asset-btn')).toBeNull();
    });

    it('an ADMIN-based role without admin.manage is offered no Delete', async () => {
        const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
        const admin = getPermissionsForRole('ADMIN');
        mockTier = { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true };
        mockAppPermissions = { ...admin, admin: { ...admin.admin, manage: false } };
        installFetch({ status: 200, body: {} });
        mount();
        await waitFor(() => expect(document.getElementById('asset-title-heading')?.textContent).toBe(ASSET.name));
        expect(document.getElementById('asset-delete-btn')).toBeNull();
        // The edit affordances it does hold stay.
        expect(document.getElementById('asset-status-select')).not.toBeNull();
    });

    it('the built-in EDITOR still edits', async () => {
        installFetch({ status: 200, body: {} });
        mount();
        await waitFor(() => expect(document.getElementById('asset-title-heading')?.textContent).toBe(ASSET.name));
        expect(document.getElementById('asset-status-select')).not.toBeNull();
        expect(document.getElementById('edit-asset-btn')).not.toBeNull();
    });
});
