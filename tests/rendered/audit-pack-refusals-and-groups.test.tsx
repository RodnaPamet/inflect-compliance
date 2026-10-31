/** @jest-environment jsdom */

/**
 * The pack page says what it can name (#4700).
 *
 *   - The header names the cycle's framework, not its short key.
 *   - A refusal with a known reason is the page's own sentence in the user's
 *     language, not the server's English one.
 *   - A refused item list is said in the add dialog, not shown as an empty
 *     and disabled picker that reads as "nothing to add".
 *   - An item group past 50 offers "Show all", instead of silently stopping
 *     under a heading that counts every item.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';

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
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
import { __setConfettiForTest } from '@inflect/ui/components/ui/hooks/use-celebration';
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

const EN = (jest.requireActual('../../messages/en.json') as {
    audits: { packs: Record<string, string> & { refused: Record<string, string>; addPicker: Record<string, string> } };
}).audits.packs;

type Answer = { status: number; body: unknown };

let serverPack: Record<string, unknown>;
let freezeAnswer: Answer | null;
let controlsAnswer: Answer;

function controlItems(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        id: `it-${i}`, entityType: 'CONTROL', entityId: `c${i}`,
        snapshotJson: JSON.stringify({ code: `CTRL-${String(i).padStart(3, '0')}` }), sortOrder: i,
    }));
}

function packWith(items: unknown[], cycle: Record<string, unknown> = { id: 'cycle-1', frameworkKey: 'ISO27001', frameworkName: 'ISO/IEC 27001:2022' }) {
    return {
        id: 'pack-1', name: 'FY26 ISO pack', status: 'DRAFT', frozenAt: null, frozenBy: null,
        cycle, items, _count: { items: items.length, shares: 0 },
    };
}

const fetchMock = jest.fn();

beforeEach(() => {
    // The freeze's optimistic FROZEN fires the celebration; jsdom has no canvas.
    __setConfettiForTest(() => Promise.resolve(null));
    serverPack = packWith(controlItems(1));
    freezeAnswer = null;
    controlsAnswer = { status: 200, body: [] };
    (sonnerToast.error as jest.Mock).mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const answer = ({ status, body }: Answer) =>
            ({ ok: status < 300, status, json: async () => body }) as Response;
        if (init?.method === 'POST' && u.includes('action=freeze') && freezeAnswer) return answer(freezeAnswer);
        if (/\/controls$/.test(u)) return answer(controlsAnswer);
        if (/\/audits\/packs\/pack-1\/share-comments$/.test(u)) return answer({ status: 200, body: { comments: [], openCount: 0 } });
        if (/\/audits\/packs\/pack-1\/shares$/.test(u)) return answer({ status: 200, body: [] });
        if (/\/audits\/packs\/pack-1$/.test(u)) return answer({ status: 200, body: { ...serverPack } });
        return answer({ status: 200, body: [] });
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
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <PackDetailPage />
            </TenantProvider>
        </SWRConfig>,
    );
    await waitFor(() => expect(document.getElementById('pack-name')).toBeTruthy());
    await flush();
    return view;
}

describe('the header', () => {
    it('names the framework, not its short key', async () => {
        await renderPack();
        expect(document.body.textContent).toContain('ISO/IEC 27001:2022');
        expect(document.body.textContent).not.toContain('ISO27001');
    });

    it('falls back to the key when the catalogue no longer names it', async () => {
        serverPack = packWith(controlItems(1), { id: 'cycle-1', frameworkKey: 'LEGACY_FW', frameworkName: null });
        await renderPack();
        expect(document.body.textContent).toContain('LEGACY_FW');
    });
});

describe('a refused freeze', () => {
    it('says the named reason in the user’s language', async () => {
        freezeAnswer = {
            status: 400,
            body: { error: { code: 'BAD_REQUEST', message: 'Cannot freeze an empty pack', details: { reason: 'PACK_EMPTY' } } },
        };
        await renderPack();
        await act(async () => { fireEvent.click(document.getElementById('freeze-pack-btn')!); });
        const confirm = await screen.findByText(/freeze pack/i, { selector: 'button, button *' }).catch(() => null);
        const btn = confirm?.closest('button') ?? (document.querySelector('[data-modal-confirm]') as HTMLElement | null);
        await act(async () => { fireEvent.click(btn!); });

        await waitFor(() => expect(sonnerToast.error).toHaveBeenCalled());
        expect((sonnerToast.error as jest.Mock).mock.calls[0][0]).toBe(EN.refused.PACK_EMPTY);
    });

    it('keeps the server’s sentence for a refusal the page cannot name', async () => {
        freezeAnswer = { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Something specific.' } } };
        await renderPack();
        await act(async () => { fireEvent.click(document.getElementById('freeze-pack-btn')!); });
        const confirm = await screen.findByText(/freeze pack/i, { selector: 'button, button *' }).catch(() => null);
        const btn = confirm?.closest('button') ?? (document.querySelector('[data-modal-confirm]') as HTMLElement | null);
        await act(async () => { fireEvent.click(btn!); });

        await waitFor(() => expect(sonnerToast.error).toHaveBeenCalled());
        expect((sonnerToast.error as jest.Mock).mock.calls[0][0]).toBe('Something specific.');
    });
});

describe('the add dialog', () => {
    async function openAdd() {
        await act(async () => { fireEvent.click(document.getElementById('add-pack-items-btn') ?? screen.getByText(EN.addItems)); });
        return screen.findByRole('dialog');
    }

    it('says a refused list read failed, instead of offering nothing', async () => {
        controlsAnswer = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
        await renderPack();
        const dialog = await openAdd();
        expect(await within(dialog).findByText(EN.addPicker.loadError)).toBeTruthy();
        expect(within(dialog).queryByText(EN.addPicker.noneOfType)).toBeNull();
    });

    it('says when there is genuinely nothing of the type to add', async () => {
        controlsAnswer = { status: 200, body: [] };
        await renderPack();
        const dialog = await openAdd();
        expect(await within(dialog).findByText(EN.addPicker.noneOfType)).toBeTruthy();
        expect(within(dialog).queryByText(EN.addPicker.loadError)).toBeNull();
    });
});

describe('a long item group', () => {
    it('lists the first 50, then all of them on request', async () => {
        serverPack = packWith(controlItems(60));
        await renderPack();
        expect(screen.getByText('CTRL-049')).toBeTruthy();
        expect(screen.queryByText('CTRL-050')).toBeNull();

        const showAll = screen.getByRole('button', { name: EN.showAllItems.replace('{count}', '60') });
        await act(async () => { fireEvent.click(showAll); });
        expect(screen.getByText('CTRL-059')).toBeTruthy();
        expect(screen.queryByRole('button', { name: EN.showAllItems.replace('{count}', '60') })).toBeNull();
    });

    it('offers nothing extra for a group of 50 or fewer', async () => {
        serverPack = packWith(controlItems(50));
        await renderPack();
        expect(screen.getByText('CTRL-049')).toBeTruthy();
        expect(document.querySelector('[id^="show-all-pack-items-"]')).toBeNull();
    });
});
