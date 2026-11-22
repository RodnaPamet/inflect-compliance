/**
 * THE ASSET'S VULNERABILITIES TAB (#5313).
 *
 *   1. Open vulnerabilities are filtered on the SERVER. The read is capped and
 *      ordered by score, so filtering a capped all-status read in the browser
 *      dropped open rows sitting behind resolved ones. "Show resolved" asks
 *      for every status.
 *   2. A read that reaches the cap says the asset may have more.
 *   3. A vulnerability already converted shows a link to what it became, not
 *      a convert button whose every press is a 409.
 */
import * as React from 'react';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
            permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
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
    const searchParams = new URLSearchParams('tab=vulnerabilities');
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/assets/as-bravo',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme', id: 'as-bravo' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import AssetDetailPage from '@/app/t/[tenantSlug]/(app)/assets/[id]/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const A = require('../../messages/en.json').assets;

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

function cve(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        status: 'OPEN',
        matchedVia: 'CPE',
        remediationDueAt: null,
        note: null,
        ownerUserId: null,
        ownerUser: null,
        convertedRisk: null,
        convertedFinding: null,
        cve: { id: `CVE-2026-${id}`, cvssScore: 8.1, cvssSeverity: 'HIGH', summary: 'Heap overflow' },
        ...over,
    };
}

let vulnRows: unknown[] = [];
let vulnUrls: string[] = [];

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        let body: unknown = {};
        if (url.pathname === '/api/t/acme/assets/as-bravo') body = ASSET;
        else if (url.pathname === '/api/t/acme/vulnerabilities') {
            vulnUrls.push(`${url.pathname}${url.search}`);
            body = { rows: vulnRows };
        } else if (url.pathname === '/api/t/acme/assets/as-bravo/scanner-findings') body = { rows: [] };
        else if (url.pathname.includes('/members') || url.pathname.includes('/users/')) body = [];
        return {
            ok: true,
            status: 200,
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

beforeEach(() => {
    window.localStorage.clear();
    vulnRows = [];
    vulnUrls = [];
    installFetch();
});

it('asks the server for OPEN rows, and for every status once resolved rows are shown', async () => {
    vulnRows = [cve('1')];
    mount();
    expect(await screen.findByText('CVE-2026-1')).toBeInTheDocument();
    expect(vulnUrls).toContain('/api/t/acme/vulnerabilities?assetId=as-bravo&status=OPEN');

    fireEvent.click(document.getElementById('asset-vulns-show-resolved') as HTMLElement);
    await waitFor(() => expect(vulnUrls).toContain('/api/t/acme/vulnerabilities?assetId=as-bravo'));
});

it('says when the read reached the cap, and not before', async () => {
    vulnRows = Array.from({ length: 200 }, (_, i) => cve(String(i)));
    const view = mount();
    expect(await screen.findByTestId('asset-vulns-capped')).toHaveTextContent(
        A.detail.vuln.capped.replace('{count}', '200'),
    );
    view.unmount();

    vulnRows = [cve('1')];
    mount();
    expect(await screen.findByText('CVE-2026-1')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-vulns-capped')).toBeNull();
});

it('links a converted vulnerability to what it became, and offers the other conversion', async () => {
    vulnRows = [cve('9', { convertedRisk: { id: 'risk-7', key: 'RSK-7', deletedAt: null } })];
    mount();
    const link = await screen.findByTestId('asset-vuln-converted-risk-9');
    expect(link).toHaveAttribute('href', '/t/acme/risks/risk-7');
    expect(link).toHaveTextContent('RSK-7');
    expect(screen.queryByRole('button', { name: A.detail.vuln.convertToRisk })).toBeNull();
    expect(screen.getByRole('button', { name: A.detail.vuln.convertToFinding })).toBeInTheDocument();
});

it('offers the conversion again when what it made was deleted', async () => {
    vulnRows = [cve('9', { convertedRisk: { id: 'risk-7', key: 'RSK-7', deletedAt: '2026-10-01T00:00:00.000Z' } })];
    mount();
    expect(await screen.findByRole('button', { name: A.detail.vuln.convertToRisk })).toBeInTheDocument();
    expect(screen.queryByTestId('asset-vuln-converted-risk-9')).toBeNull();
});
