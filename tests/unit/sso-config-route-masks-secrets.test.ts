/**
 * No stored SSO secret leaves `/api/t/:slug/sso`, on any method.
 *
 * GET masked them; POST and PATCH answered with the saved row as it came
 * back from the database, client secret and certificate in plain text.
 */
const ctx = { tenantId: 't1', userId: 'u1' };
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (_key: string, handler: (req: unknown, args: unknown, c: unknown) => unknown) =>
        (req: unknown, args: unknown) =>
            handler(req, args, ctx),
}));

const row = (configJson: Record<string, unknown>) => ({
    id: 'cmvabcdefghijklmnopqrstuv',
    tenantId: 't1',
    type: 'OIDC',
    name: 'Okta',
    isEnabled: true,
    isEnforced: false,
    configJson,
});
const STORED = { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: 'real-secret', certificate: 'MIIC-real' };
jest.mock('@/app-layer/usecases/sso', () => ({
    getTenantSsoConfig: jest.fn(async () => [row(STORED)]),
    upsertTenantSsoConfig: jest.fn(async () => row(STORED)),
    toggleTenantSso: jest.fn(async () => row(STORED)),
    setTenantSsoEnforced: jest.fn(async () => row(STORED)),
    deleteTenantSsoConfig: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, PATCH, POST } from '@/app/api/t/[tenantSlug]/sso/route';
import { SSO_SECRET_MASK } from '@/app-layer/schemas/sso-config.schemas';

type Handler = (req: NextRequest, args: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;
const URL_ = 'https://app.test/api/t/acme/sso';
const args = () => ({ params: Promise.resolve({ tenantSlug: 'acme' }) });

function expectMasked(body: unknown) {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/real-secret|MIIC-real/);
    const configs = (Array.isArray(body) ? body : [body]).map((p) => (p as { configJson: Record<string, unknown> }).configJson);
    for (const c of configs) {
        expect(c.clientSecret).toBe(SSO_SECRET_MASK);
        expect(c.certificate).toBe(SSO_SECRET_MASK);
        expect(c.clientId).toBe('cid');
    }
}

describe('/api/t/:slug/sso never returns a stored secret', () => {
    it('GET', async () => {
        const res = await (GET as unknown as Handler)(new NextRequest(URL_), args());
        expectMasked(await res.json());
    });

    it('POST', async () => {
        const res = await (POST as unknown as Handler)(
            new NextRequest(URL_, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    id: 'cmvabcdefghijklmnopqrstuv',
                    name: 'Okta',
                    type: 'OIDC',
                    config: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: 'real-secret' },
                }),
            }),
            args(),
        );
        expect(res.status).toBe(200);
        expectMasked(await res.json());
    });

    it('PATCH', async () => {
        const res = await (PATCH as unknown as Handler)(
            new NextRequest(URL_, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: 'cmvabcdefghijklmnopqrstuv', action: 'enable' }),
            }),
            args(),
        );
        expectMasked(await res.json());
    });
});
