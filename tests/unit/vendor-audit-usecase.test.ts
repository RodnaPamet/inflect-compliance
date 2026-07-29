/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-C coverage — vendor-audit usecase (evidence bundles + subprocessors,
 * previously 0% branches).
 *
 * Branch-exercises the frozen-bundle guards, the freeze snapshot loop
 * (per entityType, found vs missing), the self-subprocessor rejection and
 * the not-found paths against a mocked tenant-scoped `db`. Vendor policies
 * and the audit emitter are mocked at the boundary.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/app-layer/policies/vendor.policies', () => ({
    assertCanReadVendors: jest.fn(),
    assertCanManageVendors: jest.fn(),
    assertCanManageVendorDocs: jest.fn(),
    // Bulk export is its own authority, not a synonym for read — the three
    // export usecases gate on this rather than assertCanReadVendors, which
    // is true for every role including READER.
    assertCanExportVendors: jest.fn(),
}));

import { logEvent } from '@/app-layer/events/audit';
import {
    listEvidenceBundles,
    createEvidenceBundle,
    addBundleItem,
    removeBundleItem,
    freezeBundle,
    getEvidenceBundle,
    listSubprocessors,
    addSubprocessor,
    removeSubprocessor,
    exportVendorsRegister,
} from '@/app-layer/usecases/vendor-audit';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function freshDb() {
    return {
        vendorEvidenceBundle: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: 'b1' }),
            update: jest.fn().mockResolvedValue({ id: 'b1', frozenAt: new Date() }),
        },
        vendorEvidenceBundleItem: {
            create: jest.fn().mockResolvedValue({ id: 'i1' }),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue({}),
        },
        vendorDocument: { findFirst: jest.fn() },
        vendorAssessment: { findFirst: jest.fn() },
        vendor: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        vendorRelationship: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: 'rel1' }),
            delete: jest.fn().mockResolvedValue({}),
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = freshDb();
});

describe('evidence bundles', () => {
    it('lists and creates a bundle (with audit)', async () => {
        await listEvidenceBundles(ctx, 'v1');
        expect(mockDbHolder.db.vendorEvidenceBundle.findMany).toHaveBeenCalled();

        await createEvidenceBundle(ctx, 'v1', { name: 'Q1', description: 'd' });
        expect(mockDbHolder.db.vendorEvidenceBundle.create).toHaveBeenCalled();
        expect((logEvent as jest.Mock).mock.calls[0][2].action).toBe('VENDOR_EVIDENCE_BUNDLE_CREATED');
    });

    it('addBundleItem: rejects missing bundle, frozen bundle, then creates', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce(null);
        await expect(addBundleItem(ctx, 'b1', { entityType: 'ASSESSMENT', entityId: 'a1' })).rejects.toThrow('Bundle not found');

        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: new Date() });
        await expect(addBundleItem(ctx, 'b1', { entityType: 'ASSESSMENT', entityId: 'a1' })).rejects.toThrow('frozen');

        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: null });
        // The item target is now resolved in-tenant before the write.
        db.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a1' });
        const r = await addBundleItem(ctx, 'b1', { entityType: 'ASSESSMENT', entityId: 'a1' });
        expect(r).toEqual({ id: 'i1' });
    });

    it('addBundleItem: refuses a target that does not resolve in this tenant', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: null });
        db.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        await expect(
            addBundleItem(ctx, 'b1', { entityType: 'ASSESSMENT', entityId: 'foreign' }),
        ).rejects.toThrow();
        // freezeBundle tenant-scopes its snapshot lookup, so a foreign id
        // used to freeze into an EMPTY snapshot with no error at all.
        expect(db.vendorEvidenceBundleItem.create).not.toHaveBeenCalled();
    });

    it('addBundleItem: refuses an unknown item type', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: null });
        await expect(
            addBundleItem(ctx, 'b1', { entityType: 'NOT_A_THING', entityId: 'x' }),
        ).rejects.toThrow();
    });

    it('removeBundleItem: missing bundle, frozen, item-not-found, then success', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce(null);
        await expect(removeBundleItem(ctx, 'b1', 'i1')).rejects.toThrow('Bundle not found');

        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: new Date() });
        await expect(removeBundleItem(ctx, 'b1', 'i1')).rejects.toThrow('frozen');

        db.vendorEvidenceBundle.findFirst.mockResolvedValue({ id: 'b1', frozenAt: null });
        db.vendorEvidenceBundleItem.deleteMany.mockResolvedValueOnce({ count: 0 });
        await expect(removeBundleItem(ctx, 'b1', 'i1')).rejects.toThrow('Item not found');

        db.vendorEvidenceBundleItem.deleteMany.mockResolvedValueOnce({ count: 1 });
        expect(await removeBundleItem(ctx, 'b1', 'i1')).toEqual({ deleted: true });
    });

    it('getEvidenceBundle: throws when missing, returns when present', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce(null);
        await expect(getEvidenceBundle(ctx, 'b1')).rejects.toThrow('Bundle not found');

        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1' });
        expect(await getEvidenceBundle(ctx, 'b1')).toEqual({ id: 'b1' });
    });
});

describe('freezeBundle', () => {
    it('rejects missing / already-frozen / empty bundles', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce(null);
        await expect(freezeBundle(ctx, 'b1')).rejects.toThrow('Bundle not found');

        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: new Date(), items: [{}] });
        await expect(freezeBundle(ctx, 'b1')).rejects.toThrow('already frozen');

        db.vendorEvidenceBundle.findFirst.mockResolvedValueOnce({ id: 'b1', frozenAt: null, items: [] });
        await expect(freezeBundle(ctx, 'b1')).rejects.toThrow('empty bundle');
    });

    it('snapshots VENDOR_DOCUMENT + ASSESSMENT items, skips unknown/missing, then freezes + audits', async () => {
        const db = mockDbHolder.db;
        db.vendorEvidenceBundle.findFirst.mockResolvedValue({
            id: 'b1', vendorId: 'v1', name: 'Q1', frozenAt: null,
            items: [
                { id: 'i-doc', entityType: 'VENDOR_DOCUMENT', entityId: 'doc1' },
                { id: 'i-ass', entityType: 'ASSESSMENT', entityId: 'a1' },
                { id: 'i-miss', entityType: 'VENDOR_DOCUMENT', entityId: 'gone' }, // doc not found → no snapshot
                { id: 'i-unk', entityType: 'OTHER', entityId: 'x' },               // unknown type → no snapshot
            ],
        });
        db.vendorDocument.findFirst.mockImplementation(({ where }: any) =>
            where.id === 'doc1'
                ? Promise.resolve({ type: 'SOC2', title: 't', externalUrl: null, validTo: null })
                : Promise.resolve(null),
        );
        db.vendorAssessment.findFirst.mockResolvedValue({ status: 'DONE', score: 5, riskRating: 'LOW', startedAt: new Date() });

        await freezeBundle(ctx, 'b1');

        // Branch: only the two resolvable items get a snapshot update.
        expect(db.vendorEvidenceBundleItem.update).toHaveBeenCalledTimes(2);
        const updatedIds = db.vendorEvidenceBundleItem.update.mock.calls.map((c: any) => c[0].where.id);
        expect(updatedIds.sort()).toEqual(['i-ass', 'i-doc']);
        expect(db.vendorEvidenceBundle.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'b1' } }),
        );
        expect((logEvent as jest.Mock).mock.calls.some((c: any) => c[2].action === 'VENDOR_EVIDENCE_BUNDLE_FROZEN')).toBe(true);
    });
});

describe('subprocessors', () => {
    it('lists; rejects self-subprocessor and missing subprocessor; then adds with audit', async () => {
        const db = mockDbHolder.db;
        await listSubprocessors(ctx, 'v1');
        expect(db.vendorRelationship.findMany).toHaveBeenCalled();

        // Branch: self-subprocessor rejected.
        await expect(addSubprocessor(ctx, 'v1', { subprocessorVendorId: 'v1' })).rejects.toThrow('its own subprocessor');

        // Branch: subprocessor vendor not found.
        db.vendor.findFirst.mockResolvedValueOnce(null);
        await expect(addSubprocessor(ctx, 'v1', { subprocessorVendorId: 'v2' })).rejects.toThrow('not found');

        // Two lookups now: the subprocessor target, then the PRIMARY —
        // vendorId comes straight off the URL path and was never verified.
        db.vendor.findFirst.mockResolvedValueOnce({ id: 'v2', name: 'Sub' });
        db.vendor.findFirst.mockResolvedValueOnce({ id: 'v1' });
        const rel = await addSubprocessor(ctx, 'v1', { subprocessorVendorId: 'v2', purpose: 'p' });
        expect(rel).toEqual({ id: 'rel1' });
        expect((logEvent as jest.Mock).mock.calls.some((c: any) => c[2].action === 'VENDOR_SUBPROCESSOR_ADDED')).toBe(true);
    });

    it('addSubprocessor: refuses a primary vendor outside this tenant', async () => {
        const db = mockDbHolder.db;
        db.vendor.findFirst.mockResolvedValueOnce({ id: 'v2', name: 'Sub' }); // target resolves
        db.vendor.findFirst.mockResolvedValueOnce(null); // primary does not
        await expect(
            addSubprocessor(ctx, 'foreign-primary', { subprocessorVendorId: 'v2' }),
        ).rejects.toThrow();
        expect(db.vendorRelationship.create).not.toHaveBeenCalled();
    });

    it('removeSubprocessor: not-found then success with audit', async () => {
        const db = mockDbHolder.db;
        db.vendorRelationship.findFirst.mockResolvedValueOnce(null);
        await expect(removeSubprocessor(ctx, 'rel1')).rejects.toThrow('Relationship not found');

        db.vendorRelationship.findFirst.mockResolvedValueOnce({ id: 'rel1', primaryVendorId: 'v1', subprocessorVendorId: 'v2' });
        expect(await removeSubprocessor(ctx, 'rel1')).toEqual({ deleted: true });
        expect(db.vendorRelationship.delete).toHaveBeenCalled();
    });
});

describe('exports', () => {
    it('exportVendorsRegister queries vendors ordered by name', async () => {
        await exportVendorsRegister(ctx);
        expect(mockDbHolder.db.vendor.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { name: 'asc' } }),
        );
    });
});
