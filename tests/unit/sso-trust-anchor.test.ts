/**
 * Setting up single sign-on, and changing whom it trusts, is Owner-tier.
 *
 * A sign-in through a workspace's SSO provider becomes a session for
 * whichever member the identity provider names, matched by email on the first
 * sign-in, Owners included. Any Admin could save the provider, so any Admin
 * could point it at an identity provider they run and sign in as an Owner.
 *
 * Now creating a provider, or changing a trust field
 * (src/lib/auth/sso-trust-fields.ts), needs `admin.owner_management`. A trust
 * change also removes every identity link to the provider: a link records
 * that the OLD identity provider vouched for a subject. An Admin keeps the
 * other fields, and enable, enforce and delete.
 */
const findById = jest.fn();
const upsert = jest.fn(async (_tenantId: string, data: Record<string, unknown>) => ({
    id: 'idp-1', tenantId: 't1', isEnabled: false, isEnforced: false, ...data,
}));
const updateAndRemoveLinks = jest.fn(async (_tenantId: string, id: string, data: Record<string, unknown>) => ({
    provider: { id, tenantId: 't1', isEnabled: false, isEnforced: false, ...data },
    linksRemoved: 3,
}));
jest.mock('@/app-layer/repositories/SsoConfigRepository', () => ({
    findById: (...a: unknown[]) => findById(...a),
    upsert: (...a: [string, Record<string, unknown>]) => upsert(...a),
    updateAndRemoveLinks: (...a: [string, string, Record<string, unknown>]) => updateAndRemoveLinks(...a),
}));
jest.mock('@/lib/prisma', () => {
    const prisma = { tenantMembership: { findMany: jest.fn(async () => []) } };
    return { __esModule: true, default: prisma, prisma };
});
const logEvent = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { upsertTenantSsoConfig } from '@/app-layer/usecases/sso';
import { SSO_SECRET_MASK, UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { SSO_TRUST_OWNER_TIER_REFUSAL, changedSsoTrustFields, type SsoTrustState } from '@/lib/auth/sso-trust-fields';
import { makeRequestContext } from '../helpers/make-context';

const ID = 'cmvabcdefghijklmnopqrstuv';
const admin = () => makeRequestContext('ADMIN', { tenantId: 't1' });
const owner = () => makeRequestContext('OWNER', { tenantId: 't1' });

const OIDC = { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: 'real-secret' };
const stored = (extra: Record<string, unknown> = {}) => ({
    id: ID, tenantId: 't1', type: 'OIDC', isEnabled: true, isEnforced: false,
    emailDomains: ['acme.com'],
    configJson: { ...OIDC, scopes: ['openid', 'email', 'profile'], _jit: { allowJitProvisioning: true, jitDefaultRole: 'EDITOR' } },
    ...extra,
});
const save = (config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    UpsertSsoConfigInput.parse({
        id: ID, name: 'Okta', type: 'OIDC', isEnabled: true, emailDomains: ['acme.com'],
        config: { ...OIDC, clientSecret: SSO_SECRET_MASK, ...config },
        ...extra,
    });

beforeEach(() => {
    findById.mockReset();
    upsert.mockClear();
    updateAndRemoveLinks.mockClear();
    logEvent.mockClear();
});

describe('who may change whom single sign-on trusts', () => {
    it('refuses an Admin creating a provider', async () => {
        const { id: _id, ...create } = save({ clientSecret: 'secret' });
        await expect(upsertTenantSsoConfig(admin(), create)).rejects.toMatchObject({
            status: 403,
            details: { reason: SSO_TRUST_OWNER_TIER_REFUSAL },
        });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('lets an Owner create one, with account creation off unless asked for', async () => {
        const { id: _id, ...create } = save({ clientSecret: 'secret' });
        await expect(upsertTenantSsoConfig(owner(), create)).resolves.toBeDefined();
        expect(upsert).toHaveBeenCalledTimes(1);
        const configJson = upsert.mock.calls.at(-1)![1].configJson as Record<string, unknown>;
        expect(configJson._jit).toEqual({ allowJitProvisioning: false, jitDefaultRole: 'READER' });
    });

    it.each([
        ['the issuer', save({ issuer: 'https://attacker.example' }), 'issuer'],
        ['the client ID', save({ clientId: 'other' }), 'clientId'],
        ['the discovery document', save({ discoveryUrl: 'https://attacker.example/.well-known/openid-configuration' }), 'discoveryUrl'],
        ['the email domains', save({}, { emailDomains: ['acme.com', 'attacker.example'] }), 'emailDomains'],
        ['account creation', save({}, { allowJitProvisioning: false }), 'allowJitProvisioning'],
    ])('refuses an Admin changing %s, and names the field', async (_name, input, field) => {
        findById.mockResolvedValue(stored());
        await expect(upsertTenantSsoConfig(admin(), input)).rejects.toMatchObject({
            status: 403,
            details: { reason: SSO_TRUST_OWNER_TIER_REFUSAL, fields: [field] },
        });
        expect(upsert).not.toHaveBeenCalled();
        expect(updateAndRemoveLinks).not.toHaveBeenCalled();
    });

    it('lets an Admin change everything else, keeping every link', async () => {
        findById.mockResolvedValue(stored());
        await upsertTenantSsoConfig(admin(), save(
            { clientSecret: 'rotated', scopes: ['openid', 'email'] },
            { name: 'Renamed', isEnabled: false },
        ));
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(updateAndRemoveLinks).not.toHaveBeenCalled();
    });

    it("keeps the stored account-creation settings when a save leaves them out, as the admin page's does", async () => {
        findById.mockResolvedValue(stored());
        await upsertTenantSsoConfig(admin(), save());
        const configJson = upsert.mock.calls.at(-1)![1].configJson as Record<string, unknown>;
        expect(configJson._jit).toEqual({ allowJitProvisioning: true, jitDefaultRole: 'EDITOR' });
    });

    it("an Owner's trust change removes every identity link to the provider, and is audited", async () => {
        findById.mockResolvedValue(stored());
        await upsertTenantSsoConfig(owner(), save({ issuer: 'https://new-idp.example' }));
        expect(upsert).not.toHaveBeenCalled();
        expect(updateAndRemoveLinks).toHaveBeenCalledWith('t1', ID, expect.objectContaining({ type: 'OIDC' }));
        expect(logEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
            action: 'UPDATE',
            detailsJson: expect.objectContaining({
                changedFields: ['issuer'],
                after: expect.objectContaining({ identityLinksRemoved: 3 }),
            }),
        }));
    });

    it('treats a kept certificate as unchanged, though the browser sent only the mask', async () => {
        findById.mockResolvedValue({
            id: ID, tenantId: 't1', type: 'SAML', isEnabled: true, isEnforced: false, emailDomains: [],
            configJson: { entityId: 'urn:idp', ssoUrl: 'https://login.example/saml', certificate: 'MIIC-real' },
        });
        await upsertTenantSsoConfig(admin(), UpsertSsoConfigInput.parse({
            id: ID, name: 'Entra', type: 'SAML',
            config: { entityId: 'urn:idp', ssoUrl: 'https://login.example/saml', certificate: SSO_SECRET_MASK },
        }));
        expect(upsert).toHaveBeenCalledTimes(1);
    });
});

describe('the trust fields', () => {
    const saml: SsoTrustState = {
        type: 'SAML',
        emailDomains: ['acme.com', 'acme.io'],
        config: { entityId: 'urn:idp', ssoUrl: 'https://login.example/saml', certificate: 'MIICabc\ndef', nameIdFormat: 'x' },
        allowJitProvisioning: false,
        jitDefaultRole: 'READER',
    };

    it('names each SAML trust field that changed', () => {
        expect(changedSsoTrustFields(saml, { ...saml, config: { ...saml.config, entityId: 'urn:other' } })).toEqual(['entityId']);
        expect(changedSsoTrustFields(saml, { ...saml, config: { ...saml.config, ssoUrl: 'https://x' } })).toEqual(['ssoUrl']);
        expect(changedSsoTrustFields(saml, { ...saml, config: { ...saml.config, certificate: 'MIICzzz' } })).toEqual(['certificate']);
        expect(changedSsoTrustFields(saml, { ...saml, jitDefaultRole: 'EDITOR' })).toEqual(['jitDefaultRole']);
        expect(changedSsoTrustFields(saml, { ...saml, type: 'OIDC' })).toEqual(['type']);
    });

    it('does not count what decides how sign-in works rather than whom it believes', () => {
        expect(changedSsoTrustFields(saml, { ...saml, config: { ...saml.config, nameIdFormat: 'y', signRequests: true } })).toEqual([]);
    });

    it('does not count the same certificate pasted differently, or the same domains reordered', () => {
        const armoured = '-----BEGIN CERTIFICATE-----\nMIICabcdef\n-----END CERTIFICATE-----\n';
        expect(changedSsoTrustFields(saml, {
            ...saml,
            emailDomains: ['ACME.io', 'acme.com'],
            config: { ...saml.config, certificate: armoured },
        })).toEqual([]);
    });
});
