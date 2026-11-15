/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-1 — SharePoint connection-management service. DB, encryption, audit and
 * the token module are mocked; the real Graph client is driven by an injected
 * fetch so testConnection runs without network.
 */
const mockDb = {
    integrationConnection: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
    },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
// Identity crypto so the stored secret round-trips as plain JSON in the test.
jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    encryptField: (x: string) => x,
    decryptField: (x: string) => x,
}));
jest.mock('@/app-layer/events/audit', () => ({ __esModule: true, logEvent: jest.fn() }));
jest.mock('@/app-layer/integrations/providers/sharepoint/token', () => ({
    __esModule: true,
    exchangeCodeForSharePointToken: jest.fn().mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 }),
    resolveSharePointAccessToken: jest.fn().mockResolvedValue({ accessToken: 'AT', rotated: null }),
}));

import {
    completeSharePointConnect,
    getSharePointClient,
    testSharePointConnection,
    updateSharePointAllowedSites,
    disconnectSharePoint,
} from '@/app-layer/integrations/providers/sharepoint/service';
import { Prisma } from '@prisma/client';

const admin = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: true } } as any;
const reader = { tenantId: 't1', userId: 'u2', permissions: { canAdmin: false } } as any;
const jsonRes = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body }) as unknown as Response;

const SECRET = JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 });

beforeEach(() => jest.clearAllMocks());

describe('completeSharePointConnect', () => {
    it('rejects a non-admin', async () => {
        await expect(completeSharePointConnect(reader, { code: 'c', redirectUri: 'r' })).rejects.toBeDefined();
    });
    it('creates an encrypted connection row', async () => {
        mockDb.integrationConnection.create.mockResolvedValue({ id: 'conn1' });
        const r = await completeSharePointConnect(admin, { code: 'c', redirectUri: 'r' });
        expect(r.id).toBe('conn1');
        const data = mockDb.integrationConnection.create.mock.calls[0][0].data;
        expect(data.provider).toBe('sharepoint');
        expect(data.tenantId).toBe('t1');
        expect(data.secretEncrypted).toContain('AT');
    });
    it('maps a duplicate name to a 4xx', async () => {
        mockDb.integrationConnection.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' } as any),
        );
        await expect(completeSharePointConnect(admin, { code: 'c', redirectUri: 'r' })).rejects.toMatchObject({
            message: expect.stringMatching(/already exists/i),
        });
    });
    it('refuses a name with a control character or a lone surrogate before exchanging the code (#5317)', async () => {
        // This path writes the row itself, past the admin route's schema, so it
        // asks the same rule. Refused before the code is spent and before any write.
        const { exchangeCodeForSharePointToken } = jest.requireMock(
            '@/app-layer/integrations/providers/sharepoint/token',
        ) as { exchangeCodeForSharePointToken: jest.Mock };
        for (const name of ['Share\u0000Point', 'SharePoint \uDE00']) {
            await expect(
                completeSharePointConnect(admin, { code: 'c', redirectUri: 'r', name }),
            ).rejects.toMatchObject({ status: 400, details: { reason: 'CONNECTION_NAME_INVALID_CHARACTERS' } });
        }
        expect(exchangeCodeForSharePointToken).not.toHaveBeenCalled();
        expect(mockDb.integrationConnection.create).not.toHaveBeenCalled();
    });
    it('takes an emoji name — the positive control', async () => {
        mockDb.integrationConnection.create.mockResolvedValue({ id: 'conn2' });
        await completeSharePointConnect(admin, { code: 'c', redirectUri: 'r', name: 'Docs 📁' });
        expect(mockDb.integrationConnection.create.mock.calls[0][0].data.name).toBe('Docs 📁');
    });
});

describe('getSharePointClient', () => {
    it('builds a client from the decrypted secret + config', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn1',
            secretEncrypted: SECRET,
            configJson: { aadTenantId: 'aad', allowedSiteIds: ['s1'] },
        });
        const client = await getSharePointClient(admin, 'conn1');
        expect(client.providerId).toBe('sharepoint');
    });
    it('throws when the connection has no stored credentials', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn1', secretEncrypted: null, configJson: {} });
        await expect(getSharePointClient(admin, 'conn1')).rejects.toThrow(/credentials/i);
    });
    it('throws not-found for an unknown connection', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(getSharePointClient(admin, 'missing')).rejects.toBeDefined();
    });
});

describe('testSharePointConnection', () => {
    it('runs the Graph probe and records the result', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: ['s1'] },
        });
        mockDb.integrationConnection.update.mockResolvedValue({});
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ id: 's1', displayName: 'Compliance' }));
        const r = await testSharePointConnection(admin, 'conn1', { fetchImpl: fetchImpl as any });
        expect(r.ok).toBe(true);
        const update = mockDb.integrationConnection.update.mock.calls[0][0];
        expect(update.data.lastTestStatus).toBe('ok');
    });
});

describe('updateSharePointAllowedSites + disconnect', () => {
    it('writes the new allowed sites onto configJson', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn1', configJson: { allowedSiteIds: [] } });
        mockDb.integrationConnection.update.mockResolvedValue({});
        await updateSharePointAllowedSites(admin, 'conn1', ['s1', 's2']);
        const data = mockDb.integrationConnection.update.mock.calls[0][0].data;
        expect((data.configJson as any).allowedSiteIds).toEqual(['s1', 's2']);
    });
    it('disconnect deletes the connection', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn1', aadGroupId: 'x' });
        mockDb.integrationConnection.delete.mockResolvedValue({});
        await disconnectSharePoint(admin, 'conn1');
        expect(mockDb.integrationConnection.delete).toHaveBeenCalledWith({ where: { id: 'conn1' } });
    });
    it('non-admin is rejected', async () => {
        await expect(updateSharePointAllowedSites(reader, 'conn1', [])).rejects.toBeDefined();
        await expect(disconnectSharePoint(reader, 'conn1')).rejects.toBeDefined();
    });
});
