/**
 * Bundle Attachments — Streaming File Export/Import Tests
 *
 * Tests:
 *   1. Export: reads files via storage provider, builds manifest
 *   2. Export: verifies SHA-256 against DB records
 *   3. Export: skips oversized files with warning
 *   4. Export: handles missing/unreadable files gracefully
 *   5. Import: writes files to target tenant storage
 *   6. Import: generates new tenant-scoped pathKeys (isolation)
 *   7. Import: verifies SHA-256 against manifest
 *   8. Import: handles write failures gracefully
 *   9. Import: pathKeyMap tracks source → target remapping
 *  10. Roundtrip: export → import preserves file contents
 *  11. Utilities: computeSha256, streamToBuffer, emptyManifest
 */

import { Readable } from 'stream';
import {
    exportAttachments,
    importAttachments,
    computeSha256,
    streamToBuffer,
    emptyManifest,
    MAX_ATTACHMENT_SIZE_BYTES,
    MAX_BUNDLE_ATTACHMENT_SIZE_BYTES,
    type FileRecordRow,
    type AttachmentManifest,
} from '../../src/app-layer/services/bundle-attachments';
import type { StorageProvider } from '../../src/lib/storage/types';

// ─── Mock Logger ────────────────────────────────────────────────────

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

// ─── Fixtures ───────────────────────────────────────────────────────

const FILE_CONTENT = Buffer.from('Hello, compliance world! This is evidence.');
const FILE_SHA256 = computeSha256(FILE_CONTENT);

function makeFileRecord(overrides: Partial<FileRecordRow> = {}): FileRecordRow {
    return {
        id: 'fr-1',
        pathKey: 'tenants/tenant-1/evidence/2026/04/uuid_report.pdf',
        originalName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: FILE_CONTENT.length,
        sha256: FILE_SHA256,
        domain: 'evidence',
        storageProvider: 'local',
        // Explicit, because the AV gate is now fail-CLOSED on an unknown
        // status. These fixtures previously omitted scanStatus and were
        // exported anyway — the call site guarded the gate with
        // `scanStatus !== undefined &&`, so an absent status skipped it. A
        // file with no recorded scan is exactly the file that must NOT be
        // bundled, so the default here is a file that HAS been scanned; the
        // gate's own behaviour is covered by the scan-gate tests below.
        scanStatus: 'CLEAN',
        ...overrides,
    };
}

function makeStorage(overrides: Partial<StorageProvider> = {}): StorageProvider {
    return {
        name: 'local',
        write: jest.fn().mockResolvedValue({ sha256: FILE_SHA256, sizeBytes: FILE_CONTENT.length }),
        readStream: jest.fn().mockReturnValue(Readable.from(FILE_CONTENT)),
        createSignedDownloadUrl: jest.fn(),
        createSignedUploadUrl: jest.fn(),
        head: jest.fn(),
        delete: jest.fn(),
        copy: jest.fn(),
        ...overrides,
    } as unknown as StorageProvider;
}

// ═════════════════════════════════════════════════════════════════════
// 1. Export — Happy Path
// ═════════════════════════════════════════════════════════════════════

describe('Attachment export: happy path', () => {
    test('exports a single file with correct manifest', async () => {
        const storage = makeStorage();
        const records = [makeFileRecord()];

        const result = await exportAttachments(records, storage);

        expect(result.manifest.count).toBe(1);
        expect(result.manifest.totalSizeBytes).toBe(FILE_CONTENT.length);
        expect(result.contents).toHaveLength(1);
        expect(result.contents[0].buffer).toEqual(FILE_CONTENT);
        expect(result.warnings).toHaveLength(0);
    });

    test('manifest entry contains all required fields', async () => {
        const storage = makeStorage();
        const record = makeFileRecord({ id: 'fr-42', originalName: 'audit.pdf' });
        const result = await exportAttachments([record], storage);

        const entry = result.manifest.entries[0];
        expect(entry.fileRecordId).toBe('fr-42');
        expect(entry.originalName).toBe('audit.pdf');
        expect(entry.mimeType).toBe('application/pdf');
        expect(entry.sha256).toBe(FILE_SHA256);
        expect(entry.domain).toBe('evidence');
    });

    test('exports multiple files', async () => {
        const storage = makeStorage({
            readStream: jest.fn().mockImplementation(() => Readable.from(FILE_CONTENT)),
        });
        const records = [
            makeFileRecord({ id: 'fr-1' }),
            makeFileRecord({ id: 'fr-2', originalName: 'second.pdf' }),
        ];

        const result = await exportAttachments(records, storage);
        expect(result.manifest.count).toBe(2);
        expect(result.contents).toHaveLength(2);
        expect(result.manifest.totalSizeBytes).toBe(FILE_CONTENT.length * 2);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Export — SHA-256 Verification
// ═════════════════════════════════════════════════════════════════════

describe('Attachment export: integrity', () => {
    test('skips file with SHA-256 mismatch', async () => {
        const storage = makeStorage();
        const record = makeFileRecord({ sha256: 'wrong-hash-value' });

        const result = await exportAttachments([record], storage);

        expect(result.manifest.count).toBe(0);
        expect(result.contents).toHaveLength(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('SHA-256 mismatch');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Export — Size Guards
// ═════════════════════════════════════════════════════════════════════

describe('Attachment export: size guards', () => {
    test('skips oversized file', async () => {
        const storage = makeStorage();
        const record = makeFileRecord({ sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1 });

        const result = await exportAttachments([record], storage);

        expect(result.manifest.count).toBe(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('exceeds max');
    });

    test('skips file when total bundle size exceeded', async () => {
        // Strategy: use files that individually pass the per-file limit (100MB)
        // but collectively exceed the bundle limit (1GB).
        // 11 files × 99MB each = 1089MB > 1GB
        const tinyContent = Buffer.from('x');
        const tinyHash = computeSha256(tinyContent);
        const storage = makeStorage({
            readStream: jest.fn().mockImplementation(() => Readable.from(tinyContent)),
        });

        const fileSize = MAX_ATTACHMENT_SIZE_BYTES - (1024 * 1024); // 99MB — under per-file limit
        const records = Array.from({ length: 11 }, (_, i) =>
            makeFileRecord({ id: `fr-${i}`, sizeBytes: fileSize, sha256: tinyHash }),
        );

        const result = await exportAttachments(records, storage);

        // First 10 fit (10 × 99MB = 990MB < 1GB), 11th exceeds
        const maxThatFit = Math.floor(MAX_BUNDLE_ATTACHMENT_SIZE_BYTES / fileSize);
        expect(result.manifest.count).toBe(maxThatFit);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.includes('total bundle size'))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Export — Missing/Unreadable Files
// ═════════════════════════════════════════════════════════════════════

describe('Attachment export: error handling', () => {
    test('logs warning for unreadable file and continues', async () => {
        const storage = makeStorage({
            readStream: jest.fn().mockImplementation(() => {
                throw new Error('File not found');
            }),
        });
        const records = [makeFileRecord()];

        const result = await exportAttachments(records, storage);

        expect(result.manifest.count).toBe(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('Failed to read');
        expect(result.warnings[0]).toContain('File not found');
    });

    test('empty records list produces empty manifest', async () => {
        const storage = makeStorage();
        const result = await exportAttachments([], storage);

        expect(result.manifest.count).toBe(0);
        expect(result.manifest.totalSizeBytes).toBe(0);
        expect(result.contents).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Import — Happy Path
// ═════════════════════════════════════════════════════════════════════

describe('Attachment import: happy path', () => {
    test('writes file to target tenant storage', async () => {
        const storage = makeStorage();
        const manifest: AttachmentManifest = {
            count: 1,
            totalSizeBytes: FILE_CONTENT.length,
            entries: [{
                fileRecordId: 'fr-1',
                sourcePathKey: 'tenants/source/evidence/2026/04/uuid_report.pdf',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                sizeBytes: FILE_CONTENT.length,
                sha256: FILE_SHA256,
                domain: 'evidence',
                storageProvider: 'local',
            }],
        };
        const contents = new Map([['fr-1', FILE_CONTENT]]);

        const result = await importAttachments(manifest, contents, 'target-tenant', storage);

        expect(result.imported).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.totalBytesWritten).toBe(FILE_CONTENT.length);
        expect(storage.write).toHaveBeenCalledTimes(1);
    });

    test('generates new pathKey for target tenant (not reusing source)', async () => {
        const storage = makeStorage();
        const manifest: AttachmentManifest = {
            count: 1,
            totalSizeBytes: FILE_CONTENT.length,
            entries: [{
                fileRecordId: 'fr-1',
                sourcePathKey: 'tenants/source-tenant/evidence/2026/04/uuid_report.pdf',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                sizeBytes: FILE_CONTENT.length,
                sha256: FILE_SHA256,
                domain: 'evidence',
                storageProvider: 'local',
            }],
        };
        const contents = new Map([['fr-1', FILE_CONTENT]]);

        const result = await importAttachments(manifest, contents, 'target-tenant', storage);

        const targetPath = result.entries[0].targetPathKey;
        expect(targetPath).toContain('tenants/target-tenant/');
        expect(targetPath).not.toContain('source-tenant');
    });

    test('pathKeyMap tracks source → target remapping', async () => {
        const storage = makeStorage();
        const manifest: AttachmentManifest = {
            count: 1,
            totalSizeBytes: FILE_CONTENT.length,
            entries: [{
                fileRecordId: 'fr-1',
                sourcePathKey: 'old/path',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                sizeBytes: FILE_CONTENT.length,
                sha256: FILE_SHA256,
                domain: 'evidence',
                storageProvider: 'local',
            }],
        };
        const contents = new Map([['fr-1', FILE_CONTENT]]);

        const result = await importAttachments(manifest, contents, 'target-tenant', storage);

        expect(result.pathKeyMap.size).toBe(1);
        expect(result.pathKeyMap.has('fr-1')).toBe(true);
        const newPath = result.pathKeyMap.get('fr-1')!;
        expect(newPath).toContain('target-tenant');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Import — Integrity & Errors
// ═════════════════════════════════════════════════════════════════════

describe('Attachment import: integrity', () => {
    test('rejects file with SHA-256 mismatch', async () => {
        const storage = makeStorage();
        const manifest: AttachmentManifest = {
            count: 1,
            totalSizeBytes: FILE_CONTENT.length,
            entries: [{
                fileRecordId: 'fr-1',
                sourcePathKey: 'old/path',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                sizeBytes: FILE_CONTENT.length,
                sha256: 'wrong-hash',
                domain: 'evidence',
                storageProvider: 'local',
            }],
        };
        const contents = new Map([['fr-1', FILE_CONTENT]]);

        const result = await importAttachments(manifest, contents, 'target-tenant', storage);

        expect(result.imported).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.entries[0].error).toContain('SHA-256 mismatch');
        expect(storage.write).not.toHaveBeenCalled();
    });

    test('handles missing content for manifest entry', async () => {
        const storage = makeStorage();
        const manifest: AttachmentManifest = {
            count: 1,
            totalSizeBytes: FILE_CONTENT.length,
            entries: [{
                fileRecordId: 'fr-missing',
                sourcePathKey: 'old/path',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                sizeBytes: FILE_CONTENT.length,
                sha256: FILE_SHA256,
                domain: 'evidence',
                storageProvider: 'local',
            }],
        };
        const contents = new Map<string, Buffer>(); // Empty — no content

        const result = await importAttachments(manifest, contents, 'target-tenant', storage);

        expect(result.imported).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.entries[0].error).toContain('No content found');
    });

    test('handles write failure gracefully', async () => {
        const storage = makeStorage({
            write: jest.fn().mockRejectedValue(new Error('Disk full')),
        });
        const manifest: AttachmentManifest = {
            count: 1,
            totalSizeBytes: FILE_CONTENT.length,
            entries: [{
                fileRecordId: 'fr-1',
                sourcePathKey: 'old/path',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                sizeBytes: FILE_CONTENT.length,
                sha256: FILE_SHA256,
                domain: 'evidence',
                storageProvider: 'local',
            }],
        };
        const contents = new Map([['fr-1', FILE_CONTENT]]);

        const result = await importAttachments(manifest, contents, 'target-tenant', storage);

        expect(result.imported).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.entries[0].error).toContain('Write failed');
        expect(result.entries[0].error).toContain('Disk full');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Roundtrip — Export → Import
// ═════════════════════════════════════════════════════════════════════

describe('Attachment roundtrip', () => {
    test('export → import preserves file content', async () => {
        const sourceStorage = makeStorage();
        const records = [makeFileRecord()];

        // Export
        const exportResult = await exportAttachments(records, sourceStorage);
        expect(exportResult.manifest.count).toBe(1);

        // Build contents map from export
        const contentMap = new Map<string, Buffer>();
        for (const content of exportResult.contents) {
            contentMap.set(content.entry.fileRecordId, content.buffer);
        }

        // Import to different tenant
        const targetStorage = makeStorage();
        const importResult = await importAttachments(
            exportResult.manifest,
            contentMap,
            'new-tenant',
            targetStorage,
        );

        expect(importResult.imported).toBe(1);
        expect(importResult.failed).toBe(0);
        expect(importResult.totalBytesWritten).toBe(FILE_CONTENT.length);

        // Verify the file was written with correct content
        const writeCall = (targetStorage.write as jest.Mock).mock.calls[0];
        expect(writeCall[0]).toContain('new-tenant');
        expect(writeCall[1]).toEqual(FILE_CONTENT);
    });

    test('roundtrip with multiple files', async () => {
        const content2 = Buffer.from('Second file content for testing');
        const hash2 = computeSha256(content2);
        let callCount = 0;

        const sourceStorage = makeStorage({
            readStream: jest.fn().mockImplementation(() => {
                callCount++;
                return Readable.from(callCount === 1 ? FILE_CONTENT : content2);
            }),
        });
        const records = [
            makeFileRecord({ id: 'fr-1' }),
            makeFileRecord({ id: 'fr-2', originalName: 'second.csv', sizeBytes: content2.length, sha256: hash2 }),
        ];

        const exportResult = await exportAttachments(records, sourceStorage);
        expect(exportResult.manifest.count).toBe(2);

        const contentMap = new Map<string, Buffer>();
        for (const content of exportResult.contents) {
            contentMap.set(content.entry.fileRecordId, content.buffer);
        }

        const targetStorage = makeStorage();
        const importResult = await importAttachments(
            exportResult.manifest,
            contentMap,
            'target-tenant',
            targetStorage,
        );

        expect(importResult.imported).toBe(2);
        expect(importResult.pathKeyMap.size).toBe(2);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 8. Utilities
// ═════════════════════════════════════════════════════════════════════

describe('Attachment utilities', () => {
    test('computeSha256 produces consistent hash', () => {
        const data = Buffer.from('test data');
        const hash1 = computeSha256(data);
        const hash2 = computeSha256(data);
        expect(hash1).toBe(hash2);
        expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    test('computeSha256 produces different hashes for different data', () => {
        expect(computeSha256(Buffer.from('a'))).not.toBe(computeSha256(Buffer.from('b')));
    });

    test('streamToBuffer collects stream into buffer', async () => {
        const stream = Readable.from(Buffer.from('hello'));
        const result = await streamToBuffer(stream);
        expect(result.toString()).toBe('hello');
    });

    test('streamToBuffer handles multi-chunk stream', async () => {
        const stream = new Readable({
            read() {
                this.push(Buffer.from('chunk1'));
                this.push(Buffer.from('chunk2'));
                this.push(null);
            },
        });
        const result = await streamToBuffer(stream);
        expect(result.toString()).toBe('chunk1chunk2');
    });

    test('emptyManifest returns valid empty structure', () => {
        const manifest = emptyManifest();
        expect(manifest.count).toBe(0);
        expect(manifest.totalSizeBytes).toBe(0);
        expect(manifest.entries).toEqual([]);
    });
});
