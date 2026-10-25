/** @jest-environment jsdom */

/**
 * The SSO page shows an Admin the trust fields read-only.
 *
 * Setting up single sign-on, and changing whom it trusts, is Owner-tier
 * (tests/unit/sso-trust-anchor.test.ts holds the server's refusal). The page
 * keeps an Admin from filling in fields the server will not save, and says
 * why. It leaves the rest of the form, and the switches, theirs.
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
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

const permissions = { admin: { view: true, manage: true, owner_management: false } };
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

function serve(providers: unknown[]) {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => providers })) as unknown as typeof fetch;
}

/** A refused read — a 403 or a 500, which is a non-ok response and not a throw. */
function serveFailure(status = 500, body: unknown = { error: 'upstream exploded' }) {
    global.fetch = jest.fn(async () => ({
        ok: false, status, json: async () => body,
    })) as unknown as typeof fetch;
}

afterEach(() => {
    cleanup();
    permissions.admin.owner_management = false;
});

describe('the page tells the truth about its own state (#4116)', () => {
    it('does NOT read "Enforced" for a provider that is enforced but disabled', async () => {
        // The badge asked `isEnforced` before `isEnabled`, and the two flags are
        // stored independently, so this state is reachable — and enforcement
        // applies only to an ENABLED provider. The badge claimed local login was
        // closed while it was open.
        permissions.admin.owner_management = true;
        serve([{ ...OIDC_PROVIDER, isEnabled: false, isEnforced: true }]);
        render(<SsoAdminPage />);

        expect(await screen.findByText('Disabled')).toBeTruthy();
        expect(screen.queryByText('Enforced')).toBeNull();
    });

    it('CONTROL — still reads "Enforced" when it is enforced AND enabled', async () => {
        // Without this, simply deleting the enforced branch would pass the test
        // above. The badge must still report the state it exists to report.
        permissions.admin.owner_management = true;
        serve([{ ...OIDC_PROVIDER, isEnabled: true, isEnforced: true }]);
        render(<SsoAdminPage />);

        expect(await screen.findByText('Enforced')).toBeTruthy();
    });

    it('a FAILED LOAD says so, instead of looking like "Not Configured"', async () => {
        // It swallowed every non-ok response — the comment said "silently fail" —
        // so a 403 or 500 rendered the not-configured badge over a blank form.
        permissions.admin.owner_management = true;
        serveFailure(500);
        render(<SsoAdminPage />);

        expect(await screen.findByText(/upstream exploded/)).toBeTruthy();
        // The badge must say UNKNOWN, not merely stop saying Not Configured.
        // Setting the error beside a lying badge was my first fix and this
        // assertion is what rejected it: the badge is what an administrator
        // reads first, and a failed read is indistinguishable from an absent
        // provider unless the page says which it is.
        expect(screen.getByText('Unknown')).toBeTruthy();
        expect(screen.queryByText('Not Configured')).toBeNull();
    });

    it('and REFUSES to save after one, which is what stops a second configuration', async () => {
        // The dangerous half. `handleSave` sends `id: existingProvider?.id` to
        // choose create vs update; a failed load leaves that undefined, so the
        // server creates a second identity provider for a workspace that already
        // had one — two answers to who it trusts for sign-in.
        permissions.admin.owner_management = true;
        serveFailure(403, { error: 'forbidden' });
        render(<SsoAdminPage />);

        await screen.findByText(/forbidden/);
        expect((document.getElementById('sso-save-btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('CONTROL — a successful load leaves the save enabled', async () => {
        // Pairs with the case above: without it, a page that disabled saving
        // always would satisfy it.
        permissions.admin.owner_management = true;
        serve([OIDC_PROVIDER]);
        render(<SsoAdminPage />);

        await screen.findByText(/unlinks every member/);
        expect((document.getElementById('sso-save-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('the client-secret reveal button has an accessible name', async () => {
        // An icon-only control with no text child reaches a screen reader as
        // "button" and nothing else.
        permissions.admin.owner_management = true;
        serve([OIDC_PROVIDER]);
        render(<SsoAdminPage />);

        expect(await screen.findByRole('button', { name: 'Show client secret' })).toBeTruthy();
    });
});

describe('the SSO page and the trust fields', () => {
    it("shows an Admin the identity provider's fields read-only, and the rest editable", async () => {
        serve([OIDC_PROVIDER]);
        render(<SsoAdminPage />);
        expect(await screen.findByText(/Only an Owner can change the identity provider/)).toBeTruthy();
        for (const id of ['sso-oidc-issuer', 'sso-oidc-client-id', 'sso-domains']) {
            expect((document.getElementById(id) as HTMLInputElement).disabled).toBe(true);
        }
        for (const id of ['sso-name', 'sso-oidc-client-secret', 'sso-oidc-scopes', 'sso-enabled', 'sso-enforced']) {
            expect((document.getElementById(id) as HTMLInputElement).disabled).toBe(false);
        }
        expect((document.getElementById('sso-save-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not let an Admin set up single sign-on at all', async () => {
        serve([]);
        render(<SsoAdminPage />);
        expect(await screen.findByText(/Only an Owner can set up single sign-on/)).toBeTruthy();
        expect((document.getElementById('sso-save-btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('lets an Owner change them, and says what a change does to existing links', async () => {
        permissions.admin.owner_management = true;
        serve([OIDC_PROVIDER]);
        render(<SsoAdminPage />);
        expect(await screen.findByText(/unlinks every member from this configuration/)).toBeTruthy();
        expect((document.getElementById('sso-oidc-issuer') as HTMLInputElement).disabled).toBe(false);
        expect(screen.queryByText(/Only an Owner can/)).toBeNull();
    });
});
