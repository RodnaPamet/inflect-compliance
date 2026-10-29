/**
 * Step 3a (#4155): CONNECT AN AGENT YOU RUN, on the agent's page.
 *
 * The sheet mints a key bound to this agent through the api-keys route and
 * hands back the configuration for the customer's own agent. What these tests
 * hold:
 *
 *   • a person without the api-keys permission (a READER) is told why, and no
 *     grant is read and no key is requested;
 *   • an agent that is not active, or holds no grants, is explained, not minted
 *     for;
 *   • the mint asks for exactly the grants' scopes, this agent, and a ceiling
 *     at or below the agent's own level, which is the most the picker offers;
 *   • both tabs render, and `allowedTools` names the grants and nothing else;
 *   • the key is sent nowhere after the mint, and is gone once the sheet
 *     closes.
 */
import * as React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(120_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const walk = (root: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({ device: 'desktop', width: 1280, height: 851, isMobile: false, isTablet: false, isDesktop: true }),
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => swr(key),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

// The shell's tabs and other actions fetch on mount; none is under test here.
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab', () => ({ OverviewTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ServicePrincipalLinkCard', () => ({ ServicePrincipalLinkCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OwnershipTransferCard', () => ({ OwnershipTransferCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentKillSwitchAction', () => ({
    AgentKillSwitchAction: () => null,
    AgentKillSwitchBanner: () => null,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentAmendModal', () => ({ AgentAmendModal: () => null }));

import { AgentDetailClient, type AgentDetailPermissions } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';

const EN = jest.requireActual('../../messages/en.json') as { admin: { agentDetail: { connect: Record<string, unknown> } } };
const copy = (path: string, params: Record<string, string | number> = {}): string => {
    let v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.admin.agentDetail.connect,
    );
    if (typeof v !== 'string') throw new Error(`messages/en.json has no admin.agentDetail.connect.${path}`);
    for (const [p, val] of Object.entries(params)) v = (v as string).replace(`{${p}}`, String(val));
    return v as string;
};

const AGENT = {
    id: 'agent-1',
    name: 'Risk reviewer',
    status: 'ACTIVE',
    autonomyLevel: 2,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'REVERSIBLE',
    provenance: 'FIRST_PARTY',
    riskTier: 'LOW',
    aiActRiskTier: 'MINIMAL',
    description: null,
    modelRef: null,
    ownerUserId: 'user-1',
    vendorId: null,
    registrationEnforced: true,
};

const ADMIN: AgentDetailPermissions = {
    canReadRegistry: true,
    canManageRegistry: true,
    canEditPolicyCard: true,
    canGrantTools: true,
    canKill: true,
    canCloseBreaker: true,
    canMintKeys: true,
};
const READER: AgentDetailPermissions = {
    canReadRegistry: true,
    canManageRegistry: false,
    canEditPolicyCard: false,
    canGrantTools: false,
    canKill: false,
    canCloseBreaker: false,
    canMintKeys: false,
};

const PLAINTEXT = 'iflk_' + 'k'.repeat(40);
const GRANTS = ['list_risks', 'propose_risks'];

let fetchMock: jest.Mock;
const realFetch = global.fetch;

/** jsdom has no `Response`; the sheet reads `ok`, `status` and `json()` only. */
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

function grantsAre(tools: string[] | null) {
    swr.mockImplementation((key: string | null) =>
        key === null || tools === null
            ? { data: undefined, error: undefined, isLoading: false, mutate: jest.fn() }
            : { data: { agentId: 'agent-1', granted: tools.map((toolName) => ({ toolName })) }, error: undefined, isLoading: false, mutate: jest.fn() },
    );
}

beforeEach(() => {
    swr.mockReset();
    grantsAre(GRANTS);
    fetchMock = jest.fn(async () => reply(201, { id: 'key-1', plaintext: PLAINTEXT }));
    global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    cleanup();
    global.fetch = realFetch;
});

const renderPage = (perms: AgentDetailPermissions, agent = AGENT) =>
    render(<AgentDetailClient tenantSlug="acme" agent={agent} perms={perms} owners={[]} vendors={[]} />);

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('agent-connect-action'));
    return screen.findByTestId('connect-agent-sheet');
}

async function mint(user: ReturnType<typeof userEvent.setup>) {
    await openSheet(user);
    await user.click(await screen.findByTestId('connect-agent-mint'));
    return screen.findByTestId('connect-agent-key');
}

const mintBody = () => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;

describe('who may connect', () => {
    it('a READER is told why, and no grant is read and no key is requested', async () => {
        const user = userEvent.setup();
        renderPage(READER);
        await openSheet(user);
        expect(screen.getByTestId('connect-agent-blocked-permission').textContent).toContain(copy('blocked.permission'));
        expect(screen.queryByTestId('connect-agent-form')).toBeNull();
        expect(swr.mock.calls.every(([key]) => key === null)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an agent that is not active is explained, not minted for', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN, { ...AGENT, status: 'SUSPENDED' });
        await openSheet(user);
        expect(screen.getByTestId('connect-agent-blocked-inactive')).toBeTruthy();
        expect(screen.queryByTestId('connect-agent-mint')).toBeNull();
    });

    it('an agent with no grants is explained: a key for it could call nothing', async () => {
        grantsAre([]);
        const user = userEvent.setup();
        renderPage(ADMIN);
        await openSheet(user);
        expect(screen.getByTestId('connect-agent-blocked-grantsEmpty')).toBeTruthy();
        expect(screen.queryByTestId('connect-agent-mint')).toBeNull();
    });

    it('the paired positive: an admin reads the grants and is offered the mint', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN);
        await openSheet(user);
        expect(swr).toHaveBeenCalledWith('/admin/agents/agent-1/tools');
        expect(screen.getByTestId('connect-agent-mint')).toBeTruthy();
    });
});

describe('the mint', () => {
    it('asks the api-keys route for the grants\' scopes, this agent, and the agent\'s own level', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN);
        await openSheet(user);
        expect(screen.getByTestId('connect-agent-scopes').textContent).toBe('mcp:propose, mcp:read, risks:read');
        await user.click(screen.getByTestId('connect-agent-mint'));
        await screen.findByTestId('connect-agent-key');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/admin/api-keys');
        expect(init.method).toBe('POST');
        expect(mintBody()).toEqual({
            name: copy('defaultKeyName', { name: AGENT.name }),
            scopes: ['mcp:propose', 'mcp:read', 'risks:read'],
            expiresAt: null,
            agentId: 'agent-1',
            maxAutonomyLevel: 2,
        });
    });

    it('offers no ceiling above the agent\'s level, and a lowered one is what is sent', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN);
        await openSheet(user);
        await user.click(document.getElementById('connect-agent-ceiling')!);
        const listbox = await screen.findByRole('listbox');
        // The combobox lists the selected option first, so the set is the claim.
        expect(within(listbox).getAllByRole('option').map((o) => o.textContent?.trim()).sort()).toEqual(['L0', 'L1', 'L2']);
        await user.click(within(listbox).getByRole('option', { name: 'L1' }));
        await user.click(screen.getByTestId('connect-agent-mint'));
        await screen.findByTestId('connect-agent-key');
        expect(mintBody().maxAutonomyLevel).toBe(1);
    });

    it('a refusal from the route is shown, and no key is', async () => {
        fetchMock.mockResolvedValueOnce(reply(429, { error: { message: 'Rate limit exceeded' } }));
        const user = userEvent.setup();
        renderPage(ADMIN);
        await openSheet(user);
        await user.click(screen.getByTestId('connect-agent-mint'));
        expect((await screen.findByTestId('connect-agent-error')).textContent).toContain('Rate limit exceeded');
        expect(screen.queryByTestId('connect-agent-key')).toBeNull();
    });
});

describe('the configuration', () => {
    it('the Agent SDK tab: TypeScript and Python, allowedTools exactly the grants, and every line explained', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN);
        await mint(user);
        const ts = screen.getByTestId('connect-agent-ts').textContent ?? '';
        const py = screen.getByTestId('connect-agent-py').textContent ?? '';
        const listed = (code: string) => [...code.matchAll(/"(mcp__[^"]+)"/g)].map((m) => m[1]);
        expect([ts, py].map(listed)).toEqual([
            ['mcp__inflect__list_risks', 'mcp__inflect__propose_risks'],
            ['mcp__inflect__list_risks', 'mcp__inflect__propose_risks'],
        ]);
        expect([ts, py].map((code) => code.includes('*'))).toEqual([false, false]);
        expect([ts, py].map((code) => code.includes('Claude Code'))).toEqual([false, false]);
        expect([ts, py].map((code) => code.includes('/api/mcp'))).toEqual([true, true]);
        expect(screen.getByTestId('connect-agent-sdk-lines').querySelectorAll('li')).toHaveLength(6);
    });

    it('the Managed Agent tab: the server, a vault credential, and a toolset listing exactly the grants', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN);
        await mint(user);
        await user.click(screen.getByRole('tab', { name: copy('tabConsole') }));
        const toolset = JSON.parse(screen.getByTestId('connect-agent-console-toolset').textContent ?? '{}') as {
            default_config: { enabled: boolean };
            configs: Array<{ name: string; permission_policy: { type: string } }>;
        };
        expect(toolset.default_config.enabled).toBe(false);
        expect(toolset.configs.map((c) => [c.name, c.permission_policy.type])).toEqual([
            ['list_risks', 'always_allow'],
            ['propose_risks', 'always_ask'],
        ]);
        expect(screen.getByTestId('connect-agent-console-vault').textContent).toContain('static_bearer');
        expect(screen.getByTestId('connect-agent-console').textContent).not.toContain('Claude Code');
    });
});

describe('the key', () => {
    it('is in no snippet, is sent nowhere after the mint, and is gone once the sheet closes', async () => {
        const user = userEvent.setup();
        renderPage(ADMIN);
        await mint(user);
        expect(screen.getByTestId('connect-agent-key').textContent).toContain(PLAINTEXT);
        expect(screen.getByTestId('connect-agent-ts').textContent).not.toContain(PLAINTEXT);
        expect(screen.getByTestId('connect-agent-py').textContent).not.toContain(PLAINTEXT);
        await user.click(screen.getByRole('tab', { name: copy('tabConsole') }));
        expect(screen.getByTestId('connect-agent-console').textContent).not.toContain(PLAINTEXT);

        await user.click(screen.getByTestId('connect-agent-done'));
        await waitFor(() => expect(screen.queryByTestId('connect-agent-sheet')).toBeNull());
        expect(document.body.textContent).not.toContain(PLAINTEXT);

        // Opening it again starts from the form: the key did not survive the close.
        await act(async () => {
            await openSheet(user);
        });
        expect(await screen.findByTestId('connect-agent-form')).toBeTruthy();
        expect(document.body.textContent).not.toContain(PLAINTEXT);

        // One request carried anything to the server, and it was the mint.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).not.toContain(PLAINTEXT);
    });
});
