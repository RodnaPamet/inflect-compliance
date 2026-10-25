/**
 * The API keys page in the states its help guide describes (#4118):
 *
 *   - a FAILED load shows an error state with the server's reason, never
 *     "No active API keys." — an empty table under a failed load reads as
 *     "this workspace has no keys";
 *   - a refused revoke shows the server's sentence, or the page's fallback —
 *     never "[object Object]" — and nothing overwrites it;
 *   - "No expiry" is a choice in the expiry list, so going back to it is a
 *     choice rather than clicking the chosen option a second time.
 *
 * `next-intl` is the repo's manual mock with ONE `t` per namespace, as the real
 * library returns: the manual mock mints a new function per render, which
 * re-creates the page's fetch callback and refetches on every render, so the
 * table's cells remount under the test and a click lands on a detached node.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const manual = jest.requireActual('../../__mocks__/next-intl.js');
    const cache = new Map<string, unknown>();
    return {
        ...manual,
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, manual.useTranslations(ns));
            return cache.get(ns);
        },
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/admin/api-keys',
    useSearchParams: () => new URLSearchParams(),
}));

import ApiKeysPage from '@/app/t/[tenantSlug]/(app)/admin/api-keys/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const en = require('../../messages/en.json');
const K = en.admin.apiKeys;

const KEY = {
    id: 'key-1',
    name: 'CI pipeline',
    keyPrefix: 'iflk_1a2b3c4d',
    scopes: ['controls:read'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    createdById: 'admin-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: { id: 'admin-1', name: 'Admin', email: 'admin@example.com' },
    agentId: null,
    maxAutonomyLevel: null,
    agent: null,
};

type Answer = { ok: boolean; status: number; body: unknown };
const ok = (body: unknown): Answer => ({ ok: true, status: 200, body });

function mount(answers: { list?: Answer; revoke?: Answer; create?: Answer } = {}) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        let a: Answer = ok({});
        if (u.includes('/admin/agents')) a = ok({ agents: [] });
        else if (init?.method === 'DELETE') a = answers.revoke ?? ok({});
        else if (init?.method === 'POST') a = answers.create ?? ok({ ...KEY, id: 'key-2', plaintext: 'iflk_secret' });
        else if (u.endsWith('/admin/api-keys')) a = answers.list ?? ok([KEY]);
        return { ok: a.ok, status: a.status, json: async () => a.body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'admin-1',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'ADMIN',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('ADMIN'),
                    modules: { processCanvas: false },
                }}
            >
                <ApiKeysPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);
const shown = (id: string) =>
    waitFor(() => {
        const el = byId(id);
        if (!el) throw new Error(`#${id} not shown`);
        return el;
    });

describe('API keys page — a failed load', () => {
    it("shows an error state with the server's reason, and never \"No active API keys.\"", async () => {
        mount({ list: { ok: false, status: 503, body: { error: { code: 'X', message: 'The database is not answering.' } } } });
        const state = await screen.findByTestId('api-keys-load-error');
        expect(state).toHaveTextContent(K.loadFailed);
        expect(state).toHaveTextContent('The database is not answering.');
        expect(screen.queryByText(K.emptyActive)).toBeNull();
        expect(byId('active-keys-table')).toBeNull();
    });

    it('a list that loads still shows the table', async () => {
        mount();
        await shown('active-keys-table');
        expect(screen.queryByTestId('api-keys-load-error')).toBeNull();
        expect(screen.getByText('CI pipeline')).toBeInTheDocument();
    });
});

async function revokeAndConfirm() {
    fireEvent.click(await shown('revoke-key-key-1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: K.revokeConfirm }));
    return shown('api-keys-error');
}

describe('API keys page — a refused revoke', () => {
    it("shows the server's sentence", async () => {
        mount({ revoke: { ok: false, status: 409, body: { error: { code: 'CONFLICT', message: 'API key is already revoked.' } } } });
        const notice = await revokeAndConfirm();
        // Give the old second `setError` its chance to overwrite.
        await new Promise((r) => setTimeout(r, 50));
        expect(byId('api-keys-error')).toHaveTextContent('API key is already revoked.');
        expect(notice).not.toHaveTextContent('[object Object]');
    });

    it('an envelope with no sentence shows the page fallback, not "[object Object]"', async () => {
        mount({ revoke: { ok: false, status: 500, body: { error: { code: 'INTERNAL' } } } });
        await revokeAndConfirm();
        await new Promise((r) => setTimeout(r, 50));
        const notice = byId('api-keys-error')!;
        expect(notice).toHaveTextContent(K.revokeFailed);
        expect(notice).not.toHaveTextContent('[object Object]');
    });
});

describe('API keys page — the expiry list', () => {
    it('offers "No expiry" as a choice, and choosing it sends no expiry', async () => {
        mount();
        fireEvent.click(await shown('create-api-key-btn'));
        fireEvent.click(await shown('key-expiry-select'));
        const options = within(await screen.findByRole('listbox'))
            .getAllByRole('option')
            .map((o) => o.textContent?.trim());
        expect(options).toEqual(
            expect.arrayContaining([K.noExpiry, K.expiry30Days, K.expiry90Days, K.expiry180Days, K.expiry1Year]),
        );

        // Choose 30 days, then go back to No expiry by choosing it.
        fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: K.expiry30Days }));
        fireEvent.click(byId('key-expiry-select')!);
        fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: K.noExpiry }));
        await waitFor(() => expect(byId('key-expiry-select')).toHaveTextContent(K.noExpiry));

        fireEvent.change(byId('key-name-input')!, { target: { value: 'Monitoring' } });
        fireEvent.click(byId('scope-controls-read')!);
        fireEvent.click(byId('key-submit-btn')!);
        await waitFor(() =>
            expect(
                (global.fetch as jest.Mock).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
            ).toBe(true),
        );
        const [, init] = (global.fetch as jest.Mock).mock.calls.find(
            ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
        )!;
        expect(JSON.parse(String((init as RequestInit).body)).expiresAt).toBeNull();
    });
});
