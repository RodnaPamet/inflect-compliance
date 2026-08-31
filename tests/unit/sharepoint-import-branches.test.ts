/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-3 — SharePoint import + delta sync: the refusal, cleanup and fallback
 * branches.
 *
 * `sharepoint-import.test.ts` covers the loop and the claim's happy paths. This
 * file covers what happens when the claim is LOST to a pass that has not
 * finished, when a download fails after the claim was taken (the claim must be
 * released, scoped to this call's placeholder), when the release itself fails,
 * and the naming / tag / token fallbacks that only run when Graph omits fields.
 */
const mockUpload = jest.fn();
const mockGetClient = jest.fn();
const mockEdgeError = jest.fn();
const mockDb = {
    integrationSyncMapping: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        createMany: jest.fn(),
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
    },
    integrationConnection: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
jest.mock('@/app-layer/usecases/evidence', () => ({
    __esModule: true,
    uploadEvidenceFile: (...a: unknown[]) => mockUpload(...a),
}));
jest.mock('@/app-layer/integrations/providers/sharepoint/service', () => ({
    __esModule: true,
    getSharePointClient: (...a: unknown[]) => mockGetClient(...a),
}));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => mockEdgeError(...a) },
}));

import {
    importSharePointItems,
    runSharePointDeltaSync,
} from '@/app-layer/integrations/providers/sharepoint/import';

const ctx = { tenantId: 't1', userId: 'u1', permissions: { canWrite: true } } as any;

function fakeClient(over: any = {}) {
    return {
        getItem: jest.fn(async (_d: string, itemId: string) => ({
            id: itemId,
            name: `${itemId}.pdf`,
            file: { mimeType: 'application/pdf' },
            cTag: `ctag-${itemId}`,
            webUrl: `https://sp/${itemId}`,
            lastModifiedDateTime: '2026-01-01T00:00:00Z',
        })),
        downloadItemContent: jest.fn(async () => new ArrayBuffer(8)),
        getDelta: jest.fn(async () => ({ items: [], deltaToken: 'TK' })),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUpload.mockResolvedValue({ id: 'ev-new' });
    mockDb.integrationSyncMapping.upsert.mockResolvedValue({});
    mockDb.integrationSyncMapping.createMany.mockResolvedValue({ count: 1 });
    mockDb.integrationSyncMapping.findUnique.mockResolvedValue(null);
    mockDb.integrationSyncMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.integrationSyncMapping.findMany.mockResolvedValue([]);
    mockDb.integrationConnection.findFirst.mockResolvedValue({ configJson: {} });
    mockDb.integrationConnection.update.mockResolvedValue({});
    mockGetClient.mockResolvedValue(fakeClient());
});

describe('losing the claim to an UNFINISHED pass', () => {
    it.each([
        ['a claim still PENDING', { localEntityId: 'pending:d1:a', syncStatus: 'PENDING' }],
        ['a mapping in ERROR', { localEntityId: 'ev-1', syncStatus: 'ERROR' }],
        ['a row that vanished between the insert and the read', null],
    ])('refuses with a retry-later message when the existing row is %s', async (_label, existing) => {
        // Only a SYNCED row is a safe no-op. Anything else means another pass
        // owns the item right now; returning its localEntityId would hand back
        // the `pending:` placeholder as if it were an evidence id.
        mockDb.integrationSyncMapping.createMany.mockResolvedValue({ count: 0 });
        mockDb.integrationSyncMapping.findUnique.mockResolvedValue(existing);

        const r = await importSharePointItems(ctx, {
            connectionId: 'c1',
            items: [{ driveId: 'd1', itemId: 'a' }],
        });

        expect(r).toMatchObject({ imported: 0, failed: 1, evidenceIds: [] });
        expect(r.errors[0]).toMatchObject({
            itemId: 'a',
            message: expect.stringMatching(/already being imported by another pass/i),
        });
        expect(mockUpload).not.toHaveBeenCalled();
    });

    it('looks the loser up by the remote id, under the tenant', async () => {
        mockDb.integrationSyncMapping.createMany.mockResolvedValue({ count: 0 });
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(mockDb.integrationSyncMapping.findUnique.mock.calls[0][0].where).toEqual({
            tenantId_provider_remoteEntityType_remoteEntityId: {
                tenantId: 't1',
                provider: 'sharepoint',
                remoteEntityType: 'DriveItem',
                remoteEntityId: 'd1:a',
            },
        });
    });

    it('claims with skipDuplicates BEFORE any download happens', async () => {
        const client = fakeClient();
        mockGetClient.mockResolvedValue(client);
        mockDb.integrationSyncMapping.createMany.mockResolvedValue({ count: 0 });
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        const args = mockDb.integrationSyncMapping.createMany.mock.calls[0][0];
        expect(args.skipDuplicates).toBe(true);
        expect(args.data[0]).toMatchObject({
            localEntityId: 'pending:d1:a',
            remoteEntityId: 'd1:a',
            syncStatus: 'PENDING',
        });
        expect(client.downloadItemContent).not.toHaveBeenCalled();
    });
});

describe('releasing the claim when the import fails', () => {
    it('deletes only the row THIS call created', async () => {
        const client = fakeClient();
        client.downloadItemContent.mockRejectedValue(new Error('graph 500'));
        mockGetClient.mockResolvedValue(client);

        const r = await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });

        expect(r.errors[0].message).toBe('graph 500');
        // Scoped to the placeholder: a claim already resolved into a real
        // mapping no longer matches, so someone else's successful import can
        // never be undone by this cleanup.
        expect(mockDb.integrationSyncMapping.deleteMany).toHaveBeenCalledWith({
            where: {
                tenantId: 't1',
                provider: 'sharepoint',
                remoteEntityType: 'DriveItem',
                remoteEntityId: 'd1:a',
                localEntityId: 'pending:d1:a',
            },
        });
    });

    it('reports the ORIGINAL failure even when the release itself fails', async () => {
        // The cleanup is best-effort. Letting its error win would replace a
        // diagnosable "graph 500" with a database error from the recovery path.
        const client = fakeClient();
        client.getItem.mockRejectedValue(new Error('graph 500'));
        mockGetClient.mockResolvedValue(client);
        mockDb.integrationSyncMapping.deleteMany.mockRejectedValue(new Error('connection terminated'));

        const r = await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(r.errors[0].message).toBe('graph 500');
    });

    it('stringifies a non-Error rejection into the per-item error', async () => {
        const client = fakeClient();
        client.getItem.mockRejectedValue('boom');
        mockGetClient.mockResolvedValue(client);
        const r = await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(r.errors[0].message).toBe('boom');
    });

    it('does not release the claim on success', async () => {
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(mockDb.integrationSyncMapping.deleteMany).not.toHaveBeenCalled();
    });
});

describe('naming and metadata fallbacks', () => {
    const fileArg = () => mockUpload.mock.calls[0][1] as File;

    it('prefers the caller-supplied name over the Graph name', async () => {
        await importSharePointItems(ctx, {
            connectionId: 'c1',
            items: [{ driveId: 'd1', itemId: 'a', name: 'Renamed.pdf' }],
        });
        expect(fileArg().name).toBe('Renamed.pdf');
        expect(mockUpload.mock.calls[0][2]).toMatchObject({ title: 'Renamed.pdf' });
    });

    it('falls back to the Graph name, then to a generic one', async () => {
        mockGetClient.mockResolvedValue(fakeClient({ getItem: jest.fn(async () => ({ id: 'a', name: 'graph.pdf' })) }));
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(fileArg().name).toBe('graph.pdf');

        jest.clearAllMocks();
        mockUpload.mockResolvedValue({ id: 'ev-new' });
        mockDb.integrationSyncMapping.createMany.mockResolvedValue({ count: 1 });
        mockGetClient.mockResolvedValue(fakeClient({ getItem: jest.fn(async () => ({ id: 'a' })) }));
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(fileArg().name).toBe('sharepoint-file');
    });

    it('defaults an unknown mime type to application/octet-stream', async () => {
        // A File with an empty type would be handed to the AV scan and the
        // store with no content type at all.
        mockGetClient.mockResolvedValue(fakeClient({ getItem: jest.fn(async () => ({ id: 'a', name: 'x.bin' })) }));
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(fileArg().type).toBe('application/octet-stream');
    });

    it('forwards the control and category the picker supplied', async () => {
        await importSharePointItems(ctx, {
            connectionId: 'c1',
            items: [{ driveId: 'd1', itemId: 'a' }],
            controlId: 'ctrl-9',
            category: 'Policies',
        });
        expect(mockUpload.mock.calls[0][2]).toMatchObject({ controlId: 'ctrl-9', category: 'Policies' });
    });

    it('nulls the optional evidence targets that were not supplied', async () => {
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        expect(mockUpload.mock.calls[0][2]).toMatchObject({ controlId: null, category: null, folder: null });
    });

    it('writes null sourceUrl / remoteUpdatedAt when Graph omits them', async () => {
        mockGetClient.mockResolvedValue(fakeClient({ getItem: jest.fn(async () => ({ id: 'a', name: 'x.pdf' })) }));
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        const arg = mockDb.integrationSyncMapping.upsert.mock.calls[0][0];
        expect(arg.create).toMatchObject({ sourceUrl: null, remoteUpdatedAt: null });
        expect(arg.update).toMatchObject({ sourceUrl: null, remoteUpdatedAt: null });
    });

    it('parses the Graph timestamp into a Date on the mapping', async () => {
        await importSharePointItems(ctx, { connectionId: 'c1', items: [{ driveId: 'd1', itemId: 'a' }] });
        const arg = mockDb.integrationSyncMapping.upsert.mock.calls[0][0];
        expect(arg.create.remoteUpdatedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
        expect(arg.update.version).toEqual({ increment: 1 });
        expect(arg.update.errorMessage).toBeNull();
    });
});

describe('runSharePointDeltaSync — the branches a quiet drive takes', () => {
    const mapping = (id: string, remoteEntityId: string, remoteDataJson: unknown) => ({
        id,
        remoteEntityId,
        remoteDataJson,
        localEntityId: `ev-${id}`,
    });

    it('does nothing at all when the connection has no mapped items', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([]);
        const client = fakeClient();
        mockGetClient.mockResolvedValue(client);
        const r = await runSharePointDeltaSync(ctx, 'c1');
        expect(r).toEqual({ drivesSynced: 0, reimported: 0, staled: 0 });
        expect(client.getDelta).not.toHaveBeenCalled();
    });

    it('ignores delta items IC does not already track', async () => {
        // The delta covers the whole drive. Importing every file it reports
        // would turn a change feed into a bulk ingest of the library.
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([mapping('m1', 'd1:a', { cTag: 'C1' })]);
        mockGetClient.mockResolvedValue(
            fakeClient({
                getDelta: jest.fn(async () => ({
                    items: [{ id: 'untracked', cTag: 'C9' }, { id: 'also-new', deleted: { state: 'deleted' } }],
                    deltaToken: 'TK2',
                })),
            }),
        );
        const r = await runSharePointDeltaSync(ctx, 'c1');
        expect(r).toMatchObject({ reimported: 0, staled: 0 });
        expect(mockUpload).not.toHaveBeenCalled();
        expect(mockDb.integrationSyncMapping.update).not.toHaveBeenCalled();
    });

    it('skips an item Graph reported with no tag at all', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([mapping('m1', 'd1:a', { cTag: 'C1' })]);
        mockGetClient.mockResolvedValue(
            fakeClient({ getDelta: jest.fn(async () => ({ items: [{ id: 'a' }], deltaToken: 'TK2' })) }),
        );
        expect(await runSharePointDeltaSync(ctx, 'c1')).toMatchObject({ reimported: 0 });
    });

    it('re-imports when the mapping has never recorded a tag', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([mapping('m1', 'd1:a', null)]);
        mockGetClient.mockResolvedValue(
            fakeClient({ getDelta: jest.fn(async () => ({ items: [{ id: 'a', cTag: 'C1' }], deltaToken: 'TK2' })) }),
        );
        expect(await runSharePointDeltaSync(ctx, 'c1')).toMatchObject({ reimported: 1 });
    });

    it('logs a failed re-import and carries on with the rest of the page', async () => {
        // One bad file must not abandon the sync — the delta token is written
        // at the end, so aborting would replay the whole page next run.
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([
            mapping('m1', 'd1:a', { cTag: 'OLD' }),
            mapping('m2', 'd1:b', { cTag: 'OLD' }),
        ]);
        const client = fakeClient({
            getDelta: jest.fn(async () => ({
                items: [{ id: 'a', cTag: 'NEW' }, { id: 'b', cTag: 'NEW' }],
                deltaToken: 'TK2',
            })),
        });
        client.getItem.mockImplementation(async (_d: string, itemId: string) => {
            if (itemId === 'a') throw new Error('403 from Graph');
            return { id: itemId, name: `${itemId}.pdf`, cTag: 'NEW' };
        });
        mockGetClient.mockResolvedValue(client);

        const r = await runSharePointDeltaSync(ctx, 'c1');

        expect(r.reimported).toBe(1);
        expect(mockEdgeError).toHaveBeenCalledWith(
            'SharePoint delta re-import failed',
            expect.objectContaining({ component: 'sharepoint', remoteId: 'd1:a', error: '403 from Graph' }),
        );
        // and the token was still persisted
        expect(mockDb.integrationConnection.update).toHaveBeenCalled();
    });

    it('stringifies a non-Error re-import failure into the log line', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([mapping('m1', 'd1:a', { cTag: 'OLD' })]);
        const client = fakeClient({
            getDelta: jest.fn(async () => ({ items: [{ id: 'a', cTag: 'NEW' }], deltaToken: 'TK2' })),
        });
        client.getItem.mockRejectedValue('graph exploded');
        mockGetClient.mockResolvedValue(client);

        await runSharePointDeltaSync(ctx, 'c1');
        expect(mockEdgeError).toHaveBeenCalledWith(
            'SharePoint delta re-import failed',
            expect.objectContaining({ error: 'graph exploded' }),
        );
    });

    it('walks every distinct drive the mappings mention', async () => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([
            mapping('m1', 'd1:a', { cTag: 'C' }),
            mapping('m2', 'd1:b', { cTag: 'C' }),
            mapping('m3', 'd2:c', { cTag: 'C' }),
        ]);
        const client = fakeClient();
        mockGetClient.mockResolvedValue(client);
        const r = await runSharePointDeltaSync(ctx, 'c1');
        expect(r.drivesSynced).toBe(2);
        expect(client.getDelta.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['d1', 'd2']);
    });
});

describe('delta token persistence', () => {
    beforeEach(() => {
        mockDb.integrationSyncMapping.findMany.mockResolvedValue([
            { id: 'm1', remoteEntityId: 'd1:a', remoteDataJson: { cTag: 'C' }, localEntityId: 'ev1' },
        ]);
    });

    it('resumes each drive from its stored token', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            configJson: { deltaTokens: { d1: 'STORED' } },
        });
        const client = fakeClient();
        mockGetClient.mockResolvedValue(client);
        await runSharePointDeltaSync(ctx, 'c1');
        expect(client.getDelta).toHaveBeenCalledWith('d1', 'STORED');
    });

    it('starts from scratch when the connection carries no tokens', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ configJson: { allowedSiteIds: ['s1'] } });
        const client = fakeClient();
        mockGetClient.mockResolvedValue(client);
        await runSharePointDeltaSync(ctx, 'c1');
        expect(client.getDelta).toHaveBeenCalledWith('d1', undefined);
    });

    it('starts from scratch when the connection row cannot be read', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        const client = fakeClient();
        mockGetClient.mockResolvedValue(client);
        await runSharePointDeltaSync(ctx, 'c1');
        expect(client.getDelta).toHaveBeenCalledWith('d1', undefined);
    });

    it('KEEPS the previous token when a walk returned none (truncated at maxPages)', async () => {
        // Overwriting it with undefined would restart the walk from the
        // beginning of time on the next run.
        mockDb.integrationConnection.findFirst.mockResolvedValue({ configJson: { deltaTokens: { d1: 'STORED' } } });
        mockGetClient.mockResolvedValue(
            fakeClient({ getDelta: jest.fn(async () => ({ items: [], deltaToken: undefined })) }),
        );
        await runSharePointDeltaSync(ctx, 'c1');
        const written = mockDb.integrationConnection.update.mock.calls[0][0].data.configJson;
        expect(written.deltaTokens).toEqual({ d1: 'STORED' });
    });

    it('merges the new tokens over the existing config rather than replacing it', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            configJson: { aadTenantId: 'aad-1', allowedSiteIds: ['s1'], deltaTokens: { d9: 'OTHER' } },
        });
        mockGetClient.mockResolvedValue(
            fakeClient({ getDelta: jest.fn(async () => ({ items: [], deltaToken: 'FRESH' })) }),
        );
        await runSharePointDeltaSync(ctx, 'c1');
        const update = mockDb.integrationConnection.update.mock.calls[0][0];
        expect(update.where).toEqual({ id: 'c1' });
        // The admin's site allowlist survives a background token write.
        expect(update.data.configJson).toEqual({
            aadTenantId: 'aad-1',
            allowedSiteIds: ['s1'],
            deltaTokens: { d1: 'FRESH', d9: 'OTHER' },
        });
    });
});
