/** @jest-environment jsdom */

/**
 * The SSO page says what is true of the configuration, and never offers a
 * form it could not have loaded.
 *
 *   - The badge read "Enforced" for a disabled provider. Enforcement applies
 *     only to an enabled one (src/lib/auth/sso-enforcement.ts), so that
 *     provider enforced nothing.
 *   - A failed read rendered as "Not Configured" with an empty, saveable form,
 *     and a save from it created a second configuration.
 *   - A failed delete closed the dialog and said nothing.
 *   - The eye button beside the client secret had no accessible name.
 *   - Every method of /api/t/<slug>/sso takes `admin.manage`, but the admin
 *     pages open on `admin.view`, so a role without the key saw an empty
 *     page that looked editable.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/admin/sso',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const lookup = (root: unknown, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = lookup(lookup(en, ns), key);
            if (typeof v !== 'string') return key;
            for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

const permissions = { admin: { view: true, manage: true, owner_management: true } };
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        usePermissions: () => permissions,
    };
});

import SsoAdminPage from '@/app/t/[tenantSlug]/(app)/admin/sso/page';

const OIDC_PROVIDER = {
    id: 'idp-1', type: 'OIDC', name: 'Okta', isEnabled: true, isEnforced: false, emailDomains: ['acme.com'],
    configJson: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: '••••••••' },
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};

interface Reply { ok: boolean; status: number; body: unknown }
const ok = (body: unknown): Reply => ({ ok: true, status: 200, body });
const refused = (status: number, message: string): Reply => ({
    ok: false, status, body: { error: { code: 'ERR', message, requestId: 'req-1' } },
});

/** Answers each method from its own queue; the last reply repeats. */
function serve(replies: Record<string, Reply[]>) {
    const fetchMock = jest.fn(async (_url: string, init?: { method?: string }) => {
        const queue = replies[init?.method ?? 'GET'] ?? [];
        const reply = queue.length > 1 ? queue.shift()! : queue[0];
        if (!reply) throw new Error(`unexpected ${init?.method ?? 'GET'}`);
        return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

afterEach(() => {
    cleanup();
    permissions.admin.manage = true;
});

describe('the SSO page badge', () => {
    it('reads Disabled for a disabled provider, even one saved enforced', async () => {
        serve({ GET: [ok([{ ...OIDC_PROVIDER, isEnabled: false, isEnforced: true }])] });
        render(<SsoAdminPage />);
        expect(await screen.findByText('Disabled')).toBeTruthy();
        expect(screen.queryByText('Enforced')).toBeNull();
    });

    it('reads Enforced only for an enabled, enforced provider, and Enabled otherwise', async () => {
        serve({ GET: [ok([{ ...OIDC_PROVIDER, isEnforced: true }, { ...OIDC_PROVIDER, id: 'idp-2', type: 'SAML', configJson: {} }])] });
        render(<SsoAdminPage />);
        expect(await screen.findByText('Enforced')).toBeTruthy();
        fireEvent.click(document.getElementById('sso-tab-saml') as HTMLElement);
        expect(await screen.findByText('Enabled')).toBeTruthy();
        expect(screen.queryByText('Enforced')).toBeNull();
    });
});

describe('the SSO page when it cannot load', () => {
    it("shows the server's reason and no form to save from, until a retry loads", async () => {
        const fetchMock = serve({ GET: [refused(500, 'Database unavailable'), ok([])] });
        render(<SsoAdminPage />);
        expect(await screen.findByText('Could not load the single sign-on settings')).toBeTruthy();
        expect(screen.getByText('Database unavailable')).toBeTruthy();
        expect(screen.queryByText('Not Configured')).toBeNull();
        expect(document.getElementById('sso-save-btn')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Not Configured')).toBeTruthy();
        expect(document.getElementById('sso-save-btn')).not.toBeNull();
        expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    });
});

describe('the SSO page delete', () => {
    it("shows the server's reason when the deletion is refused, and keeps the configuration", async () => {
        serve({ GET: [ok([OIDC_PROVIDER])], DELETE: [refused(404, 'Identity provider not found')] });
        render(<SsoAdminPage />);
        fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
        await waitFor(() => expect(document.querySelector('[data-modal-confirm]')).not.toBeNull());
        fireEvent.click(document.querySelector('[data-modal-confirm]') as HTMLElement);
        await waitFor(() =>
            expect(document.getElementById('sso-error')?.textContent).toContain('Identity provider not found'),
        );
        expect(screen.queryByText('Configuration deleted')).toBeNull();
        expect(screen.getByText('Enabled')).toBeTruthy();
    });
});

describe('the SSO page client secret', () => {
    it('names the eye button by what it will do', async () => {
        serve({ GET: [ok([OIDC_PROVIDER])] });
        render(<SsoAdminPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Show client secret' }));
        expect(screen.getByRole('button', { name: 'Hide client secret' })).toBeTruthy();
        expect((document.getElementById('sso-oidc-client-secret') as HTMLInputElement).type).toBe('text');
    });
});

describe('the SSO page without admin.manage', () => {
    it('says who can change single sign-on, asks the server nothing, and offers no form', async () => {
        permissions.admin.manage = false;
        const fetchMock = serve({ GET: [ok([OIDC_PROVIDER])] });
        render(<SsoAdminPage />);
        expect(await screen.findByText(/Only an Owner or an Admin can see and change single sign-on/)).toBeTruthy();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(document.getElementById('sso-save-btn')).toBeNull();
        expect(document.getElementById('sso-name')).toBeNull();
        expect(screen.queryByText('Not Configured')).toBeNull();
    });
});
