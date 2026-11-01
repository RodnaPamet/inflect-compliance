/**
 * The External tools catalogue (#4899): the state badge speaks the statuses the
 * server sends, approval asks first and says what changed, the Owner-only
 * prior-state pairing is neither shown to nor requested for anybody else, and a
 * failed connection test is said.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/external-tools',
    useSearchParams: () => new URLSearchParams(),
}));

// Interpolating `t`. A mock that returned the raw key would leave every
// assertion below reading "externalTools.priorStateMissing" and passing without
// ever proving the copy says anything.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values ? v.replace(/\{(\w+)\}/g, (m, n) => (n in values ? String(values[n]) : m)) : v;
        };
        t.rich = t;
        return t;
    };
    // MEMOISED per namespace, for the same reason the provider mock below is.
    // `loadCatalogue` is a useCallback over [apiUrl, connectionId, t] and an
    // effect depends on it, so a fresh `t` each render rebuilds the callback,
    // re-fires the effect, and its first line -- setTools(null) -- blanks the
    // list. That surfaced as "the row vanishes after a refusal": a component
    // bug that did not exist, invented by the mock.
    const cache = new Map<string, ReturnType<typeof make>>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns)!;
        },
        useLocale: () => 'en',
    };
});

/**
 * STABLE function identities, and that is not a detail.
 *
 * Returning `(path) => ...` fresh from each hook call gives `apiUrl` a new
 * identity on every render, so `loadCatalogue`'s `useCallback` is rebuilt every
 * render and the effect that depends on it re-fires in a loop. Its first line is
 * `setTools(null)`, so the tool list blinks out constantly — which surfaced as
 * "the row disappeared after the server refused", a component bug that did not
 * exist. The real provider memoises these; the mock has to as well, or the test
 * measures the mock.
 */
const stableApiUrl = (path: string) => `/api/t/acme${path}`;
const stableHref = (path: string) => `/t/acme${path}`;
const stablePermissions = { admin: { manage: true, tenant_lifecycle: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => stableApiUrl,
    useTenantHref: () => stableHref,
    usePermissions: () => stablePermissions,
}));

import { ExternalToolsClient } from '@/app/t/[tenantSlug]/(app)/agents/external-tools/ExternalToolsClient';

const CONN = 'conn_1';

type Tool = {
    toolName: string;
    advertisedName: string;
    declaresWrite: boolean;
    status: string;
    blocked: boolean;
    liveDescription: string;
    liveSchema: string;
    liveManifestHash: string;
    approvedManifestHash: string | null;
    approvedAt: string | null;
    revision: number | null;
};

const tool = (name: string, over: Partial<Tool> = {}): Tool => ({
    toolName: `mcp__${CONN}__${name}`,
    advertisedName: name,
    declaresWrite: false,
    status: 'APPROVED',
    blocked: false,
    liveDescription: `${name} does a thing.`,
    liveSchema: '{}',
    liveManifestHash: 'h1abcdef012345',
    approvedManifestHash: 'h1abcdef012345',
    approvedAt: '2026-10-01T10:00:00.000Z',
    revision: 1,
    ...over,
});

const CATALOGUE = {
    tools: [
        tool('get_user'),
        tool('set_role', {
            declaresWrite: true,
            status: 'DESCRIPTION_CHANGED',
            blocked: true,
            liveManifestHash: 'h2',
            approvedManifestHash: 'h1',
        }),
        tool('new_tool', { status: 'UNPINNED', approvedManifestHash: null, approvedAt: null, revision: null }),
    ],
};

function mockFetch() {
    global.fetch = jest.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/admin/agents/external-tools')) {
            return { ok: true, json: async () => ({ ...CATALOGUE, refusedNames: 0 }) };
        }
        if (u.includes('/admin/external-prior-state-read')) {
            return { ok: true, json: async () => ({ pairings: [] }) };
        }
        return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
}

const renderPage = async (props: { canSetPriorState?: boolean; lastTestStatus?: string | null } = {}) => {
    render(
        <ExternalToolsClient
            tenantSlug="acme"
            connections={[{ id: CONN, name: 'HRM', lastTestStatus: props.lastTestStatus ?? null }]}
            canReviewProposals
            canInvestigate
            canSetPriorState={props.canSetPriorState}
        />,
    );
    await screen.findByTestId('external-tool-status-set_role', undefined, { timeout: 5000 });
};

const fetchedUrls = () => (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));

beforeEach(() => mockFetch());

describe('the state badge (#4899)', () => {
    it('labels each status the catalogue sends, and a change in the warning tone', async () => {
        await renderPage();
        expect(screen.getByTestId('external-tool-status-get_user')).toHaveTextContent('Approved');
        expect(screen.getByTestId('external-tool-status-new_tool')).toHaveTextContent('Never approved');
        const changed = screen.getByTestId('external-tool-status-set_role');
        expect(changed).toHaveTextContent('Description changed');
        // The changed one does not share the never-approved one's tone.
        expect(changed.className).not.toBe(screen.getByTestId('external-tool-status-new_tool').className);
    });

    it('says when a definition was last approved', async () => {
        await renderPage();
        expect(screen.getAllByText(/^Last approved /).length).toBeGreaterThan(0);
    });
});

describe('approving asks first', () => {
    it('opens a confirmation naming what changed, and approves only on confirm', async () => {
        await renderPage();
        const row = screen.getByTestId('external-tool-status-set_role').closest('li') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', { name: 'Re-approve' }));
        expect((await screen.findAllByText(/Description changed since this tool was last approved/)).length).toBeGreaterThan(0);
        expect((global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);

        fireEvent.click(screen.getAllByRole('button', { name: 'Approve definition' })[0]);
        await waitFor(() =>
            expect((global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1),
        );
    });
});

describe('the prior-state pairing for a viewer who is not an owner', () => {
    it('is not requested, and the write tool says an owner sets it', async () => {
        await renderPage({ canSetPriorState: false });
        expect(fetchedUrls().some((u) => u.includes('/admin/external-prior-state-read'))).toBe(false);
        expect(screen.getByTestId('prior-state-owner-only-set_role')).toBeInTheDocument();
        expect(screen.queryByTestId('prior-state-pairing-set_role')).toBeNull();
    });

    it('an owner still gets the control', async () => {
        await renderPage({ canSetPriorState: true });
        expect(await screen.findByTestId('prior-state-pairing-set_role')).toBeInTheDocument();
    });
});

describe('the connection’s last test', () => {
    it('warns when it failed', async () => {
        await renderPage({ lastTestStatus: 'error' });
        expect(screen.getByTestId('external-tools-last-test-failed')).toBeInTheDocument();
    });

    it('says nothing when it passed', async () => {
        await renderPage({ lastTestStatus: 'ok' });
        expect(screen.queryByTestId('external-tools-last-test-failed')).toBeNull();
    });
});
