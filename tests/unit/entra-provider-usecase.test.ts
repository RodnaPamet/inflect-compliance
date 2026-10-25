/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * EI-1 — entra-provider usecase: permission + config validation.
 *
 * The directory ID decides whose Microsoft sign-ins the group mappings apply
 * to (src/lib/auth/entra-group-sync.ts), so setting the provider up, or
 * changing its directory or client ID, is Owner-tier. An Admin keeps the
 * other settings.
 */
const mockDb = { tenantIdentityProvider: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { getEntraProvider, upsertEntraProvider } from '@/app-layer/usecases/entra-provider';
import { SSO_TRUST_OWNER_TIER_REFUSAL } from '@/lib/auth/sso-trust-fields';
import { makeRequestContext } from '../helpers/make-context';

const admin = makeRequestContext('ADMIN', { tenantId: 't1' });
const owner = makeRequestContext('OWNER', { tenantId: 't1' });
const reader = makeRequestContext('READER', { tenantId: 't1' });

const DIRECTORY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const stored = { aadTenantId: DIRECTORY, clientId: CLIENT, groupClaimMode: 'securityGroup', enforceGroupGate: false };

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.tenantIdentityProvider.create.mockResolvedValue({ id: 'p1' });
    mockDb.tenantIdentityProvider.update.mockResolvedValue({ id: 'p1' });
});

describe('entra-provider usecase', () => {
    it('getEntraProvider rejects a non-admin', async () => {
        await expect(getEntraProvider(reader)).rejects.toBeDefined();
    });

    it('upsertEntraProvider rejects an invalid config', async () => {
        await expect(upsertEntraProvider(owner, { aadTenantId: 'x', clientId: 'y' })).rejects.toBeDefined();
    });

    it('an Owner sets the provider up', async () => {
        mockDb.tenantIdentityProvider.findFirst.mockResolvedValue(null);
        const r = await upsertEntraProvider(owner, { aadTenantId: DIRECTORY, clientId: CLIENT });
        expect(r.id).toBe('p1');
        expect(mockDb.tenantIdentityProvider.create).toHaveBeenCalled();
    });

    it('an Admin cannot set it up', async () => {
        mockDb.tenantIdentityProvider.findFirst.mockResolvedValue(null);
        await expect(upsertEntraProvider(admin, { aadTenantId: DIRECTORY, clientId: CLIENT })).rejects.toMatchObject({
            status: 403,
            details: { reason: SSO_TRUST_OWNER_TIER_REFUSAL, fields: ['provider'] },
        });
        expect(mockDb.tenantIdentityProvider.create).not.toHaveBeenCalled();
    });

    it('an Admin cannot change the directory or client ID, and is told which', async () => {
        mockDb.tenantIdentityProvider.findFirst.mockResolvedValue({ id: 'p1', configJson: stored });
        await expect(
            upsertEntraProvider(admin, { ...stored, aadTenantId: '33333333-3333-4333-8333-333333333333' }),
        ).rejects.toMatchObject({ status: 403, details: { fields: ['aadTenantId'] } });
        await expect(
            upsertEntraProvider(admin, { ...stored, clientId: '44444444-4444-4444-8444-444444444444' }),
        ).rejects.toMatchObject({ status: 403, details: { fields: ['clientId'] } });
        expect(mockDb.tenantIdentityProvider.update).not.toHaveBeenCalled();
    });

    it('an Admin keeps the other settings, and a GUID re-cased is not a change', async () => {
        mockDb.tenantIdentityProvider.findFirst.mockResolvedValue({ id: 'p1', configJson: stored });
        await upsertEntraProvider(admin, { ...stored, aadTenantId: DIRECTORY.toUpperCase(), enforceGroupGate: true });
        expect(mockDb.tenantIdentityProvider.update).toHaveBeenCalled();
    });

    it('an Owner changes the directory', async () => {
        mockDb.tenantIdentityProvider.findFirst.mockResolvedValue({ id: 'p1', configJson: stored });
        await upsertEntraProvider(owner, { ...stored, aadTenantId: '33333333-3333-4333-8333-333333333333' });
        expect(mockDb.tenantIdentityProvider.update).toHaveBeenCalled();
    });
});
