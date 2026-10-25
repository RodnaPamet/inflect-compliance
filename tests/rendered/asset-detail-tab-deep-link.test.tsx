/**
 * The asset page opens on the tab its URL names (#4276).
 *
 * The assets list's Vulns badge counts open CVE matches AND open scanner
 * findings. It used to link to the global Vulnerabilities page, which lists
 * CVE matches only — so an asset whose open items were scanner findings
 * showed a number the linked page did not contain. It now links to
 * `/assets/<id>?tab=vulnerabilities` (asserted in
 * tests/rendered/assets-list-page.test.tsx), and this file holds the other
 * half: that URL lands on the Vulnerabilities tab, showing both sources.
 *
 * The tab used to be plain `useState('overview')`, so no URL could reach it.
 * The page now seeds it from `?tab=`, as the vendor and risk pages do.
 *
 * Also here: the page's Type meta shows the label, not the enum code.
 */
import * as React from 'react';
import { configure, render, screen, waitFor } from '@testing-library/react';
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
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            appPermissions: getPermissionsForRole('READER'),
        }),
        usePermissions: () => getPermissionsForRole('READER'),
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
const CVE_ROW = {
    id: 'av-1',
    status: 'OPEN',
    matchedVia: 'CPE',
    remediationDueAt: null,
    note: null,
    ownerUserId: null,
    ownerUser: null,
    cve: { id: 'CVE-2026-1234', cvssScore: 8.1, cvssSeverity: 'HIGH', summary: 'Heap overflow' },
};
const SCANNER_ROW = {
    id: 'sf-1',
    ruleId: 'js/sql-injection',
    severity: 'MEDIUM',
    title: 'SQL built from user input',
    location: 'src/db.ts:42',
    status: 'OPEN',
    scannerRun: { source: 'codeql', scanType: 'SAST', ranAt: '2026-10-01T00:00:00.000Z' },
};

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        let body: unknown = {};
        if (url.pathname === '/api/t/acme/assets/as-bravo') body = ASSET;
        else if (url.pathname === '/api/t/acme/vulnerabilities') body = { rows: [CVE_ROW] };
        else if (url.pathname === '/api/t/acme/assets/as-bravo/scanner-findings') body = { rows: [SCANNER_ROW] };
        else if (url.pathname.includes('/members')) body = [];
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

function mountWithQuery(query: string) {
    const sp = jest.requireMock('next/navigation').__searchParams as URLSearchParams;
    for (const k of Array.from(sp.keys())) sp.delete(k);
    for (const [k, v] of new URLSearchParams(query)) sp.set(k, v);
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <AssetDetailPage />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** Wait for the asset to load — its heading, which the breadcrumb also names. */
const loaded = () =>
    waitFor(() => expect(document.getElementById('asset-title-heading')?.textContent).toBe(ASSET.name));

const activeTabLabel = () =>
    screen
        .getAllByRole('tab')
        .find((el) => el.getAttribute('aria-selected') === 'true')
        ?.textContent?.trim();

beforeEach(() => {
    window.localStorage.clear();
    installFetch();
});

describe('Asset page — `?tab=` opens that tab', () => {
    it('?tab=vulnerabilities (the Vulns badge target) opens the Vulnerabilities tab with both sources', async () => {
        mountWithQuery('tab=vulnerabilities');
        await loaded();

        expect(activeTabLabel()).toBe(A.detail.tabs.vulnerabilities);
        await waitFor(() => expect(document.getElementById('asset-vulnerabilities-tab')).not.toBeNull());
        // What the badge counted, both halves: the open CVE match and the open
        // scanner finding.
        expect(await screen.findByText(CVE_ROW.cve.id)).toBeInTheDocument();
        expect(await screen.findByText(SCANNER_ROW.title)).toBeInTheDocument();
    });

    it('no tab parameter still opens Overview (old links keep working)', async () => {
        mountWithQuery('');
        await loaded();
        expect(activeTabLabel()).toBe(A.detail.tabs.overview);
        expect(document.getElementById('asset-vulnerabilities-tab')).toBeNull();
    });

    it('an unknown tab value falls back to Overview', async () => {
        mountWithQuery('tab=not-a-tab');
        await loaded();
        expect(activeTabLabel()).toBe(A.detail.tabs.overview);
    });
});

describe('Asset page — the Type meta is a label', () => {
    it('shows "Data Store", not the code', async () => {
        mountWithQuery('');
        await loaded();
        expect(screen.getAllByText(A.assetTypes.DATA_STORE).length).toBeGreaterThan(0);
        expect(screen.queryByText('DATA STORE')).toBeNull();
        expect(screen.queryByText('DATA_STORE')).toBeNull();
    });
});
