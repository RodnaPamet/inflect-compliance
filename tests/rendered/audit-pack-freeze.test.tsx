/** @jest-environment jsdom */

/**
 * Freezing a pack, through the SWR mutation that replaced the hand-rolled fetch.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The pack page's seven writes were migrated to `useTenantMutation` with no
 * rendered test. Two E2E specs then began failing at exactly this step —
 * `#pack-status` stuck on "Draft" after a freeze whose response had already
 * arrived — and the only way to tell a product bug from an E2E flake was to
 * drive the component directly. That is what this does.
 *
 * THE SHAPE MISMATCH THAT MAKES IT SUBTLE
 * ---------------------------------------
 * `GET /audits/packs/:id` returns the pack WITH `items`, `cycle`, `_count` and
 * `frozenBy`. `POST ?action=freeze` returns a bare `auditPack.update()` row
 * plus `snapshotFailures` — none of those relations. So the response cannot
 * simply be written into the cache (`populateCache: true` would blank the
 * page), which is why the migration relied on a follow-up revalidation, which
 * is what opened the window these tests close.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// The repo-wide next-intl mock hands back a fresh `t` per render, which loops
// any component whose effects depend on it. Real next-intl memoises; so does
// this. See tests/rendered/auditor-revoke-safeguards.test.tsx.
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
    useParams: () => ({ tenantSlug: 'acme', packId: 'pack-1' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/audits/packs/pack-1',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import PackDetailPage from '@/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page';
import { __setConfettiForTest } from '@/components/ui/hooks/use-celebration';
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

/** The server's pack, mutated by the fake freeze so re-reads see the new state. */
let serverPack: Record<string, unknown>;

function freshPack() {
    return {
        id: 'pack-1',
        name: 'FY26 ISO pack',
        status: 'DRAFT',
        frozenAt: null,
        frozenBy: null,
        cycle: { id: 'cycle-1', name: 'FY26', frameworkKey: 'ISO27001' },
        items: [
            { id: 'it-1', entityType: 'CONTROL', entityId: 'c1', snapshotJson: '{}', sortOrder: 0 },
        ],
        _count: { items: 1, shares: 0 },
    };
}

const fetchMock = jest.fn();
let freezeShouldFail = false;
/** Freeze resolution is held open so a test can interleave a stale read. */
let holdFreeze: (() => void) | null = null;

beforeEach(() => {
    // Reaching FROZEN fires the Epic 62 celebration, and jsdom has no canvas —
    // `getContext` returns null and confetti throws on `clearRect`, which
    // surfaces as an unhandled exception that fails the test for a reason that
    // has nothing to do with freezing. The hook ships a seam for exactly this.
    __setConfettiForTest(() => Promise.resolve(null));
    serverPack = freshPack();
    freezeShouldFail = false;
    holdFreeze = null;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

        if (init?.method === 'POST' && u.includes('action=freeze')) {
            if (holdFreeze) {
                await new Promise<void>((resolve) => { holdFreeze = resolve; });
            }
            if (freezeShouldFail) {
                return { ok: false, json: async () => ({ message: 'nope' }) } as Response;
            }
            serverPack.status = 'FROZEN';
            serverPack.frozenAt = '2026-08-10T00:00:00.000Z';
            // The REAL freeze response: no items / cycle / _count / frozenBy.
            return ok({
                id: 'pack-1', name: 'FY26 ISO pack', status: 'FROZEN',
                frozenAt: '2026-08-10T00:00:00.000Z', frozenByUserId: 'user-1',
                snapshotFailures: [],
            });
        }
        if (/\/audits\/packs\/pack-1\/share-comments$/.test(u)) return ok({ comments: [], openCount: 0 });
        if (/\/audits\/packs\/pack-1\/shares$/.test(u)) return ok([]);
        if (/\/audits\/packs\/pack-1$/.test(u)) return ok({ ...serverPack });
        return ok([]);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

async function flush(times = 4) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

async function renderPack() {
    const view = render(
        // A fresh, isolated SWR cache per test — a shared one would leak the
        // frozen pack from one test into the next and hide exactly the bug
        // this file is about.
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <PackDetailPage />
            </TenantProvider>
        </SWRConfig>,
    );
    await flush();
    return view;
}

/** Click Freeze, then confirm in the dialog. */
async function clickFreeze() {
    await act(async () => { fireEvent.click(document.getElementById('freeze-pack-btn')!); });
    const confirm = await screen.findByText(/freeze pack/i, { selector: 'button, button *' })
        .catch(() => null);
    const btn = confirm?.closest('button')
        ?? document.querySelector('[data-modal-confirm]') as HTMLElement | null;
    await act(async () => { fireEvent.click(btn!); });
}

function statusText() {
    return document.getElementById('pack-status')?.textContent?.trim() ?? '';
}

describe('freezing a pack', () => {
    it('renders the pack as Draft before anything happens', async () => {
        await renderPack();
        expect(document.getElementById('pack-name')).toBeTruthy();
        expect(statusText()).toMatch(/draft/i);
    });

    it('sends the freeze POST once', async () => {
        await renderPack();
        await clickFreeze();
        await waitFor(() =>
            expect(
                fetchMock.mock.calls.filter(
                    ([u, i]) => i?.method === 'POST' && String(u).includes('action=freeze'),
                ),
            ).toHaveLength(1),
        );
    });

    it('the badge ends up Frozen — the E2E assertion, at component level', async () => {
        // `#pack-status` reading "Draft" after a completed freeze is precisely
        // what two E2E specs saw. If the mutation's cache handling is wrong,
        // this fails here, deterministically, instead of once in ten CI runs.
        await renderPack();
        await clickFreeze();
        await waitFor(() => expect(statusText()).toMatch(/frozen/i), { timeout: 3000 });
    });

    it('keeps the GET-only relations after the freeze response lands', async () => {
        // The freeze response carries no `items` / `cycle` / `_count`. Writing
        // it into the cache verbatim would blank the page while still reading
        // "Frozen" — a pass on status alone would miss that entirely.
        await renderPack();
        await clickFreeze();
        await waitFor(() => expect(statusText()).toMatch(/frozen/i), { timeout: 3000 });
        expect(document.getElementById('pack-name')?.textContent).toContain('FY26 ISO pack');
        expect(document.body.textContent).toContain('ISO27001');
    });

    it('a failed freeze leaves the badge on Draft, not on an unsaved Frozen', async () => {
        await renderPack();
        freezeShouldFail = true;
        await clickFreeze();
        await flush(8);
        expect(statusText()).toMatch(/draft/i);
        expect(serverPack.status).toBe('DRAFT');
    });
});
