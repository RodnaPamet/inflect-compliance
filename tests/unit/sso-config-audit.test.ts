/**
 * Every change to a workspace's SSO configuration is on the audit trail, and
 * no row carries the provider's secret or certificate.
 *
 * Changing whom a workspace trusts for sign-in, switching it on or off, making
 * it the only way in and deleting it each write a hash-chained `logEvent`
 * row. `detailsJson` streams to the tenant's SIEM (Epic C.4), so it names
 * fields and switch states and never a value from `configJson`.
 */
const SECRET = 'idp-secret-42';
const CERTIFICATE = 'MIICzjCCAbagAwIBAgIUcertificatebody';

const findById = jest.fn();
const provider = (data: Record<string, unknown>) => ({ id: 'idp-1', tenantId: 't1', isEnabled: false, isEnforced: false, ...data });
jest.mock('@/app-layer/repositories/SsoConfigRepository', () => ({
    findById: (...a: unknown[]) => findById(...a),
    upsert: jest.fn(async (_t: string, data: Record<string, unknown>) => provider(data)),
    updateAndRemoveLinks: jest.fn(async (_t: string, id: string, data: Record<string, unknown>) => ({
        provider: provider({ id, ...data }),
        linksRemoved: 2,
    })),
    remove: jest.fn(async () => undefined),
    setEnabled: jest.fn(async (_t: string, id: string, isEnabled: boolean) => provider({ id, type: 'SAML', isEnabled })),
    setEnforced: jest.fn(async (_t: string, id: string, isEnforced: boolean) => provider({ id, type: 'SAML', isEnabled: true, isEnforced })),
}));
jest.mock('@/lib/prisma', () => {
    // A break-glass Owner with a password, so enforcing is allowed.
    const prisma = { tenantMembership: { findMany: jest.fn(async () => [{ user: { passwordHash: 'hash' } }]) } };
    return { __esModule: true, default: prisma, prisma };
});
const logEvent = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import {
    deleteTenantSsoConfig,
    setTenantSsoEnforced,
    toggleTenantSso,
    upsertTenantSsoConfig,
} from '@/app-layer/usecases/sso';
import { UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { makeRequestContext } from '../helpers/make-context';

const ID = 'cmvabcdefghijklmnopqrstuv';
const owner = () => makeRequestContext('OWNER', { tenantId: 't1' });

const STORED_SAML = {
    id: ID, tenantId: 't1', type: 'SAML', isEnabled: true, isEnforced: false, emailDomains: ['acme.com'],
    configJson: { entityId: 'https://idp.acme.example', ssoUrl: 'https://idp.acme.example/sso', certificate: CERTIFICATE },
};

beforeEach(() => {
    findById.mockReset();
    logEvent.mockClear();
});

/** The one audit entry the call wrote. */
function onlyEntry() {
    expect(logEvent).toHaveBeenCalledTimes(1);
    const entry = logEvent.mock.calls[0][2] as { action: string; entityType: string; entityId: string; detailsJson: unknown };
    expect(entry.entityType).toBe('TenantIdentityProvider');
    const written = JSON.stringify(logEvent.mock.calls[0].slice(2));
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain(CERTIFICATE);
    return entry;
}

describe('the SSO configuration audit trail', () => {
    it('records setting a provider up, without its client secret', async () => {
        findById.mockResolvedValue(null);
        await upsertTenantSsoConfig(owner(), UpsertSsoConfigInput.parse({
            name: 'Okta', type: 'OIDC', isEnabled: true,
            config: { issuer: 'https://acme.okta.example', clientId: 'cid', clientSecret: SECRET },
        }));
        expect(onlyEntry()).toMatchObject({ action: 'CREATE' });
    });

    it('records a change to whom it trusts, without the certificate', async () => {
        findById.mockResolvedValue(STORED_SAML);
        await upsertTenantSsoConfig(owner(), UpsertSsoConfigInput.parse({
            id: ID, name: 'ADFS', type: 'SAML', isEnabled: true, emailDomains: ['acme.com'],
            config: { ...STORED_SAML.configJson, entityId: 'https://other-idp.example' },
        }));
        expect(onlyEntry()).toMatchObject({
            action: 'UPDATE', entityId: ID,
            detailsJson: { changedFields: ['entityId'], after: { identityLinksRemoved: 2 } },
        });
    });

    it('records switching it on and off', async () => {
        findById.mockResolvedValue({ ...STORED_SAML, isEnabled: true });
        await toggleTenantSso(owner(), ID, false);
        expect(onlyEntry()).toMatchObject({
            action: 'UPDATE',
            detailsJson: { changedFields: ['isEnabled'], before: { isEnabled: true }, after: { isEnabled: false } },
        });
    });

    it('records making it the only way in, and stopping', async () => {
        findById.mockResolvedValue(STORED_SAML);
        await setTenantSsoEnforced(owner(), ID, true);
        expect(onlyEntry()).toMatchObject({
            detailsJson: { changedFields: ['isEnforced'], before: { isEnforced: false }, after: { isEnforced: true } },
        });

        logEvent.mockClear();
        findById.mockResolvedValue({ ...STORED_SAML, isEnforced: true });
        await setTenantSsoEnforced(owner(), ID, false);
        expect(onlyEntry()).toMatchObject({
            detailsJson: { changedFields: ['isEnforced'], before: { isEnforced: true }, after: { isEnforced: false } },
        });
    });

    it('records deleting it, without the certificate', async () => {
        findById.mockResolvedValue(STORED_SAML);
        await deleteTenantSsoConfig(owner(), ID);
        expect(onlyEntry()).toMatchObject({ action: 'DELETE', entityId: ID, detailsJson: { before: { type: 'SAML' } } });
    });
});
