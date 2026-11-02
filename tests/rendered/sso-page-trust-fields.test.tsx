/** @jest-environment jsdom */

/**
 * The SSO page shows an Admin the trust fields read-only.
 *
 * Setting up single sign-on, and changing whom it trusts, is Owner-tier
 * (tests/unit/sso-trust-anchor.test.ts holds the server's refusal). The page
 * keeps an Admin from filling in fields the server will not save, and says
 * why. It leaves the rest of the form, and the switches, theirs.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

afterEach(() => {
    cleanup();
    permissions.admin.owner_management = false;
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

// #4971 — every field on the form is named by its label, on both protocols.
describe('the SSO form names its fields', () => {
    const SSO = (require('../../messages/en.json') as { admin: { sso: Record<string, string> } }).admin.sso;
    const field = (label: string) => screen.getByLabelText(label, { exact: true });

    it('names every OIDC field', async () => {
        permissions.admin.owner_management = true;
        serve([]);
        render(<SsoAdminPage />);
        await screen.findByText(SSO.providerName);
        expect(field(SSO.providerName).id).toBe('sso-name');
        expect(field(SSO.emailDomains).id).toBe('sso-domains');
        expect(field(SSO.issuerUrl).id).toBe('sso-oidc-issuer');
        expect(field(SSO.clientId).id).toBe('sso-oidc-client-id');
        expect(field(SSO.clientSecret).id).toBe('sso-oidc-client-secret');
        expect(field(SSO.scopes).id).toBe('sso-oidc-scopes');
    });

    it('names every SAML field, the read-only callback address included', async () => {
        permissions.admin.owner_management = true;
        serve([]);
        render(<SsoAdminPage />);
        await screen.findByText(SSO.providerName);
        fireEvent.click(document.getElementById('sso-tab-saml') as HTMLElement);
        expect((await screen.findByLabelText(SSO.entityId, { exact: true })).id).toBe('sso-saml-entity-id');
        expect(field(SSO.ssoUrl).id).toBe('sso-saml-sso-url');
        expect(field(SSO.certificate).id).toBe('sso-saml-certificate');
        expect(field(SSO.nameIdFormat).id).toBe('sso-saml-nameid');
        expect(field(SSO.acsUrl).id).toBe('sso-saml-acs-url');
    });
});
