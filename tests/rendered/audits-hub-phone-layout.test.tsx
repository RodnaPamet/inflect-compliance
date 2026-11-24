/** @jest-environment jsdom */

/**
 * The Internal Audit hub on a phone (#5894): the list first, the lifecycle
 * guide last and behind a disclosure, no empty "select an audit" panel, and
 * choosing an audit scrolls to its detail. From md up the page is unchanged.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

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
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
    modules: { processCanvas: false },
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

/** A viewport below `md` (a phone), or at/above it. */
const realMatchMedia = window.matchMedia;
function setViewport(phone: boolean) {
    window.matchMedia = ((query: string) => ({
        matches: query.includes('max-width: 767.98px') ? phone : false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;
}
const scrollIntoView = jest.fn();
beforeAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
    window.matchMedia = realMatchMedia;
    scrollIntoView.mockClear();
});

const hub = () => screen.getByTestId('audits-hub');
const lifecycle = () => document.getElementById('audit-lifecycle')!;
const list = () => screen.getByTestId('audits-list');

describe('the Internal Audit hub on a phone', () => {
    it('puts the list before the lifecycle guide', async () => {
        await renderHub();
        // One flex column, ordered by `order` below md: the guide alone moves,
        // to the end, so everything else — the list included — keeps its
        // place ahead of it. From md up the source order holds.
        expect(hub().className).toMatch(/(^| )flex( |$)/);
        expect(hub().className).toContain('flex-col');
        expect(lifecycle().parentElement).toBe(hub());
        expect(lifecycle().className).toContain('max-md:order-last');
        const reordered = Array.from(hub().children).filter((el) => /(^| )max-md:order-/.test(el.className));
        expect(reordered).toEqual([lifecycle()]);
        expect(hub().contains(list())).toBe(true);
        expect(list()).toHaveTextContent('Q3 supplier audit');
    });

    it('collapses the guide behind a disclosure, and opens it on request', async () => {
        await renderHub();
        const toggle = screen.getByTestId('audit-lifecycle-toggle');
        expect(toggle.className).toContain('md:hidden');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const parts = ['audit-lifecycle-subtitle', 'audit-lifecycle-links', 'audit-lifecycle-steps'];
        for (const id of parts) expect(document.getElementById(id)!.className).toContain('max-md:hidden');
        expect(toggle.getAttribute('aria-controls')).toBe(parts.join(' '));

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        for (const id of parts) expect(document.getElementById(id)!.className).not.toContain('max-md:hidden');
        // Every step stays a link in the guide.
        expect(document.getElementById('audits-cycles-link')).not.toBeNull();
    });

    it('draws no empty detail panel until an audit is chosen', async () => {
        await renderHub();
        const empty = screen.getByText(TRANSLATIONS.selectAudit);
        expect(empty.parentElement!.className).toContain('max-md:hidden');
    });

    it('scrolls the chosen audit\'s detail into view on a phone', async () => {
        setViewport(true);
        await renderHub();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Q3 supplier audit/ }));
        });
        const detail = await screen.findByTestId('audit-detail');
        expect(detail.parentElement!.className).not.toContain('max-md:hidden');
        expect(scrollIntoView).toHaveBeenCalled();
        expect(scrollIntoView.mock.contexts.at(-1)).toBe(detail);
    });

    it('does not scroll from md up, where the detail sits beside the list', async () => {
        setViewport(false);
        await renderHub();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Q3 supplier audit/ }));
        });
        await screen.findByTestId('audit-detail');
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});
