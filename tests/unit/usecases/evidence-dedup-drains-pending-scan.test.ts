/**
 * Issue #117 — a SHA-256 dedup hit must not throw away the fresh CLEAN
 * verdict it just computed.
 *
 * `uploadEvidenceFile` scans the bytes BEFORE they reach storage. On the
 * non-dedup arm that verdict is persisted through `FileRepository.markStored`.
 * On the dedup arm the new bytes are discarded and an existing FileRecord is
 * reused — and the verdict was discarded with them. So a canonical row that
 * had been left at `PENDING` (clamd was down when it was first uploaded, or it
 * predates inline scanning) stayed PENDING forever, even though we had just
 * proved those exact bytes are clean. That is the PENDING backlog that blocks
 * evidence preview.
 *
 * The fix drains the PENDING state with a CONDITIONAL write. These tests run
 * the usecase against an in-memory `fileRecord.updateMany` that actually
 * applies the `where` predicate, so they assert CONDUCT:
 *   - a PENDING canonical row is promoted to CLEAN,
 *   - an INFECTED row is left exactly as it is (since #118, by being
 *     refused at the gate before the dedup arm runs — see that case),
 *   - an already-CLEAN row is not restamped,
 *   - no verdict (scanner down / disabled) writes nothing at all.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        create: jest.fn(),
        createControlLinks: jest.fn().mockResolvedValue(undefined),
        filterExistingControlIds: jest.fn(
            async (_db: unknown, _ctx: unknown, ids: string[]) => new Set(ids),
        ),
    },
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        findBySha256: jest.fn(),
        createPending: jest.fn(),
        markStored: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('@/app-layer/services/file-scan', () => ({
    scanUploadOrRefuse: jest.fn(),
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(),
    buildTenantObjectKey: jest.fn(
        (tenantId: string, domain: string, name: string) => `${tenantId}/${domain}/${name}`,
    ),
    assertTenantKey: jest.fn(),
    isAllowedMime: jest.fn(() => true),
    isAllowedSize: jest.fn(() => true),
    FILE_MAX_SIZE_BYTES: 100 * 1024 * 1024,
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(),
    bumpEntityCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { runInTenantContext } from '@/lib/db-context';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { scanUploadOrRefuse } from '@/app-layer/services/file-scan';
import { getStorageProvider } from '@/lib/storage';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockFindBySha = FileRepository.findBySha256 as jest.Mock;
const mockCreatePending = FileRepository.createPending as jest.Mock;
const mockMarkStored = FileRepository.markStored as jest.Mock;
const mockScan = scanUploadOrRefuse as jest.MockedFunction<typeof scanUploadOrRefuse>;
const mockGetStorage = getStorageProvider as jest.Mock;

const TENANT = 'tenant-A';
const SHA = 'a'.repeat(64);

/** The canonical row the dedup arm reuses. */
interface FakeFileRow {
    id: string;
    tenantId: string;
    sha256: string;
    status: string;
    scanStatus: string;
    scanDetails: string | null;
    scannedAt: Date | null;
}

/**
 * A `fileRecord` delegate whose `updateMany` really evaluates the `where`
 * predicate. A write that forgets `scanStatus: 'PENDING'` therefore CHANGES
 * the INFECTED row here, exactly as it would in Postgres.
 */
function makeDb(rows: FakeFileRow[]) {
    const updateMany = jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const matched = rows.filter((row) =>
                Object.entries(where).every(
                    ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
                ),
            );
            for (const row of matched) Object.assign(row, data);
            return { count: matched.length };
        },
    );
    return {
        rows,
        updateMany,
        db: { fileRecord: { updateMany } } as never,
    };
}

function fakeFile(): File {
    return {
        name: 'policy.pdf',
        type: 'application/pdf',
        size: 12,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as File;
}

const CLEAN_VERDICT = {
    scanStatus: 'CLEAN' as const,
    scanDetails: JSON.stringify({ engine: 'clamav', source: 'inline-upload' }),
    scannedAt: new Date('2026-08-20T10:00:00.000Z'),
};

function pendingRow(overrides: Partial<FakeFileRow> = {}): FakeFileRow {
    return {
        id: 'file-canonical',
        tenantId: TENANT,
        sha256: SHA,
        status: 'STORED',
        scanStatus: 'PENDING',
        scanDetails: null,
        scannedAt: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetStorage.mockReturnValue({
        name: 'local',
        write: jest.fn(async () => ({ sha256: SHA, sizeBytes: 12 })),
        delete: jest.fn(async () => undefined),
    });
    mockScan.mockResolvedValue(CLEAN_VERDICT);
    (EvidenceRepository.create as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'policy.pdf' });
    mockCreatePending.mockResolvedValue({ id: 'file-new' });
});

async function upload(rows: FakeFileRow[]) {
    const harness = makeDb(rows);
    mockRunInTx.mockImplementation(async (_ctx, fn) => fn(harness.db));
    await uploadEvidenceFile(
        makeRequestContext('EDITOR', { tenantId: TENANT }),
        fakeFile(),
        { title: 'policy.pdf' },
    );
    return harness;
}

describe('uploadEvidenceFile — dedup hit keeps the fresh CLEAN verdict (#117)', () => {
    it('promotes the reused PENDING FileRecord to CLEAN', async () => {
        const row = pendingRow();
        mockFindBySha.mockResolvedValue(row);

        const harness = await upload([row]);

        expect(harness.updateMany).toHaveBeenCalledTimes(1);
        expect(row.scanStatus).toBe('CLEAN');
        expect(row.scanDetails).toBe(CLEAN_VERDICT.scanDetails);
        expect(row.scannedAt).toEqual(CLEAN_VERDICT.scannedAt);
    });

    it('scopes the drain to the reused row, in this tenant, only while PENDING', async () => {
        const row = pendingRow();
        mockFindBySha.mockResolvedValue(row);

        const harness = await upload([row]);

        const [{ where }] = harness.updateMany.mock.calls[0] as [{ where: Record<string, unknown> }];
        expect(where).toMatchObject({ id: 'file-canonical', scanStatus: 'PENDING' });
        expect(where.tenantId).toBe(TENANT);
    });

    // #118 landed hours after this suite and moved this case's mechanism.
    // The dedup lookup now sees INFECTED rows, so `uploadEvidenceFile`
    // REFUSES known-infected bytes at a gate before the dedup arm runs at
    // all. The invariant is unchanged and stronger — a terminal verdict is
    // never restamped — but the drain is no longer the thing enforcing it,
    // so asserting on the drain would assert nothing. Assert the refusal,
    // and that the row survived it untouched.
    it('refuses the upload outright for an INFECTED canonical row, and leaves it untouched', async () => {
        const row = pendingRow({
            scanStatus: 'INFECTED',
            scanDetails: '{"threat":"Eicar-Test-Signature"}',
            scannedAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        mockFindBySha.mockResolvedValue(row);

        await expect(upload([row])).rejects.toThrow('FILE_INFECTED');

        expect(row.scanStatus).toBe('INFECTED');
        expect(row.scanDetails).toBe('{"threat":"Eicar-Test-Signature"}');
        expect(row.scannedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('does not restamp an already-CLEAN canonical row', async () => {
        const row = pendingRow({
            scanStatus: 'CLEAN',
            scanDetails: '{"engine":"clamav","source":"webhook"}',
            scannedAt: new Date('2026-02-02T00:00:00.000Z'),
        });
        mockFindBySha.mockResolvedValue(row);

        await upload([row]);

        expect(row.scanDetails).toBe('{"engine":"clamav","source":"webhook"}');
        expect(row.scannedAt).toEqual(new Date('2026-02-02T00:00:00.000Z'));
    });

    it('writes nothing when the scanner produced no verdict', async () => {
        // AV_SCAN_MODE=disabled, clamd unreachable, or an oversize buffer:
        // `undefined` means "not scanned". Persisting CLEAN from that would
        // mark an unscanned file clean forever.
        mockScan.mockResolvedValue(undefined);
        const row = pendingRow();
        mockFindBySha.mockResolvedValue(row);

        const harness = await upload([row]);

        expect(harness.updateMany).not.toHaveBeenCalled();
        expect(row.scanStatus).toBe('PENDING');
    });

    it('does not touch fileRecord.updateMany on the non-dedup arm', async () => {
        // A fresh upload persists its verdict through markStored — the drain
        // is dedup-only and must not double-write.
        mockFindBySha.mockResolvedValue(null);

        const harness = await upload([]);

        expect(harness.updateMany).not.toHaveBeenCalled();
        expect(mockMarkStored).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'file-new',
            CLEAN_VERDICT,
        );
    });
});
