/**
 * The Policies list, mounted, for two faults found while writing its help
 * guide (#4279):
 *
 *   1. Readers, Auditors and AI admins got row checkboxes and an empty
 *      selection bar, and a single click ticked a row instead of opening it.
 *      The page withheld the bar but never passed `selectionEnabled: false`,
 *      and the table's select column is on by default.
 *   2. Bulk Archive's confirmation read "Delete N policies?", "This removes
 *      the selected policies from your workspace.", with a red Delete button,
 *      because it passed `confirm: true` and took the bar's defaults.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
}));

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
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const routerPush = jest.fn();
jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = {
        push: routerPush,
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/policies',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { PoliciesClient } from '@/app/t/[tenantSlug]/(app)/policies/PoliciesClient';

type Props = React.ComponentProps<typeof PoliciesClient>;
type PolicyRow = Props['initialPolicies'][number];

const en = require('../../messages/en.json');
const BULK = en.policies.bulk;

const policy = (id: string, title: string): PolicyRow => ({
    id,
    title,
    status: 'DRAFT',
    category: null,
    owner: null,
    currentVersion: null,
    lifecycleVersion: 1,
    nextReviewAt: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
});
const ROWS = [policy('pol-1', 'Acceptable use'), policy('pol-2', 'Access control')];
const KPIS = { total: 2, draft: 2, inReview: 0, approved: 0, overdueReview: 0, outstandingAck: 0 };

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        const body: unknown = url.pathname.endsWith('/policies')
            ? { rows: ROWS, truncated: false, kpiCounts: KPIS }
            : {};
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

function mountAs(role: 'ADMIN' | 'READER') {
    const admin = role === 'ADMIN';
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <PoliciesClient
                    initialKpiCounts={KPIS}
                    initialPolicies={ROWS}
                    tenantSlug="acme"
                    permissions={{
                        canRead: true,
                        canWrite: admin,
                        canAdmin: admin,
                        canAudit: false,
                        canExport: true,
                    }}
                    translations={{ title: 'Policies', listDescription: '' }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

beforeEach(() => {
    routerPush.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/policies');
    installFetch();
});

describe('Policies list — what each role gets', () => {
    it('a Reader gets no row checkboxes', async () => {
        mountAs('READER');
        await screen.findByText('Acceptable use');
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('an Admin can tick rows (positive control for the case above)', async () => {
        mountAs('ADMIN');
        await screen.findByText('Acceptable use');
        expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });

    it("bulk Archive's confirmation names the archive, not a deletion", async () => {
        mountAs('ADMIN');
        await screen.findByText('Acceptable use');

        const boxes = screen.getAllByRole('checkbox');
        await act(async () => {
            fireEvent.click(boxes[0]);
        });
        const select = await waitFor(() => {
            const el = document.getElementById('bulk-action-select');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        fireEvent.click(select);
        const listbox = await screen.findByRole('listbox');
        fireEvent.click(within(listbox).getByRole('option', { name: BULK.archive }));
        fireEvent.click(document.getElementById('bulk-apply-btn') as HTMLElement);

        const dialog = await screen.findByRole('dialog');
        // The dialog renders its description twice (one copy for assistive tech).
        expect(within(dialog).getAllByText(BULK.archiveConfirmDesc).length).toBeGreaterThan(0);
        expect(within(dialog).getByRole('button', { name: BULK.archiveConfirmLabel })).toBeInTheDocument();
        // The bar's default verb and description, which this used to show.
        expect(within(dialog).queryByRole('button', { name: en.common.table.confirmVerbDelete })).toBeNull();
        expect(dialog.textContent).not.toContain('removes the selected');
    });
});
