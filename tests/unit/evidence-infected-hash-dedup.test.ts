/**
 * A quarantined SHA-256 stays poisoned — the same malware cannot re-enter as a
 * fresh PENDING row.
 *
 * The AV webhook quarantines by moving `scanStatus` to INFECTED and `status`
 * to FAILED in ONE conditional write (that atomicity is itself pinned by
 * `tests/unit/av-webhook-quarantine-atomicity.test.ts`, and nothing here may
 * weaken it). The dedup lookup, however, matched `status: 'STORED'` only — so
 * the moment a file was quarantined its hash dropped straight OUT of the dedup
 * index. Re-uploading the identical bytes then found nothing, took the
 * "create a new FileRecord" branch, and landed a brand-new PENDING row: the
 * same bytes the scanner had already condemned, now with no verdict attached
 * to them at all, and servable under `permissive` mode.
 *
 * The upload-time scan does not close this. It reports what the engine knows
 * at that instant; the whole reason the webhook exists is that a verdict can
 * arrive later, and a verdict that arrives later has to survive the next
 * upload of the same bytes.
 *
 * These tests drive the REAL `uploadEvidenceFile` and the REAL
 * `FileRepository.findBySha256` against an in-memory FileRecord table whose
 * `findFirst` honours whatever `where` the repository actually sends. A lookup
 * that still filters on STORED alone therefore returns null here, exactly as
 * it would against Postgres — so the assertions below fail against the
 * unwidened lookup rather than restating it.
 */
import { makeRequestContext } from '../helpers/make-context';

const SHA = 'a'.repeat(64);
const PATH_KEY = 'tenant-1/evidence/report.pdf';

interface Row {
    id: string;
    tenantId: string;
    sha256: string;
    status: string;
    scanStatus: string;
    pathKey: string;
}

let table: Row[] = [];
let nextId = 0;

/**
 * Minimal Prisma `where` evaluator — equality on the scalar columns this path
 * filters by, plus `OR`. Deliberately generic: the point is that the fake
 * answers the query the repository sends, so a lookup that never asks about
 * `scanStatus` cannot accidentally be handed an infected row.
 */
function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') {
            return (value as Array<Record<string, unknown>>).some((clause) => matches(row, clause));
        }
        return (row as unknown as Record<string, unknown>)[key] === value;
    });
}

const storageDelete = jest.fn(async () => undefined);
const storageWrite = jest.fn(async () => ({ sha256: SHA, sizeBytes: 10, pathKey: PATH_KEY }));
const scanUploadOrRefuseMock = jest.fn(async () => undefined);
const logEventMock = jest.fn(async () => undefined);

const mockDb = {
    fileRecord: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            return table.find((r) => matches(r, where)) ?? null;
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            // Partial, then assert. A create payload carries an arbitrary
            // subset, so typing the spread as a whole Row tells tsc the id and
            // scanStatus above are always overwritten (TS2783) — which is the
            // opposite of what this fake means them to be.
            const row = {
                id: `fr-new-${++nextId}`,
                scanStatus: 'PENDING',
                ...(data as unknown as Partial<Row>),
            } as Row;
            table.push(row);
            return row;
        }),
        update: jest.fn(
            async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const row = table.find((r) => r.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            },
        ),
    },
    tenantMembership: { findFirst: jest.fn(async () => ({ id: 'm-1' })) },
    evidenceRiskLink: { create: jest.fn() },
    evidenceAssetLink: { create: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getStorageProvider: () => ({
        name: 'local',
        write: (...a: unknown[]) => storageWrite(...(a as [])),
        delete: (...a: unknown[]) => storageDelete(...(a as [])),
    }),
    buildTenantObjectKey: () => PATH_KEY,
    assertTenantKey: () => undefined,
    isAllowedMime: () => true,
    isAllowedSize: () => true,
    FILE_MAX_SIZE_BYTES: 100_000_000,
}));

jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    isDownloadAllowed: () => true,
    getBlockedReason: () => null,
}));

jest.mock('@/app-layer/services/file-scan', () => ({
    __esModule: true,
    scanUploadOrRefuse: (...a: unknown[]) => scanUploadOrRefuseMock(...(a as [])),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    __esModule: true,
    EvidenceRepository: {
        filterExistingControlIds: jest.fn(async () => new Set<string>()),
        create: jest.fn(async () => ({ id: 'ev-1', title: 'report.pdf' })),
        createControlLinks: jest.fn(async () => undefined),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: (...a: unknown[]) => logEventMock(...(a as [])),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    __esModule: true,
    cachedListRead: jest.fn(),
    bumpEntityCacheVersion: jest.fn(async () => undefined),
}));

import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { FileRepository } from '@/app-layer/repositories/FileRepository';

const ctx = makeRequestContext('ADMIN', { userId: 'user-1', tenantId: 'tenant-1' });

const file = {
    name: 'report.pdf',
    type: 'application/pdf',
    size: 10,
    arrayBuffer: async () => new ArrayBuffer(10),
} as unknown as File;

function quarantinedRow(): Row {
    // Exactly what the AV webhook's single atomic write leaves behind.
    return {
        id: 'fr-infected',
        tenantId: 'tenant-1',
        sha256: SHA,
        status: 'FAILED',
        scanStatus: 'INFECTED',
        pathKey: 'tenant-1/evidence/original.pdf',
    };
}

function storedRow(): Row {
    return {
        id: 'fr-clean',
        tenantId: 'tenant-1',
        sha256: SHA,
        status: 'STORED',
        scanStatus: 'CLEAN',
        pathKey: 'tenant-1/evidence/clean.pdf',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    table = [];
    nextId = 0;
    storageWrite.mockResolvedValue({ sha256: SHA, sizeBytes: 10, pathKey: PATH_KEY });
    scanUploadOrRefuseMock.mockResolvedValue(undefined);
});

describe('FileRepository.findBySha256 — the dedup index sees quarantined rows', () => {
    it('returns the quarantined row even though its status is FAILED', async () => {
        table = [quarantinedRow()];

        const found = await FileRepository.findBySha256(mockDb as never, 'tenant-1', SHA);

        expect(found).not.toBeNull();
        expect(found).toMatchObject({
            id: 'fr-infected',
            scanStatus: 'INFECTED',
            status: 'FAILED',
        });
    });

    it('prefers the infected row when a clean STORED row shares the hash', async () => {
        // Same bytes stored before the signature that catches them shipped.
        // Whichever row `findFirst` would have reached first, the verdict has
        // to win — otherwise the poison is decided by row order.
        table = [storedRow(), quarantinedRow()];

        const found = await FileRepository.findBySha256(mockDb as never, 'tenant-1', SHA);

        expect(found).toMatchObject({ scanStatus: 'INFECTED' });
    });

    it('still resolves the canonical STORED row when nothing is quarantined', async () => {
        table = [storedRow()];

        const found = await FileRepository.findBySha256(mockDb as never, 'tenant-1', SHA);

        expect(found).toMatchObject({ id: 'fr-clean', status: 'STORED' });
    });

    it('does not match another tenant’s quarantined row', async () => {
        table = [{ ...quarantinedRow(), tenantId: 'tenant-2' }];

        expect(await FileRepository.findBySha256(mockDb as never, 'tenant-1', SHA)).toBeNull();
    });
});

describe('uploadEvidenceFile — known-infected bytes are refused, not re-admitted', () => {
    it('refuses the re-upload instead of creating a fresh PENDING FileRecord', async () => {
        table = [quarantinedRow()];

        // The same refusal shape `scanUploadOrRefuse` throws for a live
        // INFECTED verdict — one error for the caller to handle, whether the
        // verdict arrived just now or arrived last week.
        await expect(uploadEvidenceFile(ctx, file, {})).rejects.toMatchObject({
            message: 'FILE_INFECTED',
            status: 400,
        });

        // The actual regression: without the fix this call HAPPENS, and the
        // new row lands at status PENDING / scanStatus PENDING.
        expect(mockDb.fileRecord.create).not.toHaveBeenCalled();
        expect(table).toHaveLength(1);
        expect(table[0].id).toBe('fr-infected');
    });

    it('drops the just-written copy of the known-malicious bytes', async () => {
        table = [quarantinedRow()];

        await expect(uploadEvidenceFile(ctx, file, {})).rejects.toThrow();

        expect(storageDelete).toHaveBeenCalledWith(PATH_KEY);
    });

    it('records the refusal as a FILE_QUARANTINED audit event', async () => {
        table = [quarantinedRow()];

        await expect(uploadEvidenceFile(ctx, file, {})).rejects.toThrow();

        expect(logEventMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'FILE_QUARANTINED',
                entityType: 'FileRecord',
                entityId: 'fr-infected',
            }),
        );
    });

    it('still de-duplicates onto a clean STORED row (no regression)', async () => {
        table = [storedRow()];

        const result = await uploadEvidenceFile(ctx, file, {});

        expect(mockDb.fileRecord.create).not.toHaveBeenCalled();
        expect(result.fileRecord).toMatchObject({ id: 'fr-clean', deduplicated: true });
    });

    it('still creates a FileRecord for bytes nobody has seen (no regression)', async () => {
        table = [];

        const result = await uploadEvidenceFile(ctx, file, {});

        expect(mockDb.fileRecord.create).toHaveBeenCalledTimes(1);
        expect(result.fileRecord).toMatchObject({ deduplicated: false });
        expect(table[0]).toMatchObject({ status: 'STORED', sha256: SHA });
    });
});
