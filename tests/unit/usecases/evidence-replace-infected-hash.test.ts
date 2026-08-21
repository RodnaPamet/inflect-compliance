/**
 * A quarantined SHA-256 stays poisoned on the REPLACE path too.
 *
 * #118 closed this for `uploadEvidenceFile`: `findBySha256` was widened to see
 * INFECTED rows, and a refusal gate in front of the dedup arm throws
 * `badRequest('FILE_INFECTED')` for bytes the scanner has already condemned.
 * The whole point of that gate is that a verdict can arrive LATER — the AV
 * webhook exists for exactly that — so a verdict has to survive the next
 * arrival of the same bytes.
 *
 * `replaceEvidenceFile` accepts bytes from the same user, over an evidence row
 * that may already be APPROVED, and had NO sha256 lookup at all. It went
 * straight to `createPending` + `markStored`, so the identical malware that
 * upload refuses walked in through replace as a fresh row carrying only
 * whatever the live scan happened to say at that instant — and under
 * `permissive` mode that row is downloadable.
 *
 * These tests drive the REAL `replaceEvidenceFile` and the REAL
 * `FileRepository.findBySha256` against an in-memory FileRecord table whose
 * `findFirst` honours whatever `where` the repository actually sends, so a
 * path that never asks about the hash cannot be handed an infected row.
 */
import { makeRequestContext } from '../../helpers/make-context';

const SHA = 'b'.repeat(64);
const PATH_KEY = 'tenant-1/evidence/updated.pdf';

interface Row {
    id: string;
    tenantId: string;
    sha256: string;
    status: string;
    scanStatus: string;
    pathKey: string;
    previousFileRecordId?: string | null;
}

interface EvidenceRow {
    id: string;
    tenantId: string;
    type: string;
    status: string;
    deletedAt: Date | null;
    fileRecordId: string | null;
    fileVersion: number;
    title: string;
    fileName?: string;
    content?: string;
}

let table: Row[] = [];
let evidenceTable: EvidenceRow[] = [];
let nextId = 0;

/** Minimal Prisma `where` evaluator — equality on scalars, plus `OR`. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') {
            return (value as Array<Record<string, unknown>>).some((clause) => matches(row, clause));
        }
        return row[key] === value;
    });
}

const storageDelete = jest.fn(async (_key?: unknown) => undefined);
const storageWrite = jest.fn(async (..._a: unknown[]) => ({
    sha256: SHA,
    sizeBytes: 10,
    pathKey: PATH_KEY,
}));
const scanUploadOrRefuseMock = jest.fn(async (..._a: unknown[]) => undefined as unknown);
const logEventMock = jest.fn(async (..._a: unknown[]) => undefined);

const mockDb = {
    fileRecord: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            // Copy on read, as Prisma does. Handing back the live object would
            // let a later `update` mutate a snapshot the usecase is still
            // holding, and the fixture would then agree with itself.
            const row = table.find((r) => matches(r as unknown as Record<string, unknown>, where));
            return row ? { ...row } : null;
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            // Partial-then-assert, as in the upload-path fixture: a create
            // payload carries an arbitrary subset, and typing the spread as a
            // whole Row would tell tsc the defaults above are always
            // overwritten (TS2783).
            const row = {
                id: `fr-new-${++nextId}`,
                scanStatus: 'PENDING',
                previousFileRecordId: null,
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
    evidence: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            const row = evidenceTable.find((r) =>
                matches(r as unknown as Record<string, unknown>, where),
            );
            return row ? { ...row } : null;
        }),
        update: jest.fn(
            async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const row = evidenceTable.find((r) => r.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            },
        ),
    },
};

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getStorageProvider: () => ({
        name: 'local',
        write: (...a: unknown[]) => storageWrite(...a),
        delete: (...a: unknown[]) => storageDelete(...a),
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
    scanUploadOrRefuse: (...a: unknown[]) => scanUploadOrRefuseMock(...a),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    __esModule: true,
    EvidenceRepository: {
        filterExistingControlIds: jest.fn(async () => new Set<string>()),
        create: jest.fn(async () => ({ id: 'ev-1', title: 'updated.pdf' })),
        createControlLinks: jest.fn(async () => undefined),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    __esModule: true,
    cachedListRead: jest.fn(),
    bumpEntityCacheVersion: jest.fn(async () => undefined),
}));

import { replaceEvidenceFile } from '@/app-layer/usecases/evidence';

const ctx = makeRequestContext('ADMIN', { userId: 'user-1', tenantId: 'tenant-1' });

const file = {
    name: 'updated.pdf',
    type: 'application/pdf',
    size: 10,
    arrayBuffer: async () => new ArrayBuffer(10),
} as unknown as File;

/** Exactly what the AV webhook's single atomic quarantine write leaves behind. */
function quarantinedRow(): Row {
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

/** The evidence row's CURRENT file — a different hash from the replacement. */
function headRow(): Row {
    return {
        id: 'fr-head',
        tenantId: 'tenant-1',
        sha256: 'c'.repeat(64),
        status: 'STORED',
        scanStatus: 'CLEAN',
        pathKey: 'tenant-1/evidence/head.pdf',
    };
}

function evidenceRow(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
    return {
        id: 'ev-1',
        tenantId: 'tenant-1',
        type: 'FILE',
        status: 'APPROVED',
        deletedAt: null,
        fileRecordId: 'fr-head',
        fileVersion: 1,
        title: 'Quarterly report',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    table = [];
    evidenceTable = [];
    nextId = 0;
    storageWrite.mockResolvedValue({ sha256: SHA, sizeBytes: 10, pathKey: PATH_KEY });
    scanUploadOrRefuseMock.mockResolvedValue(undefined);
});

describe('replaceEvidenceFile — known-infected bytes are refused, not re-admitted', () => {
    it('refuses the replacement instead of creating a fresh FileRecord', async () => {
        table = [headRow(), quarantinedRow()];
        evidenceTable = [evidenceRow()];

        // The same refusal shape the upload path throws — one error for the
        // caller to handle, whether the verdict arrived just now or last week.
        await expect(replaceEvidenceFile(ctx, 'ev-1', file)).rejects.toMatchObject({
            message: 'FILE_INFECTED',
            status: 400,
        });

        // The actual regression: without the gate this call HAPPENS and the
        // condemned bytes land as a brand-new row.
        expect(mockDb.fileRecord.create).not.toHaveBeenCalled();
        expect(table.map((r) => r.id)).toEqual(['fr-head', 'fr-infected']);
    });

    it('leaves the evidence row pointing at its previous version', async () => {
        table = [headRow(), quarantinedRow()];
        evidenceTable = [evidenceRow()];

        await expect(replaceEvidenceFile(ctx, 'ev-1', file)).rejects.toThrow('FILE_INFECTED');

        // Positive assertion beside the negative: the lookup DID run (so the
        // usecase reached the decision) and the head is untouched.
        expect(mockDb.evidence.findFirst).toHaveBeenCalled();
        expect(mockDb.evidence.update).not.toHaveBeenCalled();
        expect(evidenceTable[0]).toMatchObject({ fileRecordId: 'fr-head', fileVersion: 1 });
    });

    it('drops the just-written copy of the known-malicious bytes', async () => {
        table = [headRow(), quarantinedRow()];
        evidenceTable = [evidenceRow()];

        await expect(replaceEvidenceFile(ctx, 'ev-1', file)).rejects.toThrow('FILE_INFECTED');

        expect(storageWrite).toHaveBeenCalled();
        expect(storageDelete).toHaveBeenCalledWith(PATH_KEY);
    });

    it('records the refusal with the same action + disposition as the upload gate', async () => {
        table = [headRow(), quarantinedRow()];
        evidenceTable = [evidenceRow()];

        await expect(replaceEvidenceFile(ctx, 'ev-1', file)).rejects.toThrow('FILE_INFECTED');

        // One SIEM rule has to catch every disposition of the same threat, so
        // the action string and the disposition are shared with the upload
        // path verbatim.
        expect(logEventMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'FILE_QUARANTINED',
                entityType: 'FileRecord',
                entityId: 'fr-infected',
                detailsJson: expect.objectContaining({
                    disposition: 'refused_known_infected_hash',
                    sha256: SHA,
                }),
            }),
        );
    });
});

describe('replaceEvidenceFile — the ordinary paths are unchanged', () => {
    it('replaces with bytes nobody has seen and chains the lineage', async () => {
        table = [headRow()];
        evidenceTable = [evidenceRow()];

        const result = await replaceEvidenceFile(ctx, 'ev-1', file);

        expect(mockDb.fileRecord.create).toHaveBeenCalledTimes(1);
        expect(result.fileRecord).toMatchObject({
            sha256: SHA,
            status: 'STORED',
            previousFileRecordId: 'fr-head',
        });
        expect(table[1]).toMatchObject({ previousFileRecordId: 'fr-head', status: 'STORED' });
        expect(evidenceTable[0]).toMatchObject({ fileVersion: 2, status: 'SUBMITTED' });
    });

    it('still allows a replacement whose bytes are a CLEAN stored file', async () => {
        // A hash that exists and is clean is not a refusal — replace needs its
        // own FileRecord for the version chain, so it creates one rather than
        // de-duplicating onto the canonical row.
        table = [headRow(), storedRow()];
        evidenceTable = [evidenceRow({ status: 'DRAFT' })];

        const result = await replaceEvidenceFile(ctx, 'ev-1', file);

        expect(result.fileRecord).toMatchObject({ status: 'STORED' });
        expect(mockDb.fileRecord.create).toHaveBeenCalledTimes(1);
        expect(evidenceTable[0]).toMatchObject({ fileVersion: 2, status: 'DRAFT' });
        expect(logEventMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'EVIDENCE_FILE_REPLACED' }),
        );
    });

    it('does not refuse on another tenant’s quarantined copy of the same hash', async () => {
        table = [headRow(), { ...quarantinedRow(), tenantId: 'tenant-2' }];
        evidenceTable = [evidenceRow({ status: 'DRAFT' })];

        const result = await replaceEvidenceFile(ctx, 'ev-1', file);

        expect(result.fileRecord).toMatchObject({ status: 'STORED' });
        expect(mockDb.fileRecord.create).toHaveBeenCalledTimes(1);
    });
});
