/**
 * Admin → Integrations, at the layer an Owner or Admin touches (#4466).
 *
 * The page answered several refusals with success, one with a crash, and one
 * redirect with nothing at all. Each test below drives the real page component
 * against a fetch fake and asserts what the reader is shown:
 *
 *   - "Authorize with Microsoft Entra" refused by the server used to render the
 *     error envelope OBJECT as a React child, which threw and took the page
 *     down. The server's sentence is shown instead.
 *   - The consent callback's `?mcp=connected|declined|error` is reported.
 *   - A refused list load shows the reason, not "No integrations configured".
 *   - Disable, Enable internal checks and Sync now read the response.
 *   - An edit keeps a disabled connection disabled; Enable is its own action.
 *   - SharePoint rows stay on the SharePoint card.
 *   - Provider names and check labels, not ids.
 *
 * The four child cards are stubbed: each fetches on its own and has its own
 * tests. What is under test is this page's handlers and what it renders.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// ─── next-intl, reading the real English catalogue ──────────────────────
// One translator per namespace for the life of the module: the page's load is
// a `useCallback` keyed on `t`, so a fresh `t` per render would refetch forever.
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

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations',
    useSearchParams: () => search,
}));

/**
 * The viewer the page's write gates are asked of (#4466 finding 9): the REAL
 * `useOffersAdminApiWrite` and `offersAdminApiWrite`, over a tenant context a
 * test may replace. An Owner membership, which the edge admits (#4587's
 * `membershipRole`), unless a test says otherwise.
 */
const mockViewer: {
    membershipRole: string | undefined;
    appPermissions: unknown;
    permissions: { canAdmin: boolean; canWrite: boolean };
} = { membershipRole: 'OWNER', appPermissions: null, permissions: { canAdmin: true, canWrite: true } };
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    const href = (p: string) => `/t/acme${p}`;
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        // Read by `@/lib/auth/use-offers-admin-api-write`, which is not mocked.
        useTenantContext: () => ({
            membershipRole: mockViewer.membershipRole,
            appPermissions: mockViewer.appPermissions ?? getPermissionsForRole('OWNER'),
            permissions: mockViewer.permissions,
        }),
    };
});

// The children, stubbed — see the file docstring.
jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/SharePointCard', () => ({
    SharePointCard: () => <div data-testid="sharepoint-card-stub" />,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/ConnectionHealthPanel', () => ({
    // Renders what the page hands it to name a provider, so the health
    // table's naming is asserted without mounting the panel.
    ConnectionHealthPanel: ({ providerLabel }: { providerLabel?: (id: string) => string }) => (
        <div data-testid="health-panel-stub">{providerLabel?.('mcp-server')}</div>
    ),
}));
jest.mock('@/components/admin/IdentityCrossLinks', () => ({ IdentityCrossLinks: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/require-permission', () => ({ RequirePermission: () => null }));

import AdminIntegrationsPage from '@/app/t/[tenantSlug]/(app)/admin/integrations/page';

// ─── fixtures ────────────────────────────────────────────────────────────

const provider = (over: Record<string, unknown>) => ({
    id: 'okta',
    displayName: 'Okta',
    description: 'Directory',
    supportedChecks: [] as string[],
    configSchema: { configFields: [{ key: 'domain', label: 'Domain', type: 'string', required: true }], secretFields: [] },
    liveValidation: true,
    category: 'identity',
    ...over,
});

const PROVIDERS = [
    provider({ id: 'okta', displayName: 'Okta', supportedChecks: ['mfa_enforced', 'sso_enforced'] }),
    // The server's own English names, as the registry sends them. The page
    // must show the catalogue's translated names instead — never these.
    provider({ id: 'mcp-server', displayName: 'MCP server (external)', category: 'other' }),
    provider({ id: 'aws-posture', displayName: 'AWS Cloud Posture (server name)', category: 'cloud' }),
    // An id this build has no label for: the server's name is the fallback.
    provider({ id: 'brand-new', displayName: 'Brand New Provider', category: 'other' }),
    provider({
        id: 'personnel',
        displayName: 'Personnel',
        category: 'other',
        configSchema: { configFields: [], secretFields: [] },
    }),
];

const conn = (over: Record<string, unknown>) => ({
    id: 'c-okta',
    provider: 'okta',
    name: 'Corp directory',
    isEnabled: true,
    configJson: { domain: 'corp.okta.com' },
    lastTestedAt: null,
    lastTestStatus: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    secretStatus: '••••••••',
    webhookUrl: '',
    _count: { executions: 0 },
    ...over,
});

type Reply = { status?: number; body: unknown };
type Route = (init: RequestInit | undefined) => Reply;

let calls: Array<{ url: string; method: string; body: unknown }> = [];

/**
 * Serve the list, and anything else from `routes` keyed `METHOD path`.
 * Every request is recorded so a test can assert on what was SENT.
 */
function serve(connections: unknown[], routes: Record<string, Route> = {}, list?: Reply) {
    calls = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = url.replace('/api/t/acme', '');
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const reply: Reply =
            routes[`${method} ${path}`]?.(init) ??
            (method === 'GET' && path === '/admin/integrations'
                ? list ?? { body: { connections, availableProviders: PROVIDERS, webhookBaseUrl: '' } }
                : method === 'GET' && path === '/admin/integrations/health'
                  ? { body: { connections: [] } }
                  : { status: 404, body: { error: { code: 'NOT_FOUND', message: `no route ${method} ${path}` } } });
        const status = reply.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => reply.body } as Response;
    }) as unknown as typeof fetch;
}

const sent = (method: string, path: string) =>
    calls.filter((c) => c.method === method && c.url.endsWith(path));

const refusal = (message: string, status = 400): Reply => ({
    status,
    body: { error: { code: 'BAD_REQUEST', message, requestId: 'req-1' } },
});

async function renderPage() {
    render(<AdminIntegrationsPage />);
    await waitFor(() => expect(screen.queryByText('Fetching integrations')).not.toBeInTheDocument());
}

const message = () => screen.getByTestId('integrations-message');

beforeAll(() => {
    // The form scrolls itself into view on a timer; jsdom has no layout.
    Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
    search = new URLSearchParams();
});

// ─── the crash ───────────────────────────────────────────────────────────

describe('Authorize with Microsoft Entra, refused', () => {
    it('shows the server\'s sentence and keeps the page, instead of rendering the error object', async () => {
        const reason =
            'This connection is not ready to authorize. Set the Entra tenant ID, the application (client) ID and the client secret on it first.';
        serve([conn({ id: 'c-mcp', provider: 'mcp-server', name: 'SAP tools' })], {
            'POST /admin/integrations/c-mcp/mcp-consent': () => refusal(reason),
        });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Authorize with Microsoft Entra' }));

        await waitFor(() => expect(message()).toHaveTextContent(reason));
        // The page survived: the heading and the row are still there.
        expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeInTheDocument();
        expect(screen.getByText('SAP tools')).toBeInTheDocument();
    });
});

// ─── the consent redirect ────────────────────────────────────────────────

describe('the Entra consent result', () => {
    it.each([
        ['connected', 'Microsoft Entra authorization complete.'],
        ['declined', 'Microsoft Entra authorization was declined'],
        ['error', 'Microsoft Entra authorization did not complete.'],
    ])('reports ?mcp=%s', async (outcome, words) => {
        search = new URLSearchParams({ mcp: outcome });
        serve([]);
        await renderPage();
        const notice = screen.getByTestId('consent-result');
        expect(notice).toHaveTextContent(words);
        // Users are never told about "MCP".
        expect(notice.textContent).not.toMatch(/MCP/i);
    });

    it('says nothing without the parameter, or with one it does not know', async () => {
        search = new URLSearchParams({ mcp: 'toString' });
        serve([]);
        await renderPage();
        expect(screen.queryByTestId('consent-result')).not.toBeInTheDocument();
    });
});

// ─── the list load ───────────────────────────────────────────────────────

describe('a refused list load', () => {
    it('shows the server\'s reason, not the empty state', async () => {
        serve([], {}, refusal('Forbidden: missing permission', 403));
        await renderPage();
        expect(screen.getByTestId('integrations-load-error')).toHaveTextContent('Forbidden: missing permission');
        expect(screen.queryByText(/No integrations configured/)).not.toBeInTheDocument();
    });
});

// ─── disable / enable ────────────────────────────────────────────────────

describe('Disable integration', () => {
    it('reports a refusal in the server\'s words, not "Connection disabled"', async () => {
        serve([conn({})], { 'DELETE /admin/integrations': () => refusal('Admin only', 403) });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Disable integration' }));

        await waitFor(() => expect(message()).toHaveTextContent('Admin only'));
        expect(message()).not.toHaveTextContent('Connection disabled');
        expect(message()).toHaveAttribute('role', 'alert');
    });
});

describe('a disabled connection', () => {
    it('offers Enable instead of Disable and no Sync now, and Enable sends isEnabled: true', async () => {
        serve([conn({ isEnabled: false })], { 'POST /admin/integrations': () => ({ body: { id: 'c-okta' } }) });
        await renderPage();

        expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Disable integration' })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Enable integration' }));

        await waitFor(() => expect(message()).toHaveTextContent('Connection enabled'));
        expect(sent('POST', '/admin/integrations')[0].body).toEqual({
            id: 'c-okta',
            provider: 'okta',
            name: 'Corp directory',
            configJson: { domain: 'corp.okta.com' },
            isEnabled: true,
        });
    });

    it('stays disabled when edited: Update Connection sends isEnabled: false', async () => {
        serve([conn({ isEnabled: false })], { 'POST /admin/integrations': () => ({ body: { id: 'c-okta' } }) });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
        fireEvent.change(screen.getByDisplayValue('Corp directory'), { target: { value: 'Corporate directory' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update Connection' }));

        await waitFor(() => expect(sent('POST', '/admin/integrations')).toHaveLength(1));
        expect(sent('POST', '/admin/integrations')[0].body).toMatchObject({
            id: 'c-okta',
            name: 'Corporate directory',
            isEnabled: false,
        });
    });
});

describe('Enable internal checks', () => {
    it('turns a DISABLED internal check back on rather than skipping it', async () => {
        serve([conn({ id: 'c-pers', provider: 'personnel', name: 'Personnel', isEnabled: false, configJson: {} })], {
            'POST /admin/integrations': () => ({ body: { id: 'c-pers' } }),
        });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Enable internal checks' }));

        await waitFor(() => expect(message()).toHaveTextContent('Internal check providers enabled.'));
        expect(sent('POST', '/admin/integrations').map((c) => c.body)).toEqual([
            { id: 'c-pers', provider: 'personnel', name: 'Personnel', configJson: {}, isEnabled: true },
        ]);
    });

    it('reports a refusal instead of success', async () => {
        serve([], { 'POST /admin/integrations': () => refusal('Admin only', 403) });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Enable internal checks' }));

        await waitFor(() => expect(message()).toHaveTextContent('Admin only'));
        expect(message()).not.toHaveTextContent('Internal check providers enabled.');
    });
});

// ─── sync now ────────────────────────────────────────────────────────────

describe('Sync now', () => {
    it('reports a failed directory read as a failure, with its reason', async () => {
        serve([conn({})], {
            'POST /admin/integrations/c-okta/sync': () => ({
                body: {
                    identity: { status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Okta API returned 401' },
                    hris: null,
                    checks: [],
                    counts: { total: 0, passed: 0, failed: 0, error: 0 },
                },
            }),
        });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

        await waitFor(() => expect(message()).toHaveTextContent('Directory sync failed.'));
        expect(message()).toHaveTextContent('Reason: Okta API returned 401');
        expect(message()).toHaveAttribute('role', 'alert');
    });

    it('shows the server\'s reason when the sync is refused', async () => {
        serve([conn({})], {
            'POST /admin/integrations/c-okta/sync': () => refusal('Connection not found or disabled', 404),
        });
        await renderPage();

        fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

        await waitFor(() => expect(message()).toHaveTextContent('Connection not found or disabled'));
    });
});

// ─── what the table lists and says ───────────────────────────────────────

describe('Configured Connections', () => {
    it('leaves SharePoint rows to the SharePoint card', async () => {
        serve([conn({}), conn({ id: 'c-sp', provider: 'sharepoint', name: 'Docs site' })]);
        await renderPage();
        const table = screen.getByTestId('integrations-table');
        expect(within(table).getByText('Corp directory')).toBeInTheDocument();
        expect(within(table).queryByText('Docs site')).not.toBeInTheDocument();
    });

    it('shows the empty state when SharePoint is the only connection', async () => {
        serve([conn({ id: 'c-sp', provider: 'sharepoint', name: 'Docs site' })]);
        await renderPage();
        expect(screen.getByText('No integrations configured. Add an integration to get started.')).toBeInTheDocument();
    });

    it('names the provider and labels the checks, rather than printing ids', async () => {
        serve([conn({ id: 'c-aws', provider: 'aws-posture', name: 'Prod account' })]);
        await renderPage();
        const table = screen.getByTestId('integrations-table');
        expect(within(table).getByText('AWS Cloud Posture')).toBeInTheDocument();
        expect(within(table).queryByText('aws-posture')).not.toBeInTheDocument();
        // The catalogue card for Okta.
        expect(screen.getByText('MFA enforced')).toBeInTheDocument();
        expect(screen.queryByText('mfa_enforced')).not.toBeInTheDocument();
    });

    it('names a tool server in the catalogue\'s words, never "MCP", in every place it appears', async () => {
        serve([conn({ id: 'c-mcp', provider: 'mcp-server', name: 'SAP tools' })]);
        await renderPage();
        const table = screen.getByTestId('integrations-table');
        // The Provider column.
        expect(within(table).getByText('External tool server')).toBeInTheDocument();
        // The health panel is handed the same names.
        expect(screen.getByTestId('health-panel-stub')).toHaveTextContent('External tool server');
        // The catalogue card.
        expect(screen.getByRole('heading', { level: 3, name: 'External tool server' })).toBeInTheDocument();
        // Nowhere on the page.
        expect(document.body.textContent).not.toMatch(/MCP/);

        // The form's provider picker, which shows the selected provider.
        fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
        const picker = await waitFor(() => {
            const el = document.getElementById('integration-provider-select');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        expect(picker).toHaveTextContent('External tool server');
        expect(document.body.textContent).not.toMatch(/MCP/);
    });

    it('falls back to the server\'s name for a provider the build has no label for', async () => {
        serve([conn({ id: 'c-new', provider: 'brand-new', name: 'Something new' })]);
        await renderPage();
        expect(within(screen.getByTestId('integrations-table')).getByText('Brand New Provider')).toBeInTheDocument();
    });

    it('has no Secrets column of identical dots', async () => {
        serve([conn({})]);
        await renderPage();
        expect(screen.queryByRole('columnheader', { name: 'Secrets' })).not.toBeInTheDocument();
        expect(screen.queryByText('••••••••')).not.toBeInTheDocument();
    });
});

describe('creating a connection', () => {
    it('confirms in the page\'s own words, not the route\'s English warning', async () => {
        // No `id` in the reply, so the page starts no first sync and the
        // create message is the one left showing.
        serve([], {
            'POST /admin/integrations': () => ({
                status: 201,
                body: {
                    secretStatus: 'configured',
                    warning: 'Secrets have been encrypted and stored. They cannot be retrieved.',
                },
            }),
        });
        await renderPage();

        fireEvent.click(document.getElementById('connect-okta-btn') as HTMLElement);
        fireEvent.change(screen.getByPlaceholderText('e.g. Acme GitHub Org'), { target: { value: 'Corp' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Connection' }));

        await waitFor(() =>
            expect(message()).toHaveTextContent(
                'Connection created. Its secrets are encrypted and cannot be viewed again.',
            ),
        );
        expect(message()).not.toHaveTextContent('They cannot be retrieved');
    });
});

// ─── offered only where the server takes it (#4466 finding 9) ────────────

describe('the controls offered, by who is asking', () => {
    const okta = conn({ id: 'c-okta' });
    const tools = conn({ id: 'c-mcp', provider: 'mcp-server', name: 'SAP tools' });
    const off = conn({ id: 'c-off', name: 'Old directory', isEnabled: false });
    const named = (name: string) => screen.queryAllByRole('button', { name });
    const asAdmin = () => {
        const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
        return getPermissionsForRole('ADMIN');
    };

    afterEach(() => {
        mockViewer.membershipRole = 'OWNER';
        mockViewer.appPermissions = null;
        mockViewer.permissions = { canAdmin: true, canWrite: true };
    });

    it('an Owner is offered every control, and no notice', async () => {
        serve([okta, tools, off]);
        await renderPage();
        expect(screen.queryByTestId('integrations-manage-refused')).toBeNull();
        expect(byIdOrNull('add-integration-btn')).not.toBeNull();
        expect(byIdOrNull('connect-okta-btn')).not.toBeNull();
        expect(named('Sync now')).toHaveLength(2);
        expect(named('Test connection')).toHaveLength(3);
        expect(named('Edit connection')).toHaveLength(3);
        expect(named('Authorize with Microsoft Entra')).toHaveLength(1);
        expect(named('Disable integration')).toHaveLength(2);
        expect(named('Enable integration')).toHaveLength(1);
    });

    it('an Admin membership on a Reader-based custom role granting Manage tests and syncs, and changes nothing', async () => {
        // The edge and the route admit it; the save, enable, disable and
        // authorize usecases ask the coarse admin tier, which its base lacks.
        mockViewer.appPermissions = asAdmin();
        mockViewer.permissions = { canAdmin: false, canWrite: false };
        serve([okta, tools, off]);
        await renderPage();
        expect(screen.getByTestId('integrations-manage-refused')).toHaveTextContent(
            'Only an Owner, or an Admin whose role lets them manage the workspace, can connect, change or remove integrations.',
        );
        expect(named('Sync now')).toHaveLength(2);
        expect(named('Test connection')).toHaveLength(3);
        for (const control of ['Edit connection', 'Authorize with Microsoft Entra', 'Disable integration', 'Enable integration']) {
            expect({ control, offered: named(control).length }).toEqual({ control, offered: 0 });
        }
        expect(byIdOrNull('add-integration-btn')).toBeNull();
        expect(byIdOrNull('connect-okta-btn')).toBeNull();
    });

    it('an Editor membership whose custom role grants Manage — the edge refuses it — is offered nothing', async () => {
        mockViewer.membershipRole = 'EDITOR';
        mockViewer.appPermissions = asAdmin();
        serve([okta, tools, off]);
        await renderPage();
        expect(screen.getByTestId('integrations-manage-refused')).toBeInTheDocument();
        for (const control of ['Sync now', 'Test connection', 'Edit connection', 'Disable integration']) {
            expect({ control, offered: named(control).length }).toEqual({ control, offered: 0 });
        }
        expect(byIdOrNull('add-integration-btn')).toBeNull();
    });

    it('the empty state names no button when none is offered', async () => {
        mockViewer.permissions = { canAdmin: false, canWrite: false };
        serve([]);
        await renderPage();
        expect(screen.getByText('No integrations configured.')).toBeInTheDocument();
        expect(screen.queryByText(/Add an integration to get started/)).toBeNull();
    });
});

function byIdOrNull(id: string) {
    return document.getElementById(id);
}
