/**
 * Admin → Integrations in Bulgarian: a provider's own words come from the
 * catalogue, not from the server's English (#4581).
 *
 * The page printed each provider's description, setup guide and field labels
 * and help as the server-side class wrote them, and an internal check's
 * connection under its English provider name. This drives the real page with
 * the Bulgarian catalogue and asserts the Bulgarian text is what a reader sees,
 * and the English is not. Harness copied from `admin-integrations-page.test.tsx`.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// ─── next-intl, reading the real English catalogue ──────────────────────
// One translator per namespace for the life of the module: the page's load is
// a `useCallback` keyed on `t`, so a fresh `t` per render would refetch forever.
jest.mock('next-intl', () => {
    const en = require('../../messages/bg.json');
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
        useLocale: () => 'bg',
    };
});

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations',
    useSearchParams: () => search,
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    const href = (p: string) => `/t/acme${p}`;
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    // An Owner, whom the edge admits: read by `@/lib/auth/use-offers-admin-api-write`
    // (not mocked), which decides that the page offers the edit form.
    const owner = { edgeAdmitsAdminApi: true, appPermissions: getPermissionsForRole('OWNER'), permissions: { canAdmin: true, canWrite: true } };
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href, useTenantContext: () => owner };
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

const EN = require('../../messages/en.json').admin.integrations.providerText;
const BG = require('../../messages/bg.json').admin.integrations;

/**
 * Providers as the server sends them: their English text is exactly what the
 * English catalogue holds (`provider-text.test.ts` pins that for every
 * registered provider), so these stand in for the registry without loading it.
 */
const fromCatalogue = (id: string, category: string) => {
    const text = EN[id];
    const fields = Object.entries((text.fields ?? {}) as Record<string, { label: string; description?: string }>).map(
        ([key, f]) => ({ key, label: f.label, description: f.description, type: 'string', required: false }),
    );
    return {
        id,
        displayName: id,
        description: text.description,
        setupGuide: text.setupGuide,
        supportedChecks: [] as string[],
        configSchema: { configFields: fields, secretFields: [] },
        liveValidation: true,
        category,
    };
};

const PROVIDERS = [
    { ...fromCatalogue('okta', 'identity'), displayName: 'Okta' },
    { ...fromCatalogue('personnel', 'other'), displayName: 'Personnel' },
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



async function renderPage() {
    render(<AdminIntegrationsPage />);
    // The page's own loading line, in Bulgarian: the English one is never on screen here.
    await waitFor(() => expect(screen.queryByText(BG.fetching)).not.toBeInTheDocument());
    await screen.findByRole('heading', { level: 1 });
}


describe('provider text in Bulgarian (#4581)', () => {
    it('the catalogue card shows the Bulgarian description, not the English', async () => {
        serve([]);
        await renderPage();
        expect(screen.getByText(BG.providerText.okta.description)).toBeInTheDocument();
        expect(screen.queryByText(EN.okta.description)).not.toBeInTheDocument();
    });

    it('the edit form shows the Bulgarian setup guide, field labels and help', async () => {
        serve([conn({ id: 'c-okta', provider: 'okta', name: 'Corp directory' })]);
        await renderPage();
        fireEvent.click(screen.getByRole('button', { name: BG.editConnection }));
        const guide = await screen.findByTestId('provider-setup-guide');
        expect(guide).toHaveTextContent(BG.providerText.okta.setupGuide);
        expect(screen.getByText(BG.providerText.okta.fields.orgUrl.label)).toBeInTheDocument();
        expect(screen.getByText(BG.providerText.okta.fields.dormantDays.description)).toBeInTheDocument();
        expect(screen.queryByText(EN.okta.fields.dormantDays.description)).not.toBeInTheDocument();
    });

    it('an internal check still called by its English provider name reads as the provider label', async () => {
        serve([conn({ id: 'c-pers', provider: 'personnel', name: 'Personnel', configJson: {} })]);
        await renderPage();
        const table = await screen.findByTestId('integrations-table');
        // Both the provider column and the name read as the label, and the
        // English provider name is nowhere in the row.
        expect(within(table).getAllByText(BG.providerLabels.personnel)).toHaveLength(2);
        expect(within(table).queryByText('Personnel')).not.toBeInTheDocument();
    });

    it('a name the admin chose is shown as they wrote it', async () => {
        serve([conn({ id: 'c-okta', provider: 'okta', name: 'Okta' + ' production' })]);
        await renderPage();
        const table = await screen.findByTestId('integrations-table');
        expect(within(table).getByText('Okta production')).toBeInTheDocument();
    });
});
