/**
 * Saving the SSO form keeps the secrets the admin did not touch, never hands
 * them back, and cannot switch enforcement on behind the break-glass check.
 *
 * The admin page shows a stored client secret or certificate as a mask and,
 * when the admin leaves that field alone, sends the mask back. The server
 * stored it as given, so every save of an existing provider — to rename it,
 * fix a domain, flip JIT — overwrote its client secret or certificate with
 * "••••••••", and the next sign-in failed at the identity provider. Now the
 * mask on a save means "keep what is stored" (`upsertTenantSsoConfig`).
 *
 * Two neighbours in the same flow:
 *   - the POST and PATCH responses returned the saved row unmasked;
 *   - the form's `isEnforced` was written straight through, so saving the
 *     form was a way round the break-glass check the Enforce toggle runs.
 */
const findById = jest.fn();
const upsert = jest.fn(async (_tenantId: string, data: Record<string, unknown>) => ({ id: 'idp-1', tenantId: 't1', ...data }));
jest.mock('@/app-layer/repositories/SsoConfigRepository', () => ({
    findById: (...a: unknown[]) => findById(...a),
    upsert: (...a: [string, Record<string, unknown>]) => upsert(...a),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));
const breakGlassMembers: { role: string; user: { passwordHash: string | null } }[] = [];
jest.mock('@/lib/prisma', () => {
    const prisma = {
        tenantMembership: { findMany: jest.fn(async () => breakGlassMembers) },
    };
    return { __esModule: true, default: prisma, prisma };
});

import { upsertTenantSsoConfig } from '@/app-layer/usecases/sso';
import { SSO_SECRET_MASK, UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { makeRequestContext } from '../helpers/make-context';

const ctx = () => makeRequestContext('ADMIN', { tenantId: 't1' });
const ID = 'cmvabcdefghijklmnopqrstuv';

const oidcSave = (clientSecret: string, extra: Record<string, unknown> = {}) =>
    UpsertSsoConfigInput.parse({
        id: ID,
        name: 'Okta',
        type: 'OIDC',
        isEnabled: true,
        config: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret },
        ...extra,
    });

const storedOidc = (clientSecret: string, extra: Record<string, unknown> = {}) => ({
    id: ID,
    tenantId: 't1',
    type: 'OIDC',
    isEnforced: false,
    configJson: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret },
    ...extra,
});

const savedConfig = () => (upsert.mock.calls.at(-1)![1].configJson as Record<string, unknown>);

beforeEach(() => {
    findById.mockReset();
    upsert.mockClear();
    breakGlassMembers.length = 0;
});

describe('saving an SSO provider', () => {
    it('keeps the stored client secret when the admin left it alone', async () => {
        findById.mockResolvedValue(storedOidc('real-secret'));
        await upsertTenantSsoConfig(ctx(), oidcSave(SSO_SECRET_MASK));
        expect(savedConfig().clientSecret).toBe('real-secret');
    });

    it('keeps the stored SAML certificate the same way', async () => {
        findById.mockResolvedValue({
            id: ID, tenantId: 't1', type: 'SAML', isEnforced: false,
            configJson: { entityId: 'urn:idp', ssoUrl: 'https://login.example/saml', certificate: 'MIIC-real' },
        });
        await upsertTenantSsoConfig(ctx(), UpsertSsoConfigInput.parse({
            id: ID, name: 'Entra', type: 'SAML',
            config: { entityId: 'urn:idp', ssoUrl: 'https://login.example/saml', certificate: SSO_SECRET_MASK },
        }));
        expect(savedConfig().certificate).toBe('MIIC-real');
    });

    it('replaces it when the admin typed a new one', async () => {
        findById.mockResolvedValue(storedOidc('real-secret'));
        await upsertTenantSsoConfig(ctx(), oidcSave('rotated-secret'));
        expect(savedConfig().clientSecret).toBe('rotated-secret');
    });

    it('refuses the mask on a new provider: nothing is stored to keep', async () => {
        // Creating a provider is Owner-tier (tests/unit/sso-trust-anchor.test.ts).
        await expect(
            upsertTenantSsoConfig(makeRequestContext('OWNER', { tenantId: 't1' }), UpsertSsoConfigInput.parse({
                name: 'Okta', type: 'OIDC',
                config: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: SSO_SECRET_MASK },
            })),
        ).rejects.toMatchObject({ status: 400 });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('asks again for a secret an earlier save already overwrote with the mask', async () => {
        findById.mockResolvedValue(storedOidc(SSO_SECRET_MASK));
        await expect(upsertTenantSsoConfig(ctx(), oidcSave(SSO_SECRET_MASK))).rejects.toMatchObject({ status: 400 });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('cannot switch enforcement on without somebody able to break glass', async () => {
        findById.mockResolvedValue(storedOidc('real-secret'));
        breakGlassMembers.push({ role: 'ADMIN', user: { passwordHash: null } });
        await expect(upsertTenantSsoConfig(ctx(), oidcSave(SSO_SECRET_MASK, { isEnforced: true })))
            .rejects.toThrow(/break-glass/i);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('switches it on when an OWNER with a password can break glass, and re-checks nothing already on', async () => {
        findById.mockResolvedValue(storedOidc('real-secret'));
        breakGlassMembers.push({ role: 'OWNER', user: { passwordHash: '$2b$10$hash' } });
        await upsertTenantSsoConfig(ctx(), oidcSave(SSO_SECRET_MASK, { isEnforced: true }));
        expect(upsert.mock.calls.at(-1)![1].isEnforced).toBe(true);

        breakGlassMembers.length = 0;
        findById.mockResolvedValue(storedOidc('real-secret', { isEnforced: true }));
        await expect(upsertTenantSsoConfig(ctx(), oidcSave(SSO_SECRET_MASK, { isEnforced: true }))).resolves.toBeDefined();
    });
});
