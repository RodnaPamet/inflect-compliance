/** @jest-environment jsdom */

/**
 * An audit has an address.
 *
 * THE DEFECT
 * ----------
 * The findings register's Source column linked a finding to the audit it was
 * raised under. For a finding inside a cycle that worked — `/audits/cycles/…`
 * is a real route. For a finding raised against a standalone audit it linked
 * to `/t/{slug}/audits/{auditId}`, which has never existed: the audits hub is
 * a master-detail page, not a route per audit. Every such link 404'd.
 *
 * A stub `/audits/[id]` page would have been the wrong repair — it would mean
 * two renderings of the same audit drifting apart. The audit's address is the
 * hub with the pane already open, which is what `?selected=` now means.
 *
 * Two halves, and BOTH have to hold or the link is still dead:
 *   1. the register emits `?selected=<id>` (this is a URL, so a string
 *      assertion is the honest test — there is no richer object to inspect);
 *   2. the hub actually opens that audit on arrival.
 */

import * as React from 'react';
import { act, render, screen } from '@testing-library/react';

let currentSearch = new URLSearchParams();

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// See tests/rendered/auditor-revoke-safeguards.test.tsx — the repo-wide
// next-intl mock hands back a fresh `t` per render, which loops any component
// whose effects depend on it. Real next-intl memoises; so does this.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: String, number: String, relativeTime: String, list: (l: string[]) => l.join(', ') }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/audits',
    useSearchParams: () => currentSearch,
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { AuditsClient } from '@/app/t/[tenantSlug]/(app)/audits/AuditsClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const LIST_ROW = {
    id: 'audit-7',
    title: 'Q3 supplier audit',
    status: 'PLANNED',
    _count: { checklist: 3, findings: 1 },
};

const DETAIL = {
    id: 'audit-7',
    title: 'Q3 supplier audit',
    status: 'PLANNED',
    auditScope: 'Tier-1 suppliers',
    checklist: [],
    findings: [],
};

const TRANSLATIONS = {
    title: 'Audits', listDescription: '', newAudit: 'Audit', auditTitle: 'Title',
    auditors: 'Auditors', scope: 'Scope', createAudit: 'Create audit', cancel: 'Cancel',
    planned: 'Planned', inProgress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
    notTested: 'Not tested', pass: 'Pass', fail: 'Fail', checklist: 'Checklist',
    findingsTab: 'Findings', selectAudit: 'Select an audit',
};

const fetchMock = jest.fn();

beforeEach(() => {
    currentSearch = new URLSearchParams();
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        const body = /\/audits\/audit-7$/.test(u)
            ? DETAIL
            : u.includes('/audits/cycles')
                ? []
                : { rows: [LIST_ROW], truncated: false };
        return Promise.resolve({ ok: true, json: async () => body } as Response);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

async function renderHub() {
    const view = render(
        <TenantProvider value={TENANT_CTX}>
            <AuditsClient
                initialAudits={[LIST_ROW]}
                tenantSlug="acme"
                hasNis2={false}
                canWrite
                translations={TRANSLATIONS}
            />
        </TenantProvider>,
    );
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
    return view;
}

/** Detail GETs for one audit. */
function detailFetches() {
    return fetchMock.mock.calls.filter(([url]) => /\/audits\/audit-7$/.test(String(url)));
}

describe('the audits hub answers to ?selected=', () => {
    it('opens the audit named in the query param', async () => {
        currentSearch = new URLSearchParams('selected=audit-7');
        await renderHub();

        expect(detailFetches().length).toBeGreaterThan(0);
        // The pane is open, not merely fetched: the scope only renders there.
        expect(await screen.findByText('Tier-1 suppliers')).toBeTruthy();
    });

    it('opens nothing without the param', async () => {
        await renderHub();
        expect(detailFetches()).toHaveLength(0);
        expect(screen.queryByText('Tier-1 suppliers')).toBeNull();
    });

    it('fetches the audit once, not on every re-render', async () => {
        // The guard here is a ref, not an effect dependency: `selected` changes
        // on every row click, so a dep-guarded effect would drag the pane back
        // to the query param and make the list unclickable.
        currentSearch = new URLSearchParams('selected=audit-7');
        const { rerender } = await renderHub();
        await act(async () => {
            rerender(
                <TenantProvider value={TENANT_CTX}>
                    <AuditsClient
                        initialAudits={[LIST_ROW]}
                        tenantSlug="acme"
                        hasNis2={false}
                        canWrite
                        translations={TRANSLATIONS}
                    />
                </TenantProvider>,
            );
            await Promise.resolve();
        });
        expect(detailFetches()).toHaveLength(1);
    });
});

describe('the findings register points at an address that exists', () => {
    it('links a cycle-less audit to the hub, never to /audits/{id}', () => {
        // A URL is a string; there is nothing richer to assert. What makes
        // this worth pinning is that the old target rendered fine and 404'd
        // only on click — no test failed, no error was logged.
        const src = require('node:fs').readFileSync(
            require('node:path').resolve(
                __dirname,
                '../../src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx',
            ),
            'utf8',
        );
        // Anchored on `href=` rather than the whole file: the comment that
        // explains the old target quotes it verbatim, and a bare source scan
        // would fail on the very prose documenting the fix.
        const hrefs = src.match(/href=\{`[^`]*`\}/g) ?? [];
        expect(hrefs.some((h: string) => h.includes('audits?selected=${a.id}'))).toBe(true);
        expect(hrefs.some((h: string) => /audits\/\$\{a\.id\}/.test(h))).toBe(false);
    });
});
