/**
 * The SharePoint card on Admin → Integrations (#4466).
 *
 *   - A DISABLED SharePoint connection read "Connected", because the badge
 *     looked only at the last test, and offered Test and Sites, which the
 *     service refuses for a disabled connection. It now says Disabled and
 *     offers Disconnect, which the service accepts for it, so Connect comes back.
 *   - "Save sites" closed the picker whatever the server answered, so a refused
 *     save looked like a saved one.
 *   - A site list that could not be read opened an EMPTY picker, which reads as
 *     "this connection reaches no sites".
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
                cache.set(ns, t);
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

const search = new URLSearchParams();
jest.mock('next/navigation', () => ({ useSearchParams: () => search }));

/**
 * The viewer the page's write gates are asked of (#4466 finding 9): the REAL
 * `offersAdminApiWrite`, over a viewer a test may replace. An Owner, whom the
 * edge admits, unless a test says otherwise.
 */
const mockViewer: {
    edgeAdmits: boolean;
    appPermissions: unknown;
    permissions: { canAdmin: boolean; canWrite: boolean };
} = { edgeAdmits: true, appPermissions: null, permissions: { canAdmin: true, canWrite: true } };
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    const href = (p: string) => `/t/acme${p}`;
    const { offersAdminApiWrite } = jest.requireActual('@/lib/auth/admin-api-affordances');
    const { getPermissionsForRole } = jest.requireActual('@/lib/permissions');
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useOffersAdminApiWrite: (gate: unknown) =>
            offersAdminApiWrite(
                { ...mockViewer, appPermissions: mockViewer.appPermissions ?? getPermissionsForRole('OWNER') },
                gate,
            ),
    };
});

import { SharePointCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/SharePointCard';

const sp = (over: Record<string, unknown> = {}) => ({
    id: 'sp-1',
    name: 'Docs site',
    isEnabled: true,
    configJson: { allowedSiteIds: [] },
    lastTestedAt: null,
    lastTestStatus: 'ok',
    ...over,
});

type Reply = { status?: number; body: unknown };

function serve(connections: unknown[], routes: Record<string, () => Reply> = {}) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace('/api/t/acme', '');
        const method = (init?.method ?? 'GET').toUpperCase();
        const reply: Reply =
            routes[`${method} ${path}`]?.() ??
            (method === 'GET' && path === '/admin/integrations/sharepoint'
                ? { body: connections }
                : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no route' } } });
        const status = reply.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => reply.body } as Response;
    }) as unknown as typeof fetch;
}

const refusal = (message: string, status = 403): Reply => ({
    status,
    body: { error: { code: 'FORBIDDEN', message, requestId: 'req-1' } },
});

describe('a disabled SharePoint connection', () => {
    it('reads Disabled, not Connected, and offers Disconnect alone', async () => {
        serve([sp({ isEnabled: false })]);
        render(<SharePointCard />);
        const row = await screen.findByTestId('sp-connection-sp-1');

        expect(within(row).getByText('Disabled')).toBeInTheDocument();
        expect(within(row).queryByText('Connected')).not.toBeInTheDocument();
        expect(within(row).getByText(/This connection is disabled/)).toBeInTheDocument();
        expect(within(row).queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
        expect(within(row).queryByRole('button', { name: 'Sites' })).not.toBeInTheDocument();
        expect(within(row).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    });

    it('an enabled one still reads Connected and offers all three', async () => {
        serve([sp()]);
        render(<SharePointCard />);
        const row = await screen.findByTestId('sp-connection-sp-1');
        expect(within(row).getByText('Connected')).toBeInTheDocument();
        expect(within(row).getByRole('button', { name: 'Test' })).toBeInTheDocument();
        expect(within(row).getByRole('button', { name: 'Sites' })).toBeInTheDocument();
    });
});

describe('choosing sites', () => {
    it('a site list that cannot be read says why and opens no empty picker', async () => {
        serve([sp()], {
            'GET /admin/integrations/sharepoint/sites?connectionId=sp-1': () =>
                refusal('SharePoint connection is missing credentials — reconnect', 400),
        });
        render(<SharePointCard />);
        fireEvent.click(await screen.findByRole('button', { name: 'Sites' }));

        expect(await screen.findByText('SharePoint connection is missing credentials — reconnect')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save sites' })).not.toBeInTheDocument();
    });

    it('a refused save says why and keeps the picker open', async () => {
        serve([sp()], {
            'GET /admin/integrations/sharepoint/sites?connectionId=sp-1': () => ({
                body: [{ id: 'site-1', displayName: 'HR' }],
            }),
            'PATCH /admin/integrations/sharepoint/sites?connectionId=sp-1': () => refusal('Admin only'),
        });
        render(<SharePointCard />);
        fireEvent.click(await screen.findByRole('button', { name: 'Sites' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Save sites' }));

        expect(await screen.findByText('Admin only')).toBeInTheDocument();
        // Still open: the save did not land, so nothing was saved and the
        // choice is still in front of the admin.
        expect(screen.getByRole('button', { name: 'Save sites' })).toBeInTheDocument();
    });

    it('a save that lands closes the picker', async () => {
        serve([sp()], {
            'GET /admin/integrations/sharepoint/sites?connectionId=sp-1': () => ({
                body: [{ id: 'site-1', displayName: 'HR' }],
            }),
            'PATCH /admin/integrations/sharepoint/sites?connectionId=sp-1': () => ({ body: { ok: true } }),
        });
        render(<SharePointCard />);
        fireEvent.click(await screen.findByRole('button', { name: 'Sites' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Save sites' }));

        await waitFor(() => expect(screen.queryByRole('button', { name: 'Save sites' })).not.toBeInTheDocument());
    });
});

// Every SharePoint call passes the edge, `admin.manage` and the service's
// `assertCanAdmin` (#4466 finding 9): the card offers no control a viewer who
// fails one of them would only be refused.
describe('the controls offered, by who is asking', () => {
    afterEach(() => {
        mockViewer.edgeAdmits = true;
        mockViewer.permissions = { canAdmin: true, canWrite: true };
    });

    it('an Owner is offered Connect (and, above, Test, Sites and Disconnect on a connection)', async () => {
        serve([]);
        render(<SharePointCard />);
        expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    });

    it.each([
        ['an Admin membership on a Reader-based custom role', () => (mockViewer.permissions = { canAdmin: false, canWrite: false })],
        ['an Editor membership the edge refuses', () => (mockViewer.edgeAdmits = false)],
    ])('%s is not offered Connect', async (_who, as) => {
        as();
        serve([]);
        render(<SharePointCard />);
        await screen.findByRole('heading', { level: 2 });
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    });

    it.each([
        ['an Admin membership on a Reader-based custom role', () => (mockViewer.permissions = { canAdmin: false, canWrite: false })],
        ['an Editor membership the edge refuses', () => (mockViewer.edgeAdmits = false)],
    ])('%s is offered none of them', async (_who, as) => {
        as();
        serve([sp()]);
        render(<SharePointCard />);
        const row = await screen.findByTestId('sp-connection-sp-1');
        for (const name of ['Test', 'Sites', 'Disconnect']) {
            expect({ name, offered: within(row).queryAllByRole('button', { name }).length }).toEqual({ name, offered: 0 });
        }
    });
});
