/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/asset.ts`.
 *
 * Roadmap Q3 — Asset (Edge tier, 37% statements, +23 to floor).
 * Single-file domain; this PR closes the whole domain.
 *
 * Covers:
 *   - listAssets / listAssetsPaginated / getAsset — read paths.
 *   - createAsset — repo delegation, audit shape.
 *   - updateAsset — ownerUserId three-state (undefined = no touch,
 *     '' or null = clear); ASSET_ASSIGNED notification fires ONLY
 *     on owner CHANGE to a real user; fire-and-forget error swallow;
 *     notFound + RBAC.
 *   - deleteAsset / restoreAsset / purgeAsset — admin gate +
 *     delegation + audit + notFound.
 *   - listAssetsWithDeleted — admin gate + withDeleted wrapper.
 *   - getAssetEvidenceTab / linkAssetEvidence / unlinkAssetEvidence —
 *     the asset Evidence-tab path (parallel to Risk/Control patterns).
 */

const mockDb = {
    asset: { findFirst: jest.fn(), findMany: jest.fn() },
    // create/updateAsset validate a supplied ownerUserId is an ACTIVE member;
    // default the membership lookup to a hit so owner-bearing writes proceed.
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ userId: 'owner-user' }) },
    evidence: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    // Evidence↔Asset is a join now (one artifact reusable across many
    // assets); the singular `Evidence.assetId` survives only as the
    // "uploaded from" provenance stamp.
    evidenceAssetLink: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
    },
    // B7 — listAssets now folds in WorkItemRepository.countLinkedToEntities
    // (TaskLink count). Default to no links → taskTotal/taskDone = 0.
    taskLink: { findMany: jest.fn().mockResolvedValue([]) },
    // 360° Overview roll-ups (getAsset) — default to zero aggregates.
    assetRiskLink: { count: jest.fn().mockResolvedValue(0) },
    controlAsset: { count: jest.fn().mockResolvedValue(0) },
    // count/findFirst back getAsset's per-asset rollup; groupBy/findMany back
    // listAssets' batched per-asset OPEN-vuln rollup (count + top severity).
    assetVulnerability: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
    },
    // enrichAssetRows now also folds OPEN scanner findings into the rollup.
    scannerFinding: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
    },
    // Asset activity feed (getAssetActivity).
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/AssetRepository', () => ({
    AssetRepository: {
        list: jest.fn(),
        listDeleted: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/app-layer/notifications/assignment', () => ({
    createAssignmentNotification: jest.fn(),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => ({ ...args, _withDeleted: true })),
}));

jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { logEvent } from '@/app-layer/events/audit';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import {
    listAssets,
    listAssetsPaginated,
    getAsset,
    getAssetActivity,
    createAsset,
    updateAsset,
    deleteAsset,
    restoreAsset,
    purgeAsset,
    listAssetsWithDeleted,
    getAssetEvidenceTab,
    linkAssetEvidence,
    unlinkAssetEvidence,
} from '@/app-layer/usecases/asset';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme' });
const editorCtx = makeRequestContext('EDITOR', { tenantSlug: 'acme' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme' });
const auditorCtx = makeRequestContext('AUDITOR');

// ─── Reads ─────────────────────────────────────────────────────────

describe('asset reads', () => {
    it('listAssets delegates under read gate', async () => {
        (AssetRepository.list as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        const rows = await listAssets(readerCtx);
        // B7 — listAssets folds in linked-task counts (0/0 with no links) and
        // the batched per-asset OPEN-vuln rollup (0 / null with no vulns).
        expect(rows).toEqual([{ id: 'a-1', taskTotal: 0, taskDone: 0, openVulnCount: 0, maxVulnSeverity: null }]);
    });

    it('listAssetsPaginated delegates', async () => {
        (AssetRepository.listPaginated as jest.Mock).mockResolvedValue({ items: [], pageInfo: {} });
        await listAssetsPaginated(readerCtx, { limit: 25 } as any);
        expect(AssetRepository.listPaginated).toHaveBeenCalled();
    });

    it('getAsset returns the row plus 360° roll-ups on hit', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.assetRiskLink.count as jest.Mock).mockResolvedValue(2);
        (mockDb.controlAsset.count as jest.Mock).mockResolvedValue(3);
        (mockDb.assetVulnerability.count as jest.Mock).mockResolvedValue(4);
        (mockDb.assetVulnerability.findFirst as jest.Mock).mockResolvedValue({ cve: { cvssSeverity: 'HIGH', cvssScore: 8.1 } });
        (mockDb.taskLink.findMany as jest.Mock).mockResolvedValue([
            { entityId: 'a-1', taskId: 't-1', task: { status: 'OPEN' } },
            { entityId: 'a-1', taskId: 't-2', task: { status: 'CLOSED' } },
        ]);
        const res: any = await getAsset(readerCtx, 'a-1');
        expect(res.id).toBe('a-1');
        expect(res.rollups).toEqual({
            risks: { count: 2 },
            controls: { count: 3 },
            vulnerabilities: { openCount: 4, maxSeverity: 'HIGH', maxScore: 8.1 },
            tasks: { openCount: 1, total: 2 },
        });
    });

    it('getAsset throws notFound on miss', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getAsset(readerCtx, 'missing')).rejects.toThrow(/Asset not found/i);
    });

    it('getAssetActivity returns audit rows under read gate', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.auditLog.findMany as jest.Mock).mockResolvedValue([{ id: 'log-1', action: 'UPDATE' }]);
        await expect(getAssetActivity(readerCtx, 'a-1')).resolves.toEqual([{ id: 'log-1', action: 'UPDATE' }]);
        expect(mockDb.auditLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ entity: 'Asset', entityId: 'a-1' }),
                take: 50,
            }),
        );
    });

    it('getAssetActivity throws notFound on missing asset', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getAssetActivity(readerCtx, 'missing')).rejects.toThrow(/Asset not found/i);
    });
});

// ─── createAsset ──────────────────────────────────────────────────

describe('createAsset', () => {
    it('delegates to AssetRepository.create and emits CREATE audit', async () => {
        (AssetRepository.create as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'Server' });

        const res = await createAsset(editorCtx, { name: 'Server', type: 'SYSTEM' });

        expect(res).toEqual({ id: 'a-1', name: 'Server' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CREATE');
        expect(payload.entityType).toBe('Asset');
    });

    it('rejects READER (write gate)', async () => {
        await expect(createAsset(readerCtx, { name: 'X' })).rejects.toBeDefined();
        expect(AssetRepository.create).not.toHaveBeenCalled();
    });

    it('passes ownerUserId to the repository (people-picker owner)', async () => {
        (AssetRepository.create as jest.Mock).mockResolvedValue({ id: 'a-2', name: 'DB' });
        await createAsset(editorCtx, { name: 'DB', type: 'DATA_STORE', ownerUserId: 'u-7' });
        const createArgs = (AssetRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.ownerUserId).toBe('u-7');
    });

    it('coerces an empty ownerUserId to null', async () => {
        (AssetRepository.create as jest.Mock).mockResolvedValue({ id: 'a-3' });
        await createAsset(editorCtx, { name: 'X', type: 'SYSTEM', ownerUserId: '' });
        const createArgs = (AssetRepository.create as jest.Mock).mock.calls[0][2];
        expect(createArgs.ownerUserId).toBeNull();
    });
});

// ─── updateAsset — three-state + notification ──────────────────────

describe('updateAsset — three-state ownerUserId', () => {
    it('leaves ownerUserId untouched when undefined (no key in patch)', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });

        await updateAsset(editorCtx, 'a-1', { name: 'New' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeUndefined();
    });

    it('clears ownerUserId when explicitly null', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: null });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: null });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeNull();
    });

    it('clears ownerUserId when empty string (falsy)', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: null });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: '' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.ownerUserId).toBeNull();
    });

    it('throws notFound when the asset does not exist', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue(null);
        (AssetRepository.update as jest.Mock).mockResolvedValue(null);
        await expect(updateAsset(editorCtx, 'missing', { name: 'X' })).rejects.toThrow(/Asset not found/i);
    });
});

describe('updateAsset — status reaches the repository', () => {
    // The regression this locks: `UpdateAssetSchema` accepted `status` and
    // the payload built for the repository omitted it, so the detail-page
    // status control and the edit modal both returned 200 OK and changed
    // nothing. Nothing failed — the write simply wasn't in the patch.
    it.each(['ACTIVE', 'RETIRED'] as const)('passes status=%s through', async (status) => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', status: 'ACTIVE' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', status });

        await updateAsset(editorCtx, 'a-1', { status });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.status).toBe(status);
    });

    it('leaves status untouched when the patch omits it', async () => {
        // Three-state, like ownerUserId: absent must not be rewritten.
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', status: 'RETIRED' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', status: 'RETIRED' });

        await updateAsset(editorCtx, 'a-1', { name: 'Renamed' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.status).toBeUndefined();
    });
});

describe('updateAsset — a cleared field becomes NULL, not empty string', () => {
    // The edit form sends EVERY field on every submit, defaulting to '',
    // while the create form omits empties. Passed through, that wrote ''
    // into eleven nullable columns whenever a user cleared one — so "no
    // location" was stored two ways and `IS NULL` filters missed the
    // edited rows.
    const CLEARABLE = [
        'classification',
        'owner',
        'location',
        'dependencies',
        'businessProcesses',
        'dataResidency',
        'retention',
        'externalRef',
        'cpe',
        'vendor',
        'product',
        'version',
    ] as const;

    it.each(CLEARABLE)('normalises a cleared %s to null', async (field) => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1' });

        await updateAsset(editorCtx, 'a-1', { [field]: '' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect({ field, value: updateArgs[field] }).toEqual({ field, value: null });
    });

    it('treats whitespace-only as cleared', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1' });

        await updateAsset(editorCtx, 'a-1', { location: '   ' });

        expect((AssetRepository.update as jest.Mock).mock.calls[0][3].location).toBeNull();
    });

    it('leaves an omitted field undefined rather than nulling it', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1' });

        await updateAsset(editorCtx, 'a-1', { name: 'Renamed' });

        const updateArgs = (AssetRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.location).toBeUndefined();
        expect(updateArgs.cpe).toBeUndefined();
    });

    it('passes a real value through unchanged', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1' });

        await updateAsset(editorCtx, 'a-1', { location: 'Rack 4' });

        expect((AssetRepository.update as jest.Mock).mock.calls[0][3].location).toBe('Rack 4');
    });

    it('rejects READER', async () => {
        await expect(updateAsset(readerCtx, 'a-1', { name: 'X' })).rejects.toBeDefined();
    });
});

describe('updateAsset — ASSET_ASSIGNED notification', () => {
    it('fires only on owner change to a real user', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: 'u-new' });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: 'u-new' });

        expect(createAssignmentNotification).toHaveBeenCalledTimes(1);
        const args = (createAssignmentNotification as jest.Mock).mock.calls[0];
        expect(args[1]).toBe('ASSET_ASSIGNED');
        expect(args[2]).toMatchObject({ assigneeUserId: 'u-new', entityId: 'a-1' });
    });

    it('does NOT fire when owner is unchanged', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-same' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: 'u-same' });

        await updateAsset(editorCtx, 'a-1', { name: 'New' });

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('does NOT fire when owner is cleared', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: 'u-prev' });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: null });

        await updateAsset(editorCtx, 'a-1', { ownerUserId: null });

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('fire-and-forget error swallow on notification failure', async () => {
        (AssetRepository.getById as jest.Mock).mockResolvedValue({ id: 'a-1', ownerUserId: null });
        (AssetRepository.update as jest.Mock).mockResolvedValue({ id: 'a-1', name: 'X', ownerUserId: 'u-new' });
        (createAssignmentNotification as jest.Mock).mockRejectedValue(new Error('Redis down'));

        await expect(updateAsset(editorCtx, 'a-1', { ownerUserId: 'u-new' })).resolves.toMatchObject({ id: 'a-1' });
    });
});

// ─── deleteAsset / restoreAsset / purgeAsset ───────────────────────

describe('deleteAsset', () => {
    it('returns success + SOFT_DELETE audit', async () => {
        (AssetRepository.delete as jest.Mock).mockResolvedValue({ id: 'a-1' });
        const res = await deleteAsset(adminCtx, 'a-1');
        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('SOFT_DELETE');
    });

    it('throws notFound when missing', async () => {
        (AssetRepository.delete as jest.Mock).mockResolvedValue(null);
        await expect(deleteAsset(adminCtx, 'missing')).rejects.toThrow(/Asset not found/i);
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(deleteAsset(editorCtx, 'a-1')).rejects.toBeDefined();
    });
});

describe('restoreAsset', () => {
    it('delegates to restoreEntity', async () => {
        (restoreEntity as jest.Mock).mockResolvedValue({ success: true });
        await restoreAsset(adminCtx, 'a-1');
        expect(restoreEntity).toHaveBeenCalledWith(adminCtx, 'Asset', 'a-1');
    });
});

describe('purgeAsset', () => {
    it('delegates to purgeEntity', async () => {
        (purgeEntity as jest.Mock).mockResolvedValue({ success: true });
        await purgeAsset(adminCtx, 'a-1');
        expect(purgeEntity).toHaveBeenCalledWith(adminCtx, 'Asset', 'a-1');
    });
});

describe('listAssetsWithDeleted', () => {
    it('admin-gated + delegates to AssetRepository.listDeleted (deleted-scope query)', async () => {
        (AssetRepository.listDeleted as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        await listAssetsWithDeleted(adminCtx, { q: 'srv' });
        // The deleted-only scoping + withDeleted wrapper now live in the
        // repository; the usecase must delegate there and forward the filters.
        expect(AssetRepository.listDeleted).toHaveBeenCalledWith(mockDb, adminCtx, { q: 'srv' });
    });

    it('rejects AUDITOR', async () => {
        await expect(listAssetsWithDeleted(auditorCtx)).rejects.toBeDefined();
    });

    it('rejects READER', async () => {
        await expect(listAssetsWithDeleted(readerCtx)).rejects.toBeDefined();
    });
});

// ─── Evidence-tab paths ────────────────────────────────────────────

describe('getAssetEvidenceTab', () => {
    it('returns { links: [], evidence } shape', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue({ id: 'a-1' });
        // The tab reads through the join and flattens to the evidence rows.
        (mockDb.evidenceAssetLink.findMany as jest.Mock).mockResolvedValue([
            { id: 'l-1', evidence: { id: 'e-1' } },
        ]);

        const res = await getAssetEvidenceTab(readerCtx, 'a-1');

        expect(res).toEqual({ links: [], evidence: [{ id: 'e-1' }] });
    });

    it('throws notFound when the asset is missing (no evidence query fires)', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(getAssetEvidenceTab(readerCtx, 'missing')).rejects.toThrow(/Asset not found/i);
        expect(mockDb.evidenceAssetLink.findMany).not.toHaveBeenCalled();
    });
});

describe('linkAssetEvidence', () => {
    it('creates a LINK Evidence record + emits ASSET_EVIDENCE_LINKED + bumps cache', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.evidence.create as jest.Mock).mockResolvedValue({ id: 'e-1' });

        const res = await linkAssetEvidence(editorCtx, 'a-1', { url: 'https://example.com', note: 'doc' });

        expect(res).toEqual({ id: 'e-1' });
        const createArgs = (mockDb.evidence.create as jest.Mock).mock.calls[0][0].data;
        expect(createArgs.type).toBe('LINK');
        expect(createArgs.content).toBe('https://example.com');
        // The association itself lives in the join — without this row the
        // upload would not appear on the asset it was attached from.
        expect(mockDb.evidenceAssetLink.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ evidenceId: 'e-1', assetId: 'a-1' }),
            }),
        );
        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'evidence');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('ASSET_EVIDENCE_LINKED');
    });

    it('trims the url before persisting', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue({ id: 'a-1' });
        (mockDb.evidence.create as jest.Mock).mockResolvedValue({ id: 'e-1' });

        await linkAssetEvidence(editorCtx, 'a-1', { url: '  https://example.com  ' });

        const createArgs = (mockDb.evidence.create as jest.Mock).mock.calls[0][0].data;
        expect(createArgs.content).toBe('https://example.com');
    });

    it('throws notFound when the asset does not exist', async () => {
        (mockDb.asset.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(linkAssetEvidence(editorCtx, 'missing', { url: 'x' })).rejects.toThrow(/Asset not found/i);
    });

    it('rejects READER', async () => {
        await expect(linkAssetEvidence(readerCtx, 'a-1', { url: 'x' })).rejects.toBeDefined();
    });
});

describe('unlinkAssetEvidence', () => {
    it('drops the join row + clears the provenance stamp + emits unlink audit', async () => {
        (mockDb.evidenceAssetLink.findFirst as jest.Mock).mockResolvedValue({ id: 'l-1' });

        const res = await unlinkAssetEvidence(editorCtx, 'a-1', 'e-1');

        expect(res).toEqual({ success: true });
        // Detach = drop the join row. The evidence survives in the library
        // and stays attached to any OTHER assets it links to.
        expect(mockDb.evidenceAssetLink.delete).toHaveBeenCalledWith({ where: { id: 'l-1' } });
        // …and the "uploaded from" stamp is cleared only when it pointed here.
        const updateArgs = (mockDb.evidence.updateMany as jest.Mock).mock.calls[0][0];
        expect(updateArgs.where).toEqual(
            expect.objectContaining({ id: 'e-1', assetId: 'a-1' }),
        );
        expect(updateArgs.data.assetId).toBeNull();
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('ASSET_EVIDENCE_UNLINKED');
    });

    it('throws notFound when the asset-evidence join row is missing', async () => {
        (mockDb.evidenceAssetLink.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(unlinkAssetEvidence(editorCtx, 'a-1', 'missing')).rejects.toThrow(/Asset evidence not found/i);
        expect(mockDb.evidenceAssetLink.delete).not.toHaveBeenCalled();
    });

    it('rejects READER', async () => {
        await expect(unlinkAssetEvidence(readerCtx, 'a-1', 'e-1')).rejects.toBeDefined();
    });
});
