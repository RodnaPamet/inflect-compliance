/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-1/SP-2 — SharePoint connection service: the branches the happy-path suite
 * never reaches.
 *
 * Covered here: the disabled-connection fence in `loadConnection`, the rotated
 * token being written BACK to the row, the non-P2002 rethrow, a failing probe
 * recording `error`, the name fallbacks when Graph omits fields, and the two
 * list functions.
 *
 * DB, encryption and audit are mocked; the real Graph client runs on an
 * injected fetch.
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
// Identity crypto: the stored secret round-trips as plain JSON, and an
// "encrypted" value is recognisable in an assertion.
jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    encryptField: (x: string) => `enc(${x})`,
    decryptField: (x: string) => (x.startsWith('enc(') ? x.slice(4, -1) : x),
}));
const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ __esModule: true, logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

const mockExchange = jest.fn();
const mockResolveToken = jest.fn();
jest.mock('@/app-layer/integrations/providers/sharepoint/token', () => ({
    __esModule: true,
    exchangeCodeForSharePointToken: (...a: unknown[]) => mockExchange(...a),
    resolveSharePointAccessToken: (...a: unknown[]) => mockResolveToken(...a),
}));

import {
    completeSharePointConnect,
    getSharePointClient,
    testSharePointConnection,
    listSharePointSites,
    listSharePointConnections,
    updateSharePointAllowedSites,
    getSharePointSitesAndDrives,
    browseSharePoint,
} from '@/app-layer/integrations/providers/sharepoint/service';
import { Prisma } from '@prisma/client';

const admin = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: true } } as any;
const reader = { tenantId: 't1', userId: 'u2', permissions: { canAdmin: false } } as any;
const jsonRes = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body }) as unknown as Response;

const SECRET = JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 });

beforeEach(() => {
    jest.clearAllMocks();
    mockExchange.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 });
    mockResolveToken.mockResolvedValue({ accessToken: 'AT', rotated: null });
    mockDb.integrationConnection.update.mockResolvedValue({});
});

describe('completeSharePointConnect — naming and error mapping', () => {
    it('trims a supplied name and keeps it', async () => {
        mockDb.integrationConnection.create.mockResolvedValue({ id: 'c1' });
        await completeSharePointConnect(admin, { code: 'c', redirectUri: 'r', name: '  Legal Library  ' });
        expect(mockDb.integrationConnection.create.mock.calls[0][0].data.name).toBe('Legal Library');
    });

    it('falls back to "SharePoint" for a whitespace-only name', async () => {
        // `?.trim() || fallback` — a blank string is falsy, so the row never
        // gets an unnamed-looking entry in the connections list.
        mockDb.integrationConnection.create.mockResolvedValue({ id: 'c1' });
        await completeSharePointConnect(admin, { code: 'c', redirectUri: 'r', name: '   ' });
        expect(mockDb.integrationConnection.create.mock.calls[0][0].data.name).toBe('SharePoint');
    });

    it('rethrows a non-P2002 Prisma error unchanged instead of blaming the name', async () => {
        // A foreign-key violation reported as "a connection with this name
        // already exists" sends the admin to rename a row forever.
        const fk = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'x' } as any);
        mockDb.integrationConnection.create.mockRejectedValue(fk);
        await expect(completeSharePointConnect(admin, { code: 'c', redirectUri: 'r' })).rejects.toBe(fk);
    });

    it('rethrows a plain Error unchanged', async () => {
        const boom = new Error('connection pool exhausted');
        mockDb.integrationConnection.create.mockRejectedValue(boom);
        await expect(completeSharePointConnect(admin, { code: 'c', redirectUri: 'r' })).rejects.toBe(boom);
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('audits the creation with the provider on the details', async () => {
        mockDb.integrationConnection.create.mockResolvedValue({ id: 'c9' });
        await completeSharePointConnect(admin, { code: 'c', redirectUri: 'r' });
        expect(mockLogEvent.mock.calls[0][2]).toMatchObject({
            action: 'INTEGRATION_CONNECTION_CREATED',
            entityId: 'c9',
            detailsJson: expect.objectContaining({ provider: 'sharepoint', operation: 'created' }),
        });
    });
});

describe('getSharePointClient', () => {
    it('will not load a DISABLED connection', async () => {
        // `isEnabled` used to be selected and never tested, so an integration
        // an admin had explicitly disabled still authenticated. The fence has
        // to be in the WHERE clause — a flag that only changes how the row
        // renders is not a control.
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(getSharePointClient(admin, 'c1')).rejects.toThrow(/not found or disabled/i);
        expect(mockDb.integrationConnection.findFirst.mock.calls[0][0].where).toMatchObject({
            id: 'c1',
            tenantId: 't1',
            provider: 'sharepoint',
            isEnabled: true,
        });
    });

    it('persists a rotated token back onto the connection row, encrypted', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: ['s1'] },
        });
        const rotated = { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 1234 };
        mockResolveToken.mockImplementation(async (_secret: unknown, deps: any) => {
            await deps.persist(rotated);
            return { accessToken: 'AT2', rotated };
        });

        await getSharePointClient(admin, 'c1');

        const update = mockDb.integrationConnection.update.mock.calls[0][0];
        expect(update.where).toEqual({ id: 'c1' });
        expect(update.data.secretEncrypted).toBe(`enc(${JSON.stringify(rotated)})`);
    });

    it('reads the secret through decryptField, not raw off the column', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: `enc(${SECRET})`,
            configJson: {},
        });
        await getSharePointClient(admin, 'c1');
        expect(mockResolveToken.mock.calls[0][0]).toEqual(JSON.parse(SECRET));
    });

    it('defaults the config when configJson is null (a half-configured connection)', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: null,
        });
        const client = await getSharePointClient(admin, 'c1');
        // Empty, not undefined: `assertDriveAllowed` fails CLOSED on an empty
        // allowlist, and `undefined.length` would throw instead.
        expect(client.allowedSiteIds).toEqual([]);
    });

    it('defaults each config field independently', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { aadTenantId: 'aad-1' },
        });
        const client = await getSharePointClient(admin, 'c1');
        expect(client.allowedSiteIds).toEqual([]);
    });
});

describe('testSharePointConnection', () => {
    beforeEach(() => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: ['s1'] },
        });
    });

    it('records `error` and returns the actionable message on a 401', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({}, false, 401));
        const r = await testSharePointConnection(admin, 'c1', { fetchImpl: fetchImpl as any });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/invalid or expired/i);
        expect(mockDb.integrationConnection.update.mock.calls[0][0].data.lastTestStatus).toBe('error');
    });

    it('is admin-gated', async () => {
        await expect(testSharePointConnection(reader, 'c1')).rejects.toBeDefined();
        expect(mockDb.integrationConnection.findFirst).not.toHaveBeenCalled();
    });
});

describe('listSharePointSites', () => {
    it('returns the Graph site list for an admin', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: [] },
        });
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ value: [{ id: 's1' }, { id: 's2' }] }));
        const sites = await listSharePointSites(admin, 'c1', { fetchImpl: fetchImpl as any });
        expect(sites.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('is admin-gated — the picker must not be a discovery oracle for a reader', async () => {
        await expect(listSharePointSites(reader, 'c1')).rejects.toBeDefined();
        expect(mockDb.integrationConnection.findFirst).not.toHaveBeenCalled();
    });
});

describe('listSharePointConnections', () => {
    it('scopes to the tenant + provider and never selects the secret', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([{ id: 'c1', name: 'SharePoint' }]);
        const rows = await listSharePointConnections(admin);
        expect(rows).toEqual([{ id: 'c1', name: 'SharePoint' }]);
        const args = mockDb.integrationConnection.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 't1', provider: 'sharepoint' });
        expect(args.select.secretEncrypted).toBeUndefined();
        expect(args.take).toBe(50);
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
    });
});

describe('updateSharePointAllowedSites', () => {
    it('seeds a config that was null rather than spreading undefined into it', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'c1', configJson: null });
        await updateSharePointAllowedSites(admin, 'c1', ['s1']);
        expect(mockDb.integrationConnection.update.mock.calls[0][0].data.configJson).toEqual({ allowedSiteIds: ['s1'] });
    });

    it('keeps the rest of the config when replacing the site list', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            configJson: { aadTenantId: 'aad-1', deltaTokens: { d1: 'T' }, allowedSiteIds: ['old'] },
        });
        await updateSharePointAllowedSites(admin, 'c1', ['s2']);
        expect(mockDb.integrationConnection.update.mock.calls[0][0].data.configJson).toEqual({
            aadTenantId: 'aad-1',
            deltaTokens: { d1: 'T' },
            allowedSiteIds: ['s2'],
        });
        expect(mockLogEvent.mock.calls[0][2].detailsJson.summary).toContain('(1)');
    });
});

describe('picker field fallbacks', () => {
    beforeEach(() => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'c1',
            secretEncrypted: SECRET,
            configJson: { allowedSiteIds: ['s1'] },
        });
    });

    it('names a site by name → webUrl → id as Graph drops fields', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ id: 's1', name: 'Team Site' }, 'Team Site'],
            [{ id: 's1', webUrl: 'https://contoso/sites/s1' }, 'https://contoso/sites/s1'],
            [{ id: 's1' }, 's1'],
        ];
        for (const [site, expected] of cases) {
            mockDb.integrationConnection.findFirst.mockResolvedValue({
                id: 'c1',
                secretEncrypted: SECRET,
                configJson: { allowedSiteIds: ['s1'] },
            });
            const fetchImpl = jest.fn(async (url: string) =>
                url.includes('/drives') ? jsonRes({ value: [{ id: 'd1' }] }) : jsonRes(site),
            );
            const res = await getSharePointSitesAndDrives(admin, 'c1', { fetchImpl: fetchImpl as any });
            expect(res.sites).toEqual([{ id: 's1', name: expected }]);
            // A drive with no name still has to be selectable in the picker.
            expect(res.drives['s1']).toEqual([{ id: 'd1', name: 'Documents' }]);
        }
    });

    it('refuses to enumerate sites for a disabled or missing connection', async () => {
        // Called with no injected fetch on purpose: the connection fence has to
        // fire before anything reaches Graph, so the absence of a transport
        // must not matter.
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(getSharePointSitesAndDrives(admin, 'c1')).rejects.toThrow(/not found or disabled/i);
    });

    it('labels an unnamed drive item rather than rendering an empty row', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({ value: [{ id: 'x1' }, { id: 'f1', name: 'Empty folder', folder: {} }] }),
        );
        const res = await browseSharePoint(admin, { connectionId: 'c1', driveId: 'd1' }, { fetchImpl: fetchImpl as any });
        expect(res.items[0]).toMatchObject({ id: 'x1', name: '(unnamed)', isFolder: false, hasChildren: false });
        // A folder Graph reported without childCount is expandable-unknown, and
        // the picker treats that as "no children" rather than showing a
        // permanently empty twisty.
        expect(res.items[1]).toMatchObject({ isFolder: true, hasChildren: false });
    });

    it('reports no cursor when the page is the last one', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        const res = await browseSharePoint(admin, { connectionId: 'c1', driveId: 'd1' }, { fetchImpl: fetchImpl as any });
        expect(res.nextPageToken).toBeUndefined();
    });
});
