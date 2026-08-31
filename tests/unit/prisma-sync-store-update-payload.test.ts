/**
 * `PrismaSyncMappingStore.updateStatus` — the payload it BUILDS.
 *
 * The narrow `SyncMappingStatusUpdate` type is only half the protection. The
 * other half is this method's field-by-field copy: it walks a fixed list of
 * keys and only forwards the ones the caller actually set, so a `data` object
 * handed to Prisma never contains a key the caller did not name. That matters
 * because Prisma treats `{ localUpdatedAt: undefined }` and an absent key
 * differently at the driver level, and because a spread of the whole `extra`
 * bag would carry `tenantId` — an identity column — straight into `data`.
 *
 * `tests/unit/prisma-sync-store.test.ts` covers the fields the sync flows set
 * every time (errorMessage, lastSyncedAt, version, lastSyncDirection). The
 * three timestamp/blob fields below are set only by the pull path, and the
 * no-extra call is what the deletion webhook makes.
 *
 * Mocking mirrors that file: `withTenantDb` invokes the callback with a fake
 * Prisma client, and `@/lib/prisma` is mocked so the tenant-less fallback is
 * observable rather than a real connection.
 */
const mockIntegrationSyncMapping = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
};

const mockDb = { integrationSyncMapping: mockIntegrationSyncMapping };

const capturedTenantIds: string[] = [];

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: jest.fn(async (tenantId: string, cb: (db: unknown) => Promise<unknown>) => {
        capturedTenantIds.push(tenantId);
        return cb(mockDb);
    }),
}));

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: { integrationSyncMapping: mockIntegrationSyncMapping },
}));

import { PrismaSyncMappingStore } from '@/app-layer/integrations/prisma-sync-store';

function makePrismaRow(over: Record<string, unknown> = {}) {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'sm-1',
        tenantId: 'tenant-1',
        provider: 'github',
        connectionId: 'conn-1',
        localEntityType: 'control',
        localEntityId: 'ctrl-1',
        remoteEntityType: 'branch_protection',
        remoteEntityId: 'main',
        syncStatus: 'SYNCED',
        lastSyncDirection: null,
        conflictStrategy: 'REMOTE_WINS',
        localUpdatedAt: null,
        remoteUpdatedAt: null,
        remoteDataJson: null,
        version: 1,
        errorMessage: null,
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
        ...over,
    };
}

let store: PrismaSyncMappingStore;

beforeEach(() => {
    jest.clearAllMocks();
    capturedTenantIds.length = 0;
    store = new PrismaSyncMappingStore();
    mockIntegrationSyncMapping.update.mockResolvedValue(makePrismaRow());
});

const dataOf = () => mockIntegrationSyncMapping.update.mock.calls[0][0].data;

describe('a status-only update writes exactly one column', () => {
    it('sends nothing but syncStatus when no extra is supplied at all', async () => {
        // The deletion-webhook path calls with only a status. Every optional
        // key must be ABSENT rather than present-and-undefined — a `data` bag
        // carrying explicit undefineds is a different statement to Prisma than
        // one that omits them, and the difference shows up as a nulled column.
        await store.updateStatus('sm-1', 'STALE');

        expect(mockIntegrationSyncMapping.update).toHaveBeenCalledWith({
            where: { id: 'sm-1' },
            data: { syncStatus: 'STALE' },
        });
        expect(Object.keys(dataOf())).toEqual(['syncStatus']);
    });

    it('takes the tenant-less fallback, since the caller already proved the tenant', async () => {
        await store.updateStatus('sm-1', 'STALE');
        expect(capturedTenantIds).toEqual([]);
    });
});

describe('the pull path’s three fields survive the narrowing', () => {
    it('forwards localUpdatedAt, remoteUpdatedAt and remoteDataJson when set', async () => {
        // Dropping any of these silently would break conflict detection rather
        // than the write: `checkForConflict` compares localUpdatedAt against
        // lastSyncedAt and diffs the incoming remote against remoteDataJson, so
        // a mapping missing them reports "no conflict" forever.
        const localUpdatedAt = new Date('2026-03-01T00:00:00.000Z');
        const remoteUpdatedAt = new Date('2026-03-02T00:00:00.000Z');
        const remoteDataJson = { summary: 'Rotate the key', state: 'closed' };

        await store.updateStatus('sm-1', 'SYNCED', {
            tenantId: 'tenant-1',
            localUpdatedAt,
            remoteUpdatedAt,
            remoteDataJson,
        });

        expect(dataOf()).toEqual({
            syncStatus: 'SYNCED',
            localUpdatedAt,
            remoteUpdatedAt,
            remoteDataJson,
        });
        expect(capturedTenantIds).toEqual(['tenant-1']);
    });

    it('forwards an explicit null, which is how a field gets CLEARED', async () => {
        // `!== undefined`, not truthiness. `errorMessage: null` on a successful
        // re-sync is what clears the previous failure off the row; a truthiness
        // check would leave the stale error rendered in the UI forever.
        await store.updateStatus('sm-1', 'SYNCED', {
            tenantId: 'tenant-1',
            errorMessage: null,
            lastSyncDirection: null,
            remoteDataJson: null,
        });

        expect(dataOf()).toEqual({
            syncStatus: 'SYNCED',
            errorMessage: null,
            lastSyncDirection: null,
            remoteDataJson: null,
        });
    });

    it('never forwards tenantId into data — it selects the connection, it is not a column write', async () => {
        await store.updateStatus('sm-1', 'SYNCED', { tenantId: 'tenant-1', version: 3 });

        expect(dataOf()).toEqual({ syncStatus: 'SYNCED', version: 3 });
        expect(dataOf()).not.toHaveProperty('tenantId');
    });
});
