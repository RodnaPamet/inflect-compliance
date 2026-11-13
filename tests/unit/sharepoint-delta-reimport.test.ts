/**
 * SharePoint delta sync actually re-imports a changed file (#5193).
 *
 * The delta walk only ever visits items IC already tracks, so every changed
 * item is by definition already mapped. `importOne` claimed items with a
 * `createMany(..., skipDuplicates: true)` insert, which returns count 0 for a
 * mapped item, and then returned the existing evidence id for a SYNCED mapping
 * — without downloading anything and without updating the stored cTag. The run
 * counted `reimported` anyway, and because the delta token advanced regardless,
 * the edit was never offered again. The feature never happened, and the figure
 * said it did.
 *
 * Three properties are pinned here, and each was broken:
 *
 *   1. a CHANGED item is re-downloaded and stored, and the mapping's cTag moves
 *      (without which the same change is seen for ever, or never again);
 *   2. the new Evidence row carries the PREVIOUS row's control links — the
 *      delta caller has no control ids of its own, so a naive re-import
 *      detaches the file from the controls it satisfied, which is worse than
 *      the stale version it replaces;
 *   3. a FAILED re-import holds its drive's delta token back and puts the
 *      mapping back to SYNCED, so the change is retried instead of lost and the
 *      item is not frozen behind "already being imported by another pass".
 */
const getDelta = jest.fn();
const getItem = jest.fn();
const downloadItemContent = jest.fn();
jest.mock('@/app-layer/integrations/providers/sharepoint/service', () => ({
    getSharePointClient: async () => ({ getDelta, getItem, downloadItemContent }),
}));

const uploadEvidenceFile = jest.fn();
jest.mock('@/app-layer/usecases/evidence', () => ({
    uploadEvidenceFile: (...a: unknown[]) => uploadEvidenceFile(...a),
}));
jest.mock('@/app-layer/usecases/evidence-control-links', () => ({
    assertMayChangeEvidenceControlLinks: jest.fn(),
}));

const mappingFindMany = jest.fn();
const mappingUpdateMany = jest.fn();
const mappingUpsert = jest.fn();
const mappingCreateMany = jest.fn();
const mappingFindUnique = jest.fn();
const mappingUpdate = jest.fn();
const linkFindMany = jest.fn();
const connectionFindFirst = jest.fn();
const connectionUpdate = jest.fn();

const db = {
    integrationSyncMapping: {
        findMany: (...a: unknown[]) => mappingFindMany(...a),
        updateMany: (...a: unknown[]) => mappingUpdateMany(...a),
        upsert: (...a: unknown[]) => mappingUpsert(...a),
        createMany: (...a: unknown[]) => mappingCreateMany(...a),
        findUnique: (...a: unknown[]) => mappingFindUnique(...a),
        update: (...a: unknown[]) => mappingUpdate(...a),
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    evidenceControlLink: { findMany: (...a: unknown[]) => linkFindMany(...a) },
    integrationConnection: {
        findFirst: (...a: unknown[]) => connectionFindFirst(...a),
        update: (...a: unknown[]) => connectionUpdate(...a),
    },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_c: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

import { runSharePointDeltaSync } from '@/app-layer/integrations/providers/sharepoint/import';

const ctx = { tenantId: 't-1', userId: 'u-1' } as never;
const REMOTE = 'drive-1:item-1';

/** The stored tokens the connection carries. */
const storedTokens = () => {
    const call = connectionUpdate.mock.calls.at(-1)?.[0] as
        | { data: { configJson: { deltaTokens?: Record<string, string> } } }
        | undefined;
    return call?.data.configJson.deltaTokens ?? {};
};

beforeEach(() => {
    jest.clearAllMocks();
    // One mapped item, SYNCED, whose stored content tag is "v1".
    mappingFindMany.mockResolvedValue([
        { id: 'map-1', remoteEntityId: REMOTE, remoteDataJson: { cTag: 'v1' }, localEntityId: 'ev-old' },
    ]);
    // The insert-claim always loses for an already-mapped item — this is the
    // real behaviour, and the reason the early return was reachable at all.
    mappingCreateMany.mockResolvedValue({ count: 0 });
    mappingFindUnique.mockResolvedValue({ localEntityId: 'ev-old', syncStatus: 'SYNCED' });
    // The status claim wins by default.
    mappingUpdateMany.mockResolvedValue({ count: 1 });
    mappingUpsert.mockResolvedValue({});
    linkFindMany.mockResolvedValue([{ controlId: 'ctl-a' }, { controlId: 'ctl-b' }]);
    connectionFindFirst.mockResolvedValue({ configJson: { deltaTokens: { 'drive-1': 'tok-old' } } });
    connectionUpdate.mockResolvedValue({});
    getItem.mockResolvedValue({
        name: 'policy.pdf',
        eTag: 'e2',
        cTag: 'v2',
        webUrl: 'https://sp.example/policy.pdf',
        lastModifiedDateTime: '2026-11-13T00:00:00Z',
        file: { mimeType: 'application/pdf' },
    });
    downloadItemContent.mockResolvedValue(new ArrayBuffer(8));
    uploadEvidenceFile.mockResolvedValue({ id: 'ev-new' });
});

describe('a CHANGED item', () => {
    beforeEach(() => {
        getDelta.mockResolvedValue({ items: [{ id: 'item-1', cTag: 'v2' }], deltaToken: 'tok-new' });
    });

    it('is downloaded and stored as a new Evidence row', async () => {
        const out = await runSharePointDeltaSync(ctx, 'conn-1');
        expect(downloadItemContent).toHaveBeenCalledTimes(1);
        expect(uploadEvidenceFile).toHaveBeenCalledTimes(1);
        expect(out.reimported).toBe(1);
        expect(out.failed).toBe(0);
    });

    it('moves the mapping onto the new evidence id AND the new cTag', async () => {
        // Without the cTag moving, the next walk sees the same change again —
        // or, once the token has advanced, never sees it at all.
        await runSharePointDeltaSync(ctx, 'conn-1');
        const data = (mappingUpsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
        expect(data.localEntityId).toBe('ev-new');
        expect(data.remoteDataJson).toMatchObject({ cTag: 'v2' });
    });

    it('carries the previous row\'s control links onto the new one', async () => {
        await runSharePointDeltaSync(ctx, 'conn-1');
        const meta = uploadEvidenceFile.mock.calls[0][2] as { controlIds: string[] | null };
        expect(meta.controlIds).toEqual(['ctl-a', 'ctl-b']);
        // Read for the OLD row — the links being carried, not invented.
        expect(linkFindMany.mock.calls[0][0]).toMatchObject({ where: { evidenceId: 'ev-old' } });
    });

    it('claims the mapping by a STATUS transition, since the insert cannot claim an existing row', async () => {
        await runSharePointDeltaSync(ctx, 'conn-1');
        expect(mappingUpdateMany.mock.calls[0][0]).toMatchObject({
            where: { remoteEntityId: REMOTE, syncStatus: 'SYNCED' },
            data: { syncStatus: 'PENDING' },
        });
    });

    it('advances the drive token once the work landed', async () => {
        const out = await runSharePointDeltaSync(ctx, 'conn-1');
        expect(storedTokens()['drive-1']).toBe('tok-new');
        expect(out.tokensHeld).toBe(0);
    });

    it('sends NOTHING and counts nothing when another pass holds the claim', async () => {
        mappingUpdateMany.mockResolvedValue({ count: 0 });
        const out = await runSharePointDeltaSync(ctx, 'conn-1');
        expect(downloadItemContent).not.toHaveBeenCalled();
        expect(out.reimported).toBe(0);
        expect(out.failed).toBe(1);
    });
});

describe('an UNCHANGED item', () => {
    it('is not downloaded, and is not counted', async () => {
        // Same cTag as the stored one. This is the case the early return was
        // written for, and it must keep working.
        getDelta.mockResolvedValue({ items: [{ id: 'item-1', cTag: 'v1' }], deltaToken: 'tok-new' });
        const out = await runSharePointDeltaSync(ctx, 'conn-1');
        expect(downloadItemContent).not.toHaveBeenCalled();
        expect(uploadEvidenceFile).not.toHaveBeenCalled();
        expect(out.reimported).toBe(0);
        expect(storedTokens()['drive-1']).toBe('tok-new');
    });
});

describe('a FAILED re-import', () => {
    beforeEach(() => {
        getDelta.mockResolvedValue({ items: [{ id: 'item-1', cTag: 'v2' }], deltaToken: 'tok-new' });
        downloadItemContent.mockRejectedValue(new Error('Graph 503'));
    });

    it('HOLDS the drive token, so the change is offered again', async () => {
        // The half that made the first defect permanent: a delta response
        // carries only what changed since the token it was given, so advancing
        // past a failure loses that change for good.
        const out = await runSharePointDeltaSync(ctx, 'conn-1');
        expect(out.failed).toBe(1);
        expect(out.reimported).toBe(0);
        expect(out.tokensHeld).toBe(1);
        expect(storedTokens()['drive-1']).toBe('tok-old');
    });

    it('puts the mapping back to SYNCED, so it is not frozen as PENDING', async () => {
        await runSharePointDeltaSync(ctx, 'conn-1');
        const restore = mappingUpdateMany.mock.calls.at(-1)![0] as {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        };
        expect(restore.data).toMatchObject({ syncStatus: 'SYNCED' });
        // Scoped to the row THIS call set pending, so it cannot undo another
        // pass's work.
        expect(restore.where).toMatchObject({ syncStatus: 'PENDING', localEntityId: 'ev-old' });
    });
});
