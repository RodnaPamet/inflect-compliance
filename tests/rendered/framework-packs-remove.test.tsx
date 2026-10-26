/**
 * #4372 — the Packs tab takes a chosen pack out of a workspace's scope.
 *
 * What a person sees and what reaches the server:
 *   - on a framework with several packs, the chosen ones are marked and offer
 *     Remove pack; a pack nobody chose offers no removal;
 *   - the POST goes out only when the undo window closes, and Undo sends
 *     nothing and puts the pack back;
 *   - the last chosen pack cannot be removed from the page either;
 *   - a viewer who cannot install frameworks sees no removal at all.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

// ─── sonner shim: capture the undo toast so its Undo button is reachable ──
interface CustomCall { id: number; factory: (id: number) => React.ReactElement }
const customCalls: CustomCall[] = [];
let nextSonnerId = 1;
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((msg: string) => msg, {
        custom: (factory: (id: number) => React.ReactElement) => {
            const id = nextSonnerId++;
            customCalls.push({ id, factory });
            return id;
        },
        dismiss: (id: string | number) => id,
        success: jest.fn(),
        error: jest.fn(),
        warning: jest.fn(),
        info: jest.fn(),
        message: jest.fn(),
        loading: jest.fn(),
    }),
}));

// The page's load effect lists `t` in its deps. The repo-wide next-intl mock
// returns a fresh `t` per render, which re-runs the effect for ever; real
// next-intl memoises per namespace, so this mock does too.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            for (const [p, val] of Object.entries(params ?? {})) v = (v as string).split(`{${p}}`).join(String(val));
            return v;
        };
        t.rich = (key: string) => String(resolve(ns, key) ?? key);
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'EU-UAS-OPS' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/frameworks/EU-UAS-OPS',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: undefined, error: undefined, isLoading: false, mutate: jest.fn() }),
}));

let canInstall = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    usePermissions: () => ({ frameworks: { install: canInstall, view: true } }),
}));

import FrameworkDetailPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetPendingUndoToastsForTest } from '@/components/ui/hooks/use-toast-with-undo';

const en = require('../../messages/en.json');
const CHOSEN: string = en.frameworks.detail.packChosen;

type Pack = { id: string; key: string; name: string; chosen: boolean };
let serverPacks: Pack[] = [];
const fetchMock = jest.fn();

function installFetch() {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        let body: unknown;
        if (init?.method === 'POST' && url.includes('action=remove-pack')) {
            const { packKey } = JSON.parse(String(init.body)) as { packKey: string };
            serverPacks = serverPacks.map((p) => (p.key === packKey ? { ...p, chosen: false } : p));
            body = { packKey, framework: 'EU-UAS-OPS', remainingChosenPacks: serverPacks.filter((p) => p.chosen).length };
        } else if (url.endsWith('/tree')) {
            body = {
                framework: { id: 'fw', key: 'EU-UAS-OPS', name: 'EU drone operations', version: '2025', kind: 'REGULATION', description: null },
                nodes: [],
                totals: { sections: 0, requirements: 0, maxDepth: 0 },
            };
        } else if (url.includes('action=packs')) {
            body = serverPacks.map((p) => ({ ...p, description: null, version: null, _count: { templateLinks: 3 } }));
        } else if (url.includes('action=coverage')) {
            body = {
                framework: { key: 'EU-UAS-OPS', name: 'EU drone operations', version: '2025' },
                total: 10, mapped: 5, unmapped: 5, coveragePercent: 50,
                bySection: [], unmappedRequirements: [], controlMappings: [],
            };
        } else {
            body = {
                id: 'fw', key: 'EU-UAS-OPS', name: 'EU drone operations', version: '2025', description: null,
                kind: 'REGULATION', _count: { requirements: 10, packs: serverPacks.length },
            };
        }
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
}

const removePosts = () =>
    fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('action=remove-pack'));

async function renderPacksTab() {
    render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <KeyboardShortcutProvider>
                <TooltipProvider>
                    <FrameworkDetailPage />
                </TooltipProvider>
            </KeyboardShortcutProvider>
        </SWRConfig>,
    );
    const tab = await screen.findByRole('tab', { name: /Packs/ });
    await act(async () => { fireEvent.click(tab); });
    await waitFor(() => expect(document.getElementById('packs-panel')).not.toBeNull());
}

const byId = (id: string) => document.getElementById(id);

beforeEach(() => {
    customCalls.length = 0;
    __resetPendingUndoToastsForTest();
    canInstall = true;
    serverPacks = [
        { id: 'p1', key: 'EU_UAS_OPEN_A1', name: 'A1', chosen: false },
        { id: 'p2', key: 'EU_UAS_OPEN_A2', name: 'A2', chosen: true },
        { id: 'p3', key: 'EU_UAS_OPEN_A3', name: 'A3', chosen: true },
    ];
    fetchMock.mockReset();
    installFetch();
});

describe('Packs tab — removing a chosen pack (#4372)', () => {
    it('marks the chosen packs and offers removal only on them', async () => {
        await renderPacksTab();
        expect(screen.getAllByText(CHOSEN)).toHaveLength(2);
        expect(byId('remove-pack-EU_UAS_OPEN_A2')).not.toBeNull();
        expect(byId('remove-pack-EU_UAS_OPEN_A3')).not.toBeNull();
        expect(byId('remove-pack-EU_UAS_OPEN_A1')).toBeNull();
        // Two chosen: both removable.
        expect(byId('remove-pack-EU_UAS_OPEN_A3')!.getAttribute('aria-disabled')).toBeNull();
    });

    it('sends the removal only when the undo window closes', async () => {
        await renderPacksTab();
        jest.useFakeTimers();
        try {
            await act(async () => { fireEvent.click(byId('remove-pack-EU_UAS_OPEN_A3')!); });
            expect(customCalls).toHaveLength(1);
            expect(removePosts()).toHaveLength(0);
            // Optimistically no longer chosen.
            expect(byId('remove-pack-EU_UAS_OPEN_A3')).toBeNull();

            await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
        } finally {
            jest.useRealTimers();
        }
        await waitFor(() => expect(removePosts()).toHaveLength(1));
        expect(JSON.parse(String(removePosts()[0][1]?.body))).toEqual({ packKey: 'EU_UAS_OPEN_A3' });
        // The page rereads the scope afterwards.
        await waitFor(() => expect(screen.getAllByText(CHOSEN)).toHaveLength(1));
    });

    it('Undo sends nothing and puts the pack back', async () => {
        await renderPacksTab();
        jest.useFakeTimers();
        try {
            await act(async () => { fireEvent.click(byId('remove-pack-EU_UAS_OPEN_A3')!); });
            const host = document.createElement('div');
            document.body.appendChild(host);
            const last = customCalls[customCalls.length - 1];
            const undoView = render(last.factory(last.id), { container: host });
            await act(async () => { fireEvent.click(undoView.getByRole('button', { name: /undo/i })); });
            await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
        } finally {
            jest.useRealTimers();
        }
        expect(removePosts()).toHaveLength(0);
        expect(byId('remove-pack-EU_UAS_OPEN_A3')).not.toBeNull();
    });

    it('will not remove the last chosen pack', async () => {
        serverPacks = serverPacks.map((p) => ({ ...p, chosen: p.key === 'EU_UAS_OPEN_A2' }));
        await renderPacksTab();
        const button = byId('remove-pack-EU_UAS_OPEN_A2')!;
        expect(button).not.toBeNull();
        // The disabled shell: no <button>, and says why.
        expect(button.getAttribute('aria-disabled')).toBe('true');
        await act(async () => { fireEvent.click(button); });
        expect(customCalls).toHaveLength(0);
        expect(removePosts()).toHaveLength(0);
    });

    it('offers no removal to a viewer who cannot install frameworks', async () => {
        canInstall = false;
        await renderPacksTab();
        expect(screen.getAllByText(CHOSEN)).toHaveLength(2);
        expect(byId('remove-pack-EU_UAS_OPEN_A2')).toBeNull();
        expect(byId('remove-pack-EU_UAS_OPEN_A3')).toBeNull();
    });
});
