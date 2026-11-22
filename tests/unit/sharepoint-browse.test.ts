/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-2 — browse + sites service functions. DB/encryption/token mocked; the Graph
 * client is driven by an injected fetch. Locks the DriveItem → SpBrowseItem
 * flattening (folder vs file, hasChildren, mimeType) and the sites/drives shape.
 */
const mockDb = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    encryptField: (x: string) => x,
    decryptField: (x: string) => x,
}));
jest.mock('@/app-layer/events/audit', () => ({ __esModule: true, logEvent: jest.fn() }));
jest.mock('@/app-layer/integrations/providers/sharepoint/token', () => ({
    __esModule: true,
    resolveSharePointAccessToken: jest.fn().mockResolvedValue({ accessToken: 'AT', rotated: null }),
}));

import { browseSharePoint, getSharePointSitesAndDrives } from '@/app-layer/integrations/providers/sharepoint/service';
import { withApprovedDrives } from '../helpers/sharepoint-approved-drives';

const ctx = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: false } } as any;
const SECRET = JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 });
const jsonRes = (body: unknown, ok = true): Response =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

beforeEach(() => jest.clearAllMocks());

describe('browseSharePoint', () => {
    it('flattens Graph DriveItems into folder/file rows', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: ['s1'] },
        });
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({
                value: [
                    { id: 'fold1', name: 'Policies', folder: { childCount: 3 } },
                    { id: 'file1', name: 'soc2.pdf', file: { mimeType: 'application/pdf' }, size: 100, webUrl: 'https://sp/soc2' },
                ],
                '@odata.nextLink': 'https://graph/next',
            }),
        );
        const res = await browseSharePoint(ctx, { connectionId: 'c1', driveId: 'd1' }, { fetchImpl: withApprovedDrives(fetchImpl) as any });
        expect(res.items).toEqual([
            { id: 'fold1', name: 'Policies', isFolder: true, hasChildren: true, webUrl: undefined, size: undefined, mimeType: undefined, lastModified: undefined },
            { id: 'file1', name: 'soc2.pdf', isFolder: false, hasChildren: false, webUrl: 'https://sp/soc2', size: 100, mimeType: 'application/pdf', lastModified: undefined },
        ]);
        expect(res.nextPageToken).toBe('https://graph/next');
        // children of the root (no itemId) → /root/children
        expect(fetchImpl.mock.calls[0][0]).toContain('/drives/d1/root/children');
    });

    it('passes itemId through to a folder children call', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'c1', secretEncrypted: SECRET, configJson: { allowedSiteIds: ['s1'] } });
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await browseSharePoint(ctx, { connectionId: 'c1', driveId: 'd1', itemId: 'fold1' }, { fetchImpl: withApprovedDrives(fetchImpl) as any });
        expect(fetchImpl.mock.calls[0][0]).toContain('/drives/d1/items/fold1/children');
    });

    it('requires a driveId', async () => {
        await expect(browseSharePoint(ctx, { connectionId: 'c1', driveId: '' })).rejects.toBeDefined();
    });
});

describe('getSharePointSitesAndDrives', () => {
    it('resolves each allowed site + its drives', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: ['s1', 's2'] },
        });
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/drives')) return jsonRes({ value: [{ id: 'd1', name: 'Documents' }] });
            // getSite
            const id = url.includes('s1') ? 's1' : 's2';
            return jsonRes({ id, displayName: `Site ${id}` });
        });
        const res = await getSharePointSitesAndDrives(ctx, 'c1', { fetchImpl: fetchImpl as any });
        expect(res.sites).toEqual([
            { id: 's1', name: 'Site s1' },
            { id: 's2', name: 'Site s2' },
        ]);
        expect(res.drives['s1']).toEqual([{ id: 'd1', name: 'Documents' }]);
    });
});
