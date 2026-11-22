/**
 * The "Anthropic workspace" card on Admin → Integrations (Step 5a of
 * docs/claude-managed-agents-design.md), driven through the REAL page.
 *
 *   - Flag off: the server lists no `anthropic-workspace` provider
 *     (AGENT_MANAGED_AGENTS unset leaves it unregistered), and the page renders
 *     no card. Flag on: the server lists it, and the card renders.
 *   - The copy says what Inflect will create (agents, one environment,
 *     sessions), that sessions are deleted when each run ends unless kept, and
 *     that a kept session is still deleted on purge, removal and erasure.
 *   - "Keep sessions in my workspace" is OFF by default, and Connect sends it
 *     as the customer left it.
 *   - The provider is never offered through the generic catalogue or form,
 *     which would render its fixed host as a typed field.
 *   - Gated like the other connection cards: a viewer the routes would refuse
 *     is offered no form.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                const t = (key: string, params?: Record<string, unknown>) => {
                    const v = walk(walk(en, ns), key);
                    if (typeof v !== 'string') return key;
                    let s = v;
                    for (const [p, val] of Object.entries(params ?? {})) {
                        s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                    }
                    return s;
                };
                (t as unknown as { rich: unknown }).rich = t;
                cache.set(ns, t);
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations',
    useSearchParams: () => new URLSearchParams(),
}));

const mockViewer: {
    membershipRole: string | undefined;
    permissions: { canAdmin: boolean; canWrite: boolean };
} = { membershipRole: 'OWNER', permissions: { canAdmin: true, canWrite: true } };
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    const href = (p: string) => `/t/acme${p}`;
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useTenantContext: () => ({
            membershipRole: mockViewer.membershipRole,
            appPermissions: getPermissionsForRole(mockViewer.membershipRole ?? 'READER'),
            permissions: mockViewer.permissions,
        }),
    };
});

jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/SharePointCard', () => ({
    SharePointCard: () => null,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/ConnectionHealthPanel', () => ({
    ConnectionHealthPanel: () => null,
}));
jest.mock('@/components/admin/IdentityCrossLinks', () => ({ IdentityCrossLinks: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/require-permission', () => ({ RequirePermission: () => null }));

import AdminIntegrationsPage from '@/app/t/[tenantSlug]/(app)/admin/integrations/page';

const EN = require('../../messages/en.json').admin.anthropicWorkspace as Record<string, string>;

const OKTA = {
    id: 'okta',
    displayName: 'Okta',
    description: 'Directory',
    supportedChecks: [] as string[],
    configSchema: { configFields: [{ key: 'domain', label: 'Domain', type: 'string', required: true }], secretFields: [] },
    liveValidation: true,
    category: 'identity',
};
/** As the server lists the provider when AGENT_MANAGED_AGENTS is on. */
const ANTHROPIC = {
    id: 'anthropic-workspace',
    displayName: 'Anthropic workspace',
    description: 'Your own Anthropic workspace',
    supportedChecks: [] as string[],
    configSchema: {
        configFields: [
            { key: 'workspaceId', label: 'Workspace ID', type: 'string', required: true },
            { key: 'keepSessions', label: 'Keep sessions in my workspace', type: 'boolean', required: false },
            { key: 'apiHost', label: 'API host', type: 'string', required: false },
        ],
        secretFields: [{ key: 'apiKey', label: 'API key', type: 'string', required: true }],
    },
    liveValidation: true,
    category: 'other',
};

const savedConnection = (over: Record<string, unknown> = {}) => ({
    id: 'c-anthropic',
    provider: 'anthropic-workspace',
    name: 'Anthropic workspace',
    isEnabled: true,
    configJson: { workspaceId: 'wrkspc_01Abc', keepSessions: false },
    lastTestedAt: null,
    lastTestStatus: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    secretStatus: '••••••••',
    webhookUrl: '',
    _count: { executions: 0 },
    ...over,
});

let calls: Array<{ method: string; path: string; body: unknown }> = [];

function serve(providers: unknown[], connections: unknown[] = [], routes: Record<string, () => { status?: number; body: unknown }> = {}) {
    calls = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace('/api/t/acme', '');
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const reply =
            routes[`${method} ${path}`]?.() ??
            (method === 'GET' && path === '/admin/integrations'
                ? { body: { connections, availableProviders: providers, webhookBaseUrl: '' } }
                : method === 'GET' && path === '/admin/integrations/health'
                  ? { body: { connections: [] } }
                  : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no route' } } });
        const status = reply.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => reply.body } as Response;
    }) as unknown as typeof fetch;
}

async function renderPage() {
    render(<AdminIntegrationsPage />);
    await waitFor(() => expect(screen.queryByText('Fetching integrations')).not.toBeInTheDocument());
}

const card = () => document.getElementById('anthropic-workspace-card');

beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
    mockViewer.membershipRole = 'OWNER';
    mockViewer.permissions = { canAdmin: true, canWrite: true };
});

describe('the switch decides whether the card exists', () => {
    it('flag off — the server lists no such provider — renders no card', async () => {
        serve([OKTA]);
        await renderPage();
        expect(document.getElementById('connect-okta-btn')).not.toBeNull(); // the page did render
        expect(card()).toBeNull();
        expect(screen.queryByText(EN.title)).toBeNull();
    });

    it('flag on — the server lists the provider — renders the card', async () => {
        serve([OKTA, ANTHROPIC]);
        await renderPage();
        expect(card()).not.toBeNull();
        expect(within(card() as HTMLElement).getByRole('heading', { name: EN.title })).toBeInTheDocument();
    });
});

describe('the copy', () => {
    it('says what Inflect will create, that sessions are deleted unless kept, and when a kept one still goes', async () => {
        serve([ANTHROPIC]);
        await renderPage();
        const c = within(card() as HTMLElement);
        for (const key of ['createsHeading', 'createsAgents', 'createsEnvironment', 'createsSessions', 'sessionsDeleted', 'keptStillDeleted']) {
            expect({ key, shown: c.queryByText(EN[key]) !== null }).toEqual({ key, shown: true });
        }
        // The words that carry decision 4, read from the catalogue itself so a
        // rewording that drops one of them fails here.
        expect(EN.createsAgents).toMatch(/Agents/);
        expect(EN.createsEnvironment).toMatch(/One environment/);
        expect(EN.createsSessions).toMatch(/Sessions/);
        expect(EN.sessionsDeleted).toMatch(/deletes each session when its run ends, unless you tick/);
        expect(EN.keptStillDeleted).toMatch(/purged.*connection is removed.*erasure request/);
    });
});

describe('keep sessions', () => {
    it('is OFF by default, and Connect sends it off with the key as a secret', async () => {
        serve([ANTHROPIC], [], { 'POST /admin/integrations': () => ({ body: { id: 'new' } }) });
        await renderPage();
        const keep = screen.getByRole('checkbox', { name: EN.keepSessions });
        expect(keep).not.toBeChecked();

        fireEvent.change(screen.getByLabelText(EN.workspaceId, { exact: false }), { target: { value: 'wrkspc_01Abc' } });
        fireEvent.change(screen.getByLabelText(EN.apiKey, { exact: false }), { target: { value: 'sk-ant-fixture' } });
        fireEvent.click(screen.getByRole('button', { name: EN.connect }));

        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.body).toEqual({
            provider: 'anthropic-workspace',
            name: EN.connectionName,
            configJson: { workspaceId: 'wrkspc_01Abc', keepSessions: false },
            secrets: { apiKey: 'sk-ant-fixture' },
        });
        // No host is ever sent: there is no field for one.
        expect(JSON.stringify(post?.body)).not.toContain('apiHost');
    });

    it('is sent ON only when the customer ticks it', async () => {
        serve([ANTHROPIC], [], { 'POST /admin/integrations': () => ({ body: { id: 'new' } }) });
        await renderPage();
        fireEvent.click(screen.getByRole('checkbox', { name: EN.keepSessions }));
        fireEvent.change(screen.getByLabelText(EN.workspaceId, { exact: false }), { target: { value: 'wrkspc_01Abc' } });
        fireEvent.change(screen.getByLabelText(EN.apiKey, { exact: false }), { target: { value: 'sk-ant-fixture' } });
        fireEvent.click(screen.getByRole('button', { name: EN.connect }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        expect((calls.find((c) => c.method === 'POST')?.body as { configJson: unknown }).configJson).toEqual({
            workspaceId: 'wrkspc_01Abc',
            keepSessions: true,
        });
    });

    it('a saved connection shows its stored choice, and Test is a PUT that sends no secret', async () => {
        serve([ANTHROPIC], [savedConnection()], { 'PUT /admin/integrations': () => ({ body: { valid: true } }) });
        await renderPage();
        expect(screen.getByRole('checkbox', { name: EN.keepSessions })).not.toBeChecked();
        fireEvent.click(within(card() as HTMLElement).getByRole('button', { name: EN.test }));
        await waitFor(() => expect(screen.getByTestId('anthropic-workspace-notice')).toHaveTextContent(EN.testOk));
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.body).toEqual({
            connectionId: 'c-anthropic',
            provider: 'anthropic-workspace',
            configJson: { workspaceId: 'wrkspc_01Abc', keepSessions: false },
        });
    });
});

describe('the generic catalogue and form never offer it', () => {
    it('no Connect card for it in the catalogue, and its row stays off the table', async () => {
        serve([OKTA, ANTHROPIC], [savedConnection()]);
        await renderPage();
        expect(document.getElementById('connect-anthropic-workspace-btn')).toBeNull();
        expect(document.getElementById('field-apiHost')).toBeNull();
        expect(screen.queryByLabelText('API host')).toBeNull();
    });
});

describe('gated like the other connection cards', () => {
    it('a Reader is offered no form and no Test', async () => {
        mockViewer.membershipRole = 'READER';
        mockViewer.permissions = { canAdmin: false, canWrite: false };
        serve([ANTHROPIC], [savedConnection()]);
        await renderPage();
        expect(card()).not.toBeNull();
        expect(screen.queryByTestId('anthropic-workspace-form')).toBeNull();
        expect(within(card() as HTMLElement).queryByRole('button', { name: EN.test })).toBeNull();
        expect(screen.getByRole('checkbox', { name: EN.keepSessions })).toBeDisabled();
    });

    it('a Reader with no connection yet is offered no connect form either', async () => {
        mockViewer.membershipRole = 'READER';
        mockViewer.permissions = { canAdmin: false, canWrite: false };
        serve([ANTHROPIC], []);
        await renderPage();
        expect(card()).not.toBeNull();
        expect(screen.queryByTestId('anthropic-workspace-form')).toBeNull();
        expect(screen.queryByRole('button', { name: EN.connect })).toBeNull();
    });
});
