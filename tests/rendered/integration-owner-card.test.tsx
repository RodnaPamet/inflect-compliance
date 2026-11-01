/**
 * The connection owner card (#3672) — where integration passport field P11 is
 * set.
 *
 * Three claims:
 *
 *   • it applies only to `mcp-server` connections, the population that has a
 *     passport, and renders NOTHING on any other provider's page;
 *   • while no owner is stored it SAYS so, because until one is named the
 *     weekly sweep raises CONNECTION_OWNER_MISSING and every drift finding on
 *     the connection goes to the tenant's owners with no assignee;
 *   • Save sends exactly `{ ownerUserId }` to the owner route — its own PUT
 *     rather than a field on the connection upsert, which would re-enable a
 *     disabled connection — and picking or clearing writes nothing until then.
 *
 * The people picker is stubbed: it is exercised by its own tests, and here it
 * is only the lever that changes the local selection.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const at = (path: string, from: unknown): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            from,
        );
    const cache = new Map<string, (key: string) => string>();
    return {
        useTranslations: (ns: string) => {
            const hit = cache.get(ns);
            if (hit) return hit;
            const t = (key: string) => {
                const v = at(key, at(ns, en));
                return typeof v === 'string' ? v : `${ns}.${key}`;
            };
            cache.set(ns, t);
            return t;
        },
        useLocale: () => 'en',
    };
});

// STABLE identities, as the real hooks' `useCallback` gives.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const ctx = { tenantSlug: 'acme' };
    return { useTenantApiUrl: () => apiUrl, useTenantContext: () => ctx };
});

jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: ({
        id,
        selectedId,
        onChange,
    }: {
        id?: string;
        selectedId: string | null;
        onChange: (userId: string | null, member: null) => void;
    }) => (
        <div id={id}>
            <span data-testid="picker-selected">{selectedId ?? ''}</span>
            <button type="button" data-testid="pick-u2" onClick={() => onChange('u2', null)}>pick</button>
        </div>
    ),
}));

import { IntegrationOwnerCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/IntegrationOwnerCard';

const en = require('../../messages/en.json') as {
    admin: { integrations: { owner: Record<string, string> } };
};
const O = en.admin.integrations.owner;

let calls: { url: string; method: string; body: unknown }[] = [];
let putOk = true;
let putRefusal: unknown = {};

/** The connection as the page's executions read gives it (#4870). */
const conn = (over: Record<string, unknown> = {}) => ({
    id: 'conn_1',
    name: 'Agent tools',
    provider: 'mcp-server',
    isEnabled: true,
    ownerUserId: null as string | null,
    ...over,
});
const realFetch = global.fetch;

beforeEach(() => {
    calls = [];
    putOk = true;
    putRefusal = {};
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (method === 'PUT') {
            if (!putOk) return { ok: false, status: 400, json: async () => putRefusal };
            const owner = (body as { ownerUserId: string | null }).ownerUserId;
            return { ok: true, status: 200, json: async () => ({ connectionId: 'conn_1', ownerUserId: owner, changed: true }) };
        }
        return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
});

afterEach(() => {
    global.fetch = realFetch;
});

const writes = () => calls.filter((c) => c.method !== 'GET');

describe('IntegrationOwnerCard — which connections', () => {
    it('renders NOTHING for a connection that is not mcp-server', async () => {
        const { container } = render(<IntegrationOwnerCard connection={conn({ provider: 'okta' })} />);
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container).toBeEmptyDOMElement();
    });

    it('renders for an mcp-server connection, and reads nothing to decide (#4870)', async () => {
        render(<IntegrationOwnerCard connection={conn()} />);
        expect(screen.getByTestId('integration-owner')).toBeInTheDocument();
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        // It used to download every connection in the workspace to learn this
        // one's provider.
        expect(calls).toHaveLength(0);
    });
});

describe('IntegrationOwnerCard — no owner', () => {
    it('says no owner is named', async () => {
        render(<IntegrationOwnerCard connection={conn()} />);
        await waitFor(() => expect(screen.getByTestId('integration-owner-missing')).toHaveTextContent(O.missing));
    });

    it('shows no warning once an owner is stored, and pre-selects them', async () => {
        render(<IntegrationOwnerCard connection={conn({ ownerUserId: 'u1' })} />);
        await waitFor(() => expect(screen.getByTestId('picker-selected')).toHaveTextContent('u1'));
        expect(screen.queryByTestId('integration-owner-missing')).toBeNull();
    });
});

describe('IntegrationOwnerCard — saving', () => {
    it('writes nothing until Save, then PUTs exactly { ownerUserId } to the owner route', async () => {
        render(<IntegrationOwnerCard connection={conn()} />);
        await waitFor(() => expect(screen.getByTestId('integration-owner')).toBeInTheDocument());

        const save = document.getElementById('integration-owner-save') as HTMLButtonElement;
        expect(save).toBeDisabled();

        fireEvent.click(screen.getByTestId('pick-u2'));
        expect(writes()).toHaveLength(0);
        expect(save).not.toBeDisabled();

        fireEvent.click(save);
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0]).toEqual({
            url: '/api/t/acme/admin/integrations/conn_1/owner',
            method: 'PUT',
            body: { ownerUserId: 'u2' },
        });
        await waitFor(() => expect(screen.getByTestId('integration-owner-message')).toHaveTextContent(O.saved));
        expect(screen.queryByTestId('integration-owner-missing')).toBeNull();
    });

    it('clears an owner by saving null', async () => {
        render(<IntegrationOwnerCard connection={conn({ ownerUserId: 'u1' })} />);
        await waitFor(() => expect(screen.getByTestId('picker-selected')).toHaveTextContent('u1'));

        fireEvent.click(document.getElementById('integration-owner-clear') as HTMLButtonElement);
        expect(writes()).toHaveLength(0);
        fireEvent.click(document.getElementById('integration-owner-save') as HTMLButtonElement);

        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0].body).toEqual({ ownerUserId: null });
        await waitFor(() => expect(screen.getByTestId('integration-owner-missing')).toBeInTheDocument());
    });

    it("shows the server's refusal rather than one fixed sentence", async () => {
        putOk = false;
        putRefusal = { error: { code: 'BAD_REQUEST', message: 'Owner must be an active member of this tenant' } };
        render(<IntegrationOwnerCard connection={conn()} />);
        await waitFor(() => expect(screen.getByTestId('integration-owner')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('pick-u2'));
        fireEvent.click(document.getElementById('integration-owner-save') as HTMLButtonElement);
        await waitFor(() =>
            expect(screen.getByTestId('integration-owner-message')).toHaveTextContent(
                'Owner must be an active member of this tenant',
            ),
        );
    });

    it('a refusal with no sentence falls back to saying the save failed', async () => {
        putOk = false;
        putRefusal = {};
        render(<IntegrationOwnerCard connection={conn()} />);
        await waitFor(() => expect(screen.getByTestId('integration-owner')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('pick-u2'));
        fireEvent.click(document.getElementById('integration-owner-save') as HTMLButtonElement);
        await waitFor(() => expect(screen.getByTestId('integration-owner-message')).toHaveTextContent(O.saveFailed));
        // The stored owner did not change, so the warning stays.
        expect(screen.getByTestId('integration-owner-missing')).toBeInTheDocument();
    });
});
