/**
 * The sign-in page asks `/api/auth/sso/discover` which identity providers a
 * workspace offers. The route is public — nobody is signed in yet — so what
 * it returns, and what it refuses to distinguish, is the whole contract:
 *
 *   - a workspace's ENABLED providers, as id, protocol and display name only;
 *   - the same empty answer for an unknown workspace, one without SSO, and a
 *     malformed name, so it says nothing more than "no SSO here";
 *   - asked by workspace, never by email domain (see the route's header).
 */
const providerRows = [
    {
        id: 'idp-oidc',
        tenantId: 'tenant-acme',
        type: 'OIDC',
        name: 'Okta',
        isEnabled: true,
        isEnforced: false,
        configJson: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: 'very-secret' },
        emailDomains: ['acme.example'],
    },
    {
        id: 'idp-saml',
        tenantId: 'tenant-acme',
        type: 'SAML',
        name: 'Entra',
        isEnabled: true,
        isEnforced: false,
        configJson: { entityId: 'urn:acme', ssoUrl: 'https://login.example/saml', certificate: 'MIIC-secret' },
        emailDomains: [],
    },
];

const tenantFindUnique = jest.fn(async ({ where }: { where: { slug: string } }) =>
    where.slug === 'acme' ? { id: 'tenant-acme' } : where.slug === 'plain' ? { id: 'tenant-plain' } : null,
);
const providerFindMany = jest.fn(async ({ where }: { where: { tenantId: string; isEnabled: boolean } }) =>
    providerRows.filter((p) => p.tenantId === where.tenantId && p.isEnabled === where.isEnabled),
);
jest.mock('@/lib/prisma', () => {
    const prisma = {
        tenant: { findUnique: (args: never) => tenantFindUnique(args) },
        tenantIdentityProvider: { findMany: (args: never) => providerFindMany(args) },
    };
    return { __esModule: true, default: prisma, prisma };
});

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/sso/discover/route';

async function discover(workspace: string | null) {
    const url = new URL('http://localhost:3000/api/auth/sso/discover');
    if (workspace !== null) url.searchParams.set('workspace', workspace);
    const res = await GET(new NextRequest(url), {} as never);
    expect(res.status).toBe(200);
    return res.json();
}

beforeEach(() => {
    tenantFindUnique.mockClear();
    providerFindMany.mockClear();
});

describe('GET /api/auth/sso/discover', () => {
    it("lists a workspace's enabled providers by id, protocol and name, and nothing of their configuration", async () => {
        const body = await discover('acme');
        expect(body).toEqual({
            providers: [
                { id: 'idp-oidc', protocol: 'oidc', name: 'Okta' },
                { id: 'idp-saml', protocol: 'saml', name: 'Entra' },
            ],
        });
        expect(JSON.stringify(body)).not.toMatch(/secret|issuer|acme\.example|certificate/);
    });

    it('reads the workspace name case- and space-insensitively', async () => {
        expect((await discover('  ACME ')).providers).toHaveLength(2);
    });

    it('answers an unknown workspace exactly as it answers one without SSO', async () => {
        expect(await discover('nobody-here')).toEqual({ providers: [] });
        expect(await discover('plain')).toEqual({ providers: [] });
    });

    it('answers a malformed or missing name the same way, without a lookup', async () => {
        expect(await discover('../acme')).toEqual({ providers: [] });
        expect(await discover('a'.repeat(101))).toEqual({ providers: [] });
        expect(await discover(null)).toEqual({ providers: [] });
        expect(tenantFindUnique).not.toHaveBeenCalled();
    });
});
