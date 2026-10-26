/**
 * The Risks list's bulk bar offers only the actions the server will accept.
 *
 * It used to offer Set status, Assign owner and Delete to every role, and
 * the routes refused what the role could not do — a READER's status change
 * and an EDITOR's delete both ended in "Bulk action failed". Which actions a
 * user holds is decided server-side by `riskBulkPermissions`
 * (tests/unit/risk-bulk-permissions.test.ts maps every role); this file
 * mounts the real client with each outcome and reads what the bar offers.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

// Mounting the whole risks page tree is a one-off module load that can run
// to tens of seconds on a loaded machine; every assertion is about WHAT
// renders, so buy headroom rather than trade flake for speed.
jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string) => {
            const v = walk(walk(en, ns), key);
            return typeof v === 'string' ? v : key;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    // ONE hoisted instance — a fresh URLSearchParams per call is a new
    // identity every render and re-runs the effects that depend on it.
    const searchParams = new URLSearchParams();
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/risks',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { RisksClient } from '@/app/t/[tenantSlug]/(app)/risks/RisksClient';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

type Props = React.ComponentProps<typeof RisksClient>;
type RiskRow = Props['initialRisks'][number];

const BULK = require('../../messages/en.json').risks.bulk;

const RISK: RiskRow = {
    id: 'risk-1',
    key: 'RSK-1',
    title: 'Ransomware on the file server',
    threat: 'Ransomware',
    likelihood: 3,
    impact: 4,
    inherentScore: 12,
    score: 12,
    treatment: null,
    status: 'OPEN',
    controls: [],
};

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        const body: unknown = url.pathname.endsWith('/risks') ? { rows: [RISK], truncated: false } : {};
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** Every translation key the server page passes, read as its own key. */
const translations = new Proxy({} as Props['translations'], { get: (_t, key) => String(key) });

function mount(bulkPermissions: Props['bulkPermissions']) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <RisksClient
                    initialRisks={[RISK]}
                    matrixConfig={DEFAULT_RISK_MATRIX_CONFIG}
                    tenantSlug="acme"
                    permissions={{ canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true }}
                    bulkPermissions={bulkPermissions}
                    canCreate
                    translations={translations}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** Select every row, then read the actions the bulk bar offers (null = no bar). */
async function offeredActions(): Promise<string[] | null> {
    await screen.findByText(RISK.title);
    const boxes = await screen.findAllByRole('checkbox');
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = document.getElementById('bulk-action-select');
    if (!select) return null;
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/risks');
    installFetch();
});

describe('Risks list — the bulk actions each permission set gets', () => {
    it('edit and delete: Set status, Assign owner and Delete', async () => {
        mount({ canEdit: true, canDelete: true });
        expect(await offeredActions()).toEqual([BULK.setStatus, BULK.assignOwner, BULK.delete]);
    });

    it('edit only (an EDITOR): Set status and Assign owner, never Delete', async () => {
        mount({ canEdit: true, canDelete: false });
        expect(await offeredActions()).toEqual([BULK.setStatus, BULK.assignOwner]);
    });

    it('delete only: Delete alone', async () => {
        mount({ canEdit: false, canDelete: true });
        expect(await offeredActions()).toEqual([BULK.delete]);
    });

    it('neither (a READER or AUDITOR): rows still select, and no bulk bar appears', async () => {
        mount({ canEdit: false, canDelete: false });
        expect(await offeredActions()).toBeNull();
        await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked());
    });
});
