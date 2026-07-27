/**
 * Unit tests for src/app-layer/usecases/file.ts
 *
 * File download is the surface where the storage abstraction meets tenant
 * isolation — a regression here is a direct cross-tenant exfiltration vector.
 *
 * R5-P1 #1 — downloadFile no longer trusts the caller-writable
 * `Evidence.content` (via the removed `isFileOwnedByTenant`). It now:
 *   1. assertCanRead gate (no anonymous downloads).
 *   2. assertTenantKey(fileName) BEFORE any DB/storage call — a cross-tenant
 *      pathKey is rejected at the door.
 *   3. resolves ownership through the tenant-scoped FileRecord (null → notFound).
 *   4. gates on the shared isDownloadAllowed predicate (INFECTED/PENDING-strict).
 *   5. dual-reads by the record's own storageProvider (S3 redirect / local stream)
 *      and returns the record's own mimeType + originalName.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) => fn({} as never)),
}));

jest.mock('@/lib/storage', () => ({
    assertTenantKey: jest.fn(),
}));

const mockGetProviderByName = jest.fn();
jest.mock('@/lib/storage/index', () => ({
    getProviderByName: (...args: unknown[]) => mockGetProviderByName(...args),
}));

jest.mock('@/lib/storage/av-scan', () => ({
    isDownloadAllowed: jest.fn(() => true),
    getBlockedReason: jest.fn(() => 'blocked'),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { downloadFile } from '@/app-layer/usecases/file';
import { runInTenantContext } from '@/lib/db-context';
import { assertTenantKey } from '@/lib/storage';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockAssertKey = assertTenantKey as jest.MockedFunction<typeof assertTenantKey>;
const mockIsAllowed = isDownloadAllowed as jest.MockedFunction<typeof isDownloadAllowed>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

/** Build a fake tenant db whose fileRecord.findFirst returns `record`. */
function dbReturning(record: unknown) {
    return { fileRecord: { findFirst: jest.fn().mockResolvedValue(record) } };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async (_ctx, fn) => fn({} as never));
    mockIsAllowed.mockReturnValue(true);
    // clearAllMocks resets call data but NOT implementations — reset the
    // tenant-key guard to a no-op so a throwing test doesn't bleed forward.
    mockAssertKey.mockImplementation(() => undefined);
});

describe('downloadFile — gate ordering', () => {
    it('rejects when canRead is missing — short of any storage call', async () => {
        const ctx = { ...makeRequestContext('READER'), permissions: {
            canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false,
        } } as never;

        await expect(downloadFile(ctx, 'tenants/tenant-1/file.pdf')).rejects.toThrow();
        expect(mockAssertKey).not.toHaveBeenCalled();
    });

    it('asserts the pathKey belongs to the tenant BEFORE any DB/storage read', async () => {
        // A cross-tenant key throws at assertTenantKey — the old ownership check
        // (which trusted Evidence.content) is gone; the tenant-key prefix is the
        // door. Regression proof: no FileRecord lookup happens.
        mockAssertKey.mockImplementationOnce(() => { throw new Error('Tenant isolation violation'); });

        await expect(
            downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-B/secret.pdf'),
        ).rejects.toThrow(/isolation/);
        expect(mockRunInTx).not.toHaveBeenCalled();
        expect(mockGetProviderByName).not.toHaveBeenCalled();
    });

    it('404s when no FileRecord matches the key in this tenant', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(dbReturning(null) as never));
        await expect(
            downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-1/ghost.pdf'),
        ).rejects.toThrow(/File not found/);
        expect(mockGetProviderByName).not.toHaveBeenCalled();
    });

    it('blocks when the shared AV predicate denies the file', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(dbReturning({
            pathKey: 'tenants/tenant-1/inf.pdf', originalName: 'inf.pdf', mimeType: 'application/pdf',
            scanStatus: 'INFECTED', storageProvider: 'local',
        }) as never));
        mockIsAllowed.mockReturnValue(false);

        await expect(
            downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-1/inf.pdf'),
        ).rejects.toThrow();
        expect(mockGetProviderByName).not.toHaveBeenCalled();
    });
});

describe('downloadFile — S3 path', () => {
    it('returns a presigned redirect keyed on the record pathKey', async () => {
        const createSignedDownloadUrl = jest.fn().mockResolvedValue('https://signed.example.com/foo');
        mockGetProviderByName.mockReturnValue({ name: 's3', createSignedDownloadUrl });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(dbReturning({
            pathKey: 'tenants/tenant-1/evidence/file.pdf', originalName: 'file.pdf',
            mimeType: 'application/pdf', scanStatus: 'CLEAN', storageProvider: 's3',
        }) as never));

        const result = await downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-1/evidence/file.pdf');

        expect(mockAssertKey).toHaveBeenCalledWith('tenants/tenant-1/evidence/file.pdf', 'tenant-1');
        expect(createSignedDownloadUrl).toHaveBeenCalledWith('tenants/tenant-1/evidence/file.pdf', expect.anything());
        expect(result.mode).toBe('redirect');
        expect((result as { downloadUrl?: string }).downloadUrl).toBe('https://signed.example.com/foo');
    });

    it('emits a READ audit on download', async () => {
        mockGetProviderByName.mockReturnValue({ name: 's3', createSignedDownloadUrl: jest.fn().mockResolvedValue('https://x') });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(dbReturning({
            pathKey: 'tenants/tenant-1/f.pdf', originalName: 'f.pdf', mimeType: 'application/pdf',
            scanStatus: 'CLEAN', storageProvider: 's3',
        }) as never));

        await downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-1/f.pdf');

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({ action: 'READ', entityType: 'File' }),
        );
    });
});

describe('downloadFile — local path', () => {
    it('streams a buffer with the record mimeType + originalName', async () => {
        async function* fakeStream() { yield Buffer.from('hello'); yield Buffer.from(' world'); }
        mockGetProviderByName.mockReturnValue({ name: 'local', readStream: jest.fn(() => fakeStream()) });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(dbReturning({
            pathKey: 'tenants/tenant-1/evidence/report.csv', originalName: 'report.csv',
            mimeType: 'text/csv', scanStatus: 'CLEAN', storageProvider: 'local',
        }) as never));

        const result = await downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-1/evidence/report.csv');

        expect(result.mode).toBe('stream');
        const r = result as { mimeType: string; buffer: Buffer; name: string };
        expect(r.mimeType).toBe('text/csv');
        expect(r.buffer.toString()).toBe('hello world');
        expect(r.name).toBe('report.csv');
    });

    it('throws notFound when the storage stream throws', async () => {
        mockGetProviderByName.mockReturnValue({ name: 'local', readStream: jest.fn(() => { throw new Error('ENOENT'); }) });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(dbReturning({
            pathKey: 'tenants/tenant-1/missing.pdf', originalName: 'missing.pdf', mimeType: 'application/pdf',
            scanStatus: 'CLEAN', storageProvider: 'local',
        }) as never));

        await expect(
            downloadFile(makeRequestContext('EDITOR'), 'tenants/tenant-1/missing.pdf'),
        ).rejects.toThrow(/File not found/);
    });
});
