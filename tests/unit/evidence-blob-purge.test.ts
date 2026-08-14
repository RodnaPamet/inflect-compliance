/**
 * `purgeEvidenceBlobs` — the purge has to delete the bytes, not just the row.
 *
 * `docs/data-retention.md` presents Evidence as the one entity with a complete
 * lifecycle ending in a 365-day hard purge. All three purge paths deleted the
 * DATABASE ROW only — none of them even imported a storage provider — so the
 * DATA_PURGED audit entry attested a destruction that had not happened.
 *
 * The tests that matter most here are the ones about NOT deleting. `pathKey`
 * lives on FileRecord and `uploadEvidenceFile` de-duplicates by SHA-256, so one
 * FileRecord can back several Evidence rows. A naive fix frees the blob when the
 * first of them is purged and silently breaks the rest — turning a retention fix
 * into data loss. That is the failure mode worth pinning.
 */
import { purgeEvidenceBlobs } from '@/app-layer/services/evidence-blob-purge';

const deleteMock = jest.fn();
const findManyMock = jest.fn();
const countMock = jest.fn();
const findUniqueMock = jest.fn();
const frDeleteMock = jest.fn();

jest.mock('@/lib/storage/index', () => ({
    __esModule: true,
    getProviderByName: () => ({ name: 'local', delete: (...a: unknown[]) => deleteMock(...a) }),
}));

jest.mock('@/lib/soft-delete', () => ({
    __esModule: true,
    // Pass through — the real helper only tags args for the extension.
    withDeleted: (a: unknown) => a,
}));

const db = {
    evidence: {
        findMany: (...a: unknown[]) => findManyMock(...a),
        count: (...a: unknown[]) => countMock(...a),
    },
    fileRecord: {
        findUnique: (...a: unknown[]) => findUniqueMock(...a),
        delete: (...a: unknown[]) => frDeleteMock(...a),
    },
} as never;

const FILE = { id: 'fr-1', pathKey: 'tenants/t1/evidence/a.pdf', storageProvider: 'local' };

beforeEach(() => {
    jest.clearAllMocks();
    findUniqueMock.mockResolvedValue(FILE);
    deleteMock.mockResolvedValue(undefined);
    frDeleteMock.mockResolvedValue(undefined);
});

describe('purgeEvidenceBlobs', () => {
    it('deletes the blob and the FileRecord when nothing else references it', async () => {
        findManyMock.mockResolvedValue([{ id: 'ev-1', fileRecordId: 'fr-1' }]);
        countMock.mockResolvedValue(0);

        const out = await purgeEvidenceBlobs(db, ['ev-1']);

        expect(deleteMock).toHaveBeenCalledWith(FILE.pathKey);
        expect(frDeleteMock).toHaveBeenCalledWith({ where: { id: 'fr-1' } });
        expect(out.deleted).toBe(1);
    });

    it('RETAINS the blob when another Evidence row shares the FileRecord', async () => {
        // The SHA-256 dedup case. Deleting here would break the sibling — the
        // difference between a retention fix and data loss.
        findManyMock.mockResolvedValue([{ id: 'ev-1', fileRecordId: 'fr-1' }]);
        countMock.mockResolvedValue(1);

        const out = await purgeEvidenceBlobs(db, ['ev-1']);

        expect(deleteMock).not.toHaveBeenCalled();
        expect(frDeleteMock).not.toHaveBeenCalled();
        expect(out.retainedForSibling).toBe(1);
    });

    it('excludes the rows being purged from the sibling count', async () => {
        // Two deduped rows purged in the SAME pass. Counting naively, each
        // would see the other as a surviving sibling, both would retain, and
        // the blob would never be freed by any purge. The count must exclude
        // the whole batch, not just the current row.
        findManyMock.mockResolvedValue([
            { id: 'ev-1', fileRecordId: 'fr-1' },
            { id: 'ev-2', fileRecordId: 'fr-1' },
        ]);
        countMock.mockResolvedValue(0);

        await purgeEvidenceBlobs(db, ['ev-1', 'ev-2']);

        const where = countMock.mock.calls[0][0].where;
        expect(where.id).toMatchObject({ not: 'ev-1', notIn: ['ev-1', 'ev-2'] });
    });

    it('treats an already-absent object as reconciled, not failed', async () => {
        findManyMock.mockResolvedValue([{ id: 'ev-1', fileRecordId: 'fr-1' }]);
        countMock.mockResolvedValue(0);
        deleteMock.mockRejectedValue(new Error('NoSuchKey: the specified key does not exist'));

        const out = await purgeEvidenceBlobs(db, ['ev-1']);

        expect(out.alreadyGone).toBe(1);
        expect(out.failed).toBe(0);
        // Goal state reached, so the pointer row goes too.
        expect(frDeleteMock).toHaveBeenCalled();
    });

    it('reports a real provider failure AND keeps the FileRecord row', async () => {
        // The row is the only remaining pointer to the object. Dropping it
        // makes the orphan unfindable, so a failure must leave it in place —
        // and must be counted, because the product will otherwise attest a
        // destruction that did not happen.
        findManyMock.mockResolvedValue([{ id: 'ev-1', fileRecordId: 'fr-1' }]);
        countMock.mockResolvedValue(0);
        deleteMock.mockRejectedValue(new Error('AccessDenied'));

        const out = await purgeEvidenceBlobs(db, ['ev-1']);

        expect(out.failed).toBe(1);
        expect(out.deleted).toBe(0);
        expect(frDeleteMock).not.toHaveBeenCalled();
    });

    it('does nothing for evidence with no file (TEXT / LINK)', async () => {
        findManyMock.mockResolvedValue([{ id: 'ev-1', fileRecordId: null }]);

        const out = await purgeEvidenceBlobs(db, ['ev-1']);

        expect(deleteMock).not.toHaveBeenCalled();
        expect(out.nothingToDelete).toBe(1);
    });

    it('is a no-op on an empty batch', async () => {
        const out = await purgeEvidenceBlobs(db, []);
        expect(findManyMock).not.toHaveBeenCalled();
        expect(out.deleted).toBe(0);
    });
});
