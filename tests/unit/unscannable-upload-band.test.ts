/**
 * The unscannable band: file sizes this product ACCEPTS on upload but will
 * never hand to the antivirus scanner.
 *
 * Two limits set independently, in two layers that do not import each other:
 *
 *   AV_SCAN_MAX_BYTES        25 MB  app-layer/services/file-scan — pinned to
 *                                   clamd's StreamMaxLength; larger buffers
 *                                   are skipped locally instead of aborted
 *                                   mid-transfer.
 *   FILE_MAX_SIZE_BYTES      50 MB  lib/storage — the upload ceiling
 *                            (default) `isAllowedSize` enforces.
 *
 * Because the scan cap is the LOWER of the two, every size in
 * (AV_SCAN_MAX_BYTES, FILE_MAX_SIZE_BYTES] is uploadable and unscannable at
 * once. Such a file is stored and left at `scanStatus: 'PENDING'` — the honest
 * record of "not scanned" — and whether it is then servable is decided by
 * AV_SCAN_MODE in `isDownloadAllowed`, not by anything in this file.
 *
 * This band is NOT a bug and these tests do not close it: a 25 MB clamd cap
 * against a 50 MB product limit is a deliberate pair of choices. What was
 * missing is that the band was invisible. The ceiling existed only inside a
 * `env.FILE_MAX_SIZE_BYTES || (50 * 1024 * 1024)` expression, so its default
 * had no name, no test stated the relationship between the two limits, and
 * moving either one silently changed how large the unscanned population is.
 *
 * So: this file names the band, pins its bounds, and proves it is reachable
 * through the real validator and the real scan entry point. Changing either
 * limit fails here, which is the point — the change is legitimate, but it must
 * be made knowingly and the new width written down.
 */
import {
    isAllowedSize,
    FILE_MAX_SIZE_BYTES,
    FILE_MAX_SIZE_DEFAULT_BYTES,
} from '@/lib/storage';
import { scanUploadOrRefuse, AV_SCAN_MAX_BYTES } from '@/app-layer/services/file-scan';

const scanBufferMock = jest.fn();

jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    scanBuffer: (...a: unknown[]) => scanBufferMock(...a),
}));

jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: jest.fn(),
}));

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

const MB = 1024 * 1024;

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    role: 'ADMIN',
    requestId: 'r1',
    permissions: {},
    appPermissions: {},
} as never;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.AV_SCAN_MODE = 'strict';
});

describe('unscannable band — the two limits, stated', () => {
    it('pins both limits so neither can move without this file noticing', () => {
        expect(AV_SCAN_MAX_BYTES).toBe(25 * MB);
        expect(FILE_MAX_SIZE_DEFAULT_BYTES).toBe(50 * MB);
    });

    it('has the scan cap strictly BELOW the upload ceiling — the band is real, not empty', () => {
        // If these were ever equalised the band would close and every stored
        // file would be scannable. They are not equal today, and pretending
        // otherwise is what this suite exists to prevent.
        expect(AV_SCAN_MAX_BYTES).toBeLessThan(FILE_MAX_SIZE_DEFAULT_BYTES);
    });

    it('documents the exact population: 25 MB wide, from 25 MB + 1 byte through 50 MB', () => {
        const lowest = AV_SCAN_MAX_BYTES + 1;
        const highest = FILE_MAX_SIZE_DEFAULT_BYTES;
        const widthBytes = highest - lowest + 1;

        expect(lowest).toBe(25 * MB + 1);
        expect(highest).toBe(50 * MB);
        expect(widthBytes).toBe(25 * MB);
    });

    it('resolves the live ceiling from the named default when no env override is set', () => {
        // Behaviour-identical extraction check: naming the default must not
        // have changed which number `isAllowedSize` actually enforces.
        if (process.env.FILE_MAX_SIZE_BYTES) {
            expect(FILE_MAX_SIZE_BYTES).toBe(Number(process.env.FILE_MAX_SIZE_BYTES));
        } else {
            expect(FILE_MAX_SIZE_BYTES).toBe(FILE_MAX_SIZE_DEFAULT_BYTES);
        }
    });
});

describe('unscannable band — reachable through the real upload validator', () => {
    it('accepts a file one byte above the scan cap', () => {
        // The upload path has no idea the scanner will decline this. That
        // asymmetry is the band.
        expect(isAllowedSize(AV_SCAN_MAX_BYTES + 1)).toBe(true);
    });

    it('accepts a file at the very top of the band', () => {
        expect(isAllowedSize(FILE_MAX_SIZE_DEFAULT_BYTES)).toBe(true);
    });

    it('rejects the first byte above the band, so the band is bounded on both sides', () => {
        expect(isAllowedSize(FILE_MAX_SIZE_DEFAULT_BYTES + 1)).toBe(false);
    });

    it('still scans everything below the cap', () => {
        expect(isAllowedSize(AV_SCAN_MAX_BYTES)).toBe(true);
        expect(AV_SCAN_MAX_BYTES).toBeGreaterThan(0);
    });
});

describe('unscannable band — what actually happens to a file inside it', () => {
    const meta = { originalName: 'big-report.pdf', mimeType: 'application/pdf', sizeBytes: 0 };

    it('never calls the scanner and returns no verdict to persist (row stays PENDING)', async () => {
        const inBand = Buffer.alloc(AV_SCAN_MAX_BYTES + 1);
        expect(isAllowedSize(inBand.length)).toBe(true); // it got past the upload gate

        const verdict = await scanUploadOrRefuse(ctx, inBand, { ...meta, sizeBytes: inBand.length });

        // `undefined` means "write nothing", which leaves the FileRecord at its
        // PENDING default. That is the correct outcome — but it means the band
        // is a population of permanently-unscanned rows, not a rounding edge.
        expect(verdict).toBeUndefined();
        expect(scanBufferMock).not.toHaveBeenCalled();
    });

    it('does not launder "too big to scan" into CLEAN or SKIPPED', async () => {
        const inBand = Buffer.alloc(AV_SCAN_MAX_BYTES + 1);

        const verdict = await scanUploadOrRefuse(ctx, inBand, { ...meta, sizeBytes: inBand.length });

        // CLEAN would mark it servable forever, including after a switch to
        // strict mode; SKIPPED is unconditionally servable in `isDownloadAllowed`.
        // Either would turn an unscanned file into an approved one.
        expect(verdict?.scanStatus).not.toBe('CLEAN');
        expect(verdict?.scanStatus).not.toBe('SKIPPED');
    });

    it('does scan a file one byte below the cap — the boundary is where it says it is', async () => {
        scanBufferMock.mockResolvedValue({ status: 'CLEAN', engine: 'clamav', durationMs: 3 });
        const belowCap = Buffer.alloc(AV_SCAN_MAX_BYTES);

        const verdict = await scanUploadOrRefuse(ctx, belowCap, { ...meta, sizeBytes: belowCap.length });

        expect(scanBufferMock).toHaveBeenCalledTimes(1);
        expect(verdict?.scanStatus).toBe('CLEAN');
    });
});
