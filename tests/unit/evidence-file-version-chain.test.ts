/**
 * `getEvidenceFileVersions` — the walk up the file-version linked list.
 *
 * Uncovered (`evidence.ts:1131-1187`), and it is the one read in this file
 * that is a LOOP rather than a query. `FileRecord` has no `evidenceId`, so
 * versions can only be reached one hop at a time via `previousFileRecordId`,
 * which makes three things load-bearing that a single query would get for
 * free:
 *
 *   1. Every hop is tenant-scoped. A missing `tenantId` on the second hop
 *      would be invisible to any test that only ever walks one.
 *   2. The walk is BOUNDED. `previousFileRecordId` is a plain column with no
 *      constraint preventing a cycle, so without the cap a self-referencing
 *      or looped chain does not return a wrong answer — it hangs the request.
 *   3. A broken chain BREAKS, it does not throw. A deleted mid-chain record
 *      must truncate the history, not 500 the evidence detail page.
 */

const mockDb = {
    evidence: { findFirst: jest.fn() },
    fileRecord: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({ EvidenceRepository: {} }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(), bumpEntityCacheVersion: jest.fn(),
}));
jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(), purgeEntity: jest.fn(),
}));
jest.mock('@/lib/soft-delete', () => ({ withDeleted: jest.fn((a: unknown) => a) }));

import { getEvidenceFileVersions } from '@/app-layer/usecases/evidence';
import { makeRequestContext } from '../helpers/make-context';

/** Build a chain head -> ... -> tail as a lookup the mock resolves against. */
function chain(ids: string[]) {
    const byId = new Map(
        ids.map((id, i) => [id, {
            id,
            originalName: `${id}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 100 + i,
            sha256: `sha-${id}`,
            createdAt: new Date(`2026-0${(i % 9) + 1}-01T00:00:00Z`),
            previousFileRecordId: ids[i + 1] ?? null,
        }]),
    );
    mockDb.fileRecord.findFirst.mockImplementation(async (args: { where: { id: string } }) =>
        byId.get(args.where.id) ?? null,
    );
    return byId;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.evidence.findFirst.mockResolvedValue({ fileRecordId: 'f3', fileVersion: 3 });
    mockDb.fileRecord.findFirst.mockResolvedValue(null);
});

describe('getEvidenceFileVersions', () => {
    it('refuses evidence outside the tenant', async () => {
        mockDb.evidence.findFirst.mockResolvedValue(null);
        await expect(
            getEvidenceFileVersions(makeRequestContext('READER', { tenantId: 't-9' }), 'other-tenants-evidence'),
        ).rejects.toThrow(/Evidence not found/);
        expect(mockDb.evidence.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'other-tenants-evidence', tenantId: 't-9' } }),
        );
    });

    it('walks the chain newest-first, numbering versions downward', async () => {
        chain(['f3', 'f2', 'f1']);
        const out = await getEvidenceFileVersions(makeRequestContext('READER'), 'e1');

        expect(out.fileVersion).toBe(3);
        // Version numbers count DOWN from the head's `fileVersion`, so they
        // match what the UI shows for the current file rather than being a
        // 1-based index into the walk.
        expect(out.versions.map((v) => [v.id, v.version, v.isCurrent])).toEqual([
            ['f3', 3, true],
            ['f2', 2, false],
            ['f1', 1, false],
        ]);
    });

    // EVERY hop, not just the first. A tenant clause present on the initial
    // lookup and absent on the walk is the shape a one-hop fixture cannot see.
    it('scopes every hop to the tenant and to non-deleted records', async () => {
        chain(['f3', 'f2', 'f1']);
        await getEvidenceFileVersions(makeRequestContext('READER', { tenantId: 't-7' }), 'e1');

        expect(mockDb.fileRecord.findFirst).toHaveBeenCalledTimes(3);
        for (const call of mockDb.fileRecord.findFirst.mock.calls) {
            expect(call[0].where).toMatchObject({ tenantId: 't-7', deletedAt: null });
        }
    });

    // A soft-deleted or purged mid-chain record truncates the history. The
    // evidence page still has to render — losing older versions is a degraded
    // answer, a 500 is no answer.
    it('truncates at a missing record instead of throwing', async () => {
        chain(['f3', 'f2']); // f2 points at f1, which does not resolve
        const out = await getEvidenceFileVersions(makeRequestContext('READER'), 'e1');
        expect(out.versions.map((v) => v.id)).toEqual(['f3', 'f2']);
    });

    it('returns an empty history when the evidence has no file at all', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ fileRecordId: null, fileVersion: 0 });
        const out = await getEvidenceFileVersions(makeRequestContext('READER'), 'e1');
        expect(out).toEqual({ fileVersion: 0, versions: [] });
        expect(mockDb.fileRecord.findFirst).not.toHaveBeenCalled();
    });

    // THE TERMINATION GUARANTEE. `previousFileRecordId` is an ordinary column
    // with nothing preventing a cycle. Without the cap this is not a wrong
    // answer, it is an infinite loop holding a DB connection — so the test
    // asserts the walk STOPS, which is a claim no amount of chain-shaped
    // fixtures would make on its own.
    it('terminates on a self-referencing chain rather than looping forever', async () => {
        mockDb.fileRecord.findFirst.mockImplementation(async (args: { where: { id: string } }) => ({
            id: args.where.id,
            originalName: 'loop.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1,
            sha256: 'sha-loop',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            previousFileRecordId: args.where.id, // points at itself
        }));

        const out = await getEvidenceFileVersions(makeRequestContext('READER'), 'e1');

        // MAX_FILE_VERSION_CHAIN = 50. Asserting the exact cap rather than
        // "some bound" — a cap raised to 5000 would still terminate and would
        // still be a 5000-query request.
        expect(out.versions).toHaveLength(50);
        expect(mockDb.fileRecord.findFirst).toHaveBeenCalledTimes(50);
    });

    it('caps a long legitimate chain at the same bound', async () => {
        // The head must be the NEWEST link, or the walk starts partway down
        // the chain and the cap is never reached — which is what my first
        // version of this test did, leaving the default `f3` head against an
        // 80-link fixture and asserting 50 against a walk of 3.
        const ids = Array.from({ length: 80 }, (_, i) => `f${80 - i}`);
        mockDb.evidence.findFirst.mockResolvedValue({ fileRecordId: ids[0], fileVersion: 80 });
        chain(ids);

        const out = await getEvidenceFileVersions(makeRequestContext('READER'), 'e1');

        expect(out.versions).toHaveLength(50);
        // Truncation takes the NEWEST 50 — the oldest are the ones dropped,
        // which is the right end to lose.
        expect(out.versions[0]).toMatchObject({ id: 'f80', version: 80, isCurrent: true });
        expect(out.versions[49]).toMatchObject({ id: 'f31', version: 31 });
    });
});
