/**
 * `scanUploadOrRefuse` — the half of the AV control that never existed.
 *
 * `isDownloadAllowed` has always gated every serving path correctly, but
 * NOTHING called `scanBuffer` / `scanStream` / `triggerAsyncScan`, so every
 * FileRecord sat at its `scanStatus: 'PENDING'` default forever. Production
 * ran a ClamAV container, idle, next to a table reading 4 PENDING / 2 SKIPPED
 * / 0 CLEAN. The gate was wired; the scan was not.
 *
 * These pin the OUTCOME MAPPING, which is where the judgement lives — what a
 * failed scan, a disabled scanner and an oversized file each persist. Getting
 * any of those wrong is worse than not scanning: writing a synthetic CLEAN for
 * an unscanned file marks it servable forever, including after a later switch
 * to strict mode.
 */
import { scanUploadOrRefuse, AV_SCAN_MAX_BYTES } from '@/app-layer/services/file-scan';

const scanBufferMock = jest.fn();
const logEventMock = jest.fn();

jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    scanBuffer: (...a: unknown[]) => scanBufferMock(...a),
}));

jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    role: 'ADMIN',
    requestId: 'r1',
    permissions: {},
    appPermissions: {},
} as never;

const meta = { originalName: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 10 };
const buf = Buffer.from('hello');

beforeEach(() => {
    jest.clearAllMocks();
    process.env.AV_SCAN_MODE = 'strict';
});

describe('scanUploadOrRefuse — outcome mapping', () => {
    it('returns a CLEAN verdict to persist when the scanner says clean', async () => {
        scanBufferMock.mockResolvedValue({ status: 'CLEAN', engine: 'clamav', durationMs: 12 });

        const out = await scanUploadOrRefuse(ctx, buf, meta);

        expect(out?.scanStatus).toBe('CLEAN');
        expect(out?.scannedAt).toBeInstanceOf(Date);
        // The details carry provenance so a row can be traced to the engine
        // and path that cleared it.
        expect(JSON.parse(out!.scanDetails)).toMatchObject({
            engine: 'clamav',
            source: 'inline-upload',
        });
    });

    it('REFUSES an infected upload and audits it first', async () => {
        scanBufferMock.mockResolvedValue({
            status: 'INFECTED', threat: 'Eicar-Test', engine: 'clamav', durationMs: 5,
        });

        await expect(scanUploadOrRefuse(ctx, buf, meta)).rejects.toThrow(/FILE_INFECTED|malware/i);

        // The refusal is the security event and the only record the file was
        // ever offered — the bytes are never written.
        expect(logEventMock).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({
                action: 'FILE_QUARANTINED',
                detailsJson: expect.objectContaining({ threat: 'Eicar-Test' }),
            }),
        );
    });

    it('leaves the row PENDING when the scan ERRORS — an upload must not depend on clamd being up', async () => {
        scanBufferMock.mockResolvedValue({
            status: 'ERROR', engine: 'clamav', durationMs: 30_000, rawOutput: 'scan timed out',
        });

        await expect(scanUploadOrRefuse(ctx, buf, meta)).resolves.toBeUndefined();
    });

    it('does NOT call the scanner in disabled mode, and persists nothing', async () => {
        // scanBuffer synthesises `CLEAN / engine: 'disabled'` in this mode.
        // Persisting that would mark an unscanned file permanently servable —
        // including after a later switch to strict. PENDING is the honest
        // record, and it is servable anyway while disabled.
        process.env.AV_SCAN_MODE = 'disabled';

        await expect(scanUploadOrRefuse(ctx, buf, meta)).resolves.toBeUndefined();
        expect(scanBufferMock).not.toHaveBeenCalled();
    });

    it('skips a buffer above the scan cap without calling the scanner', async () => {
        // clamd aborts past its StreamMaxLength, so the round trip would end
        // at the same PENDING state after transferring the whole file.
        const big = Buffer.alloc(AV_SCAN_MAX_BYTES + 1);

        await expect(scanUploadOrRefuse(ctx, big, { ...meta, sizeBytes: big.length })).resolves.toBeUndefined();
        expect(scanBufferMock).not.toHaveBeenCalled();
    });

    it('never persists a verdict from the disabled engine even if it reaches the mapping', async () => {
        // Defence in depth: the disabled branch returns earlier, but if the
        // mode check were ever removed this must still refuse to write CLEAN.
        scanBufferMock.mockResolvedValue({ status: 'CLEAN', engine: 'disabled', durationMs: 0 });

        await expect(scanUploadOrRefuse(ctx, buf, meta)).resolves.toBeUndefined();
    });
});
