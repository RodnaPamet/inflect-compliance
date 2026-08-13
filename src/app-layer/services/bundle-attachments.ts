/**
 * Bundle Attachment Codec — Streaming File Attachment Support for Data Portability
 *
 * Handles the export and import of binary file attachments (evidence files,
 * policy documents, etc.) alongside the metadata-only JSON envelope.
 *
 * ARCHITECTURE:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Export Flow                                                  │
 *   │  FileRecord DB entries → manifest with SHA-256 + metadata  │
 *   │  Storage pathKeys → readStream() → Buffer entries          │
 *   │                                                              │
 *   │ Import Flow                                                  │
 *   │  Manifest entries → rebuild pathKeys for target tenant      │
 *   │  Buffer entries → write() to target tenant's storage       │
 *   │  New FileRecord entries created pointing to new pathKeys    │
 *   │                                                              │
 *   │ Bundle Shape                                                │
 *   │  AttachmentManifest: metadata about each file               │
 *   │  AttachmentContent[]: { pathKey, buffer } pairs             │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * DESIGN PRINCIPLES:
 *   - Uses existing StorageProvider abstraction (local/S3)
 *   - Tenant isolation: target pathKeys are regenerated, never reused
 *   - Integrity: SHA-256 verified on import against manifest
 *   - Streaming: files are read/written via Readable streams
 *   - Fail-safe: missing files logged as warnings, don't block export
 *
 * @module app-layer/services/bundle-attachments
 */

import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { StorageProvider } from '@/lib/storage/types';
import { buildTenantObjectKey, type StorageDomain } from '@/lib/storage';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { logger } from '@/lib/observability/logger';

// ─── Types ──────────────────────────────────────────────────────────

/** Manifest entry for a single attachment in the export bundle. */
export interface AttachmentManifestEntry {
    /** Original file record ID (for re-linking on import). */
    fileRecordId: string;
    /** Storage path key used in the source tenant. */
    sourcePathKey: string;
    /** Original filename for display. */
    originalName: string;
    /** MIME type of the file. */
    mimeType: string;
    /** File size in bytes. */
    sizeBytes: number;
    /** SHA-256 hex digest of the file content. */
    sha256: string;
    /** Storage domain (evidence, reports, etc). */
    domain: string;
    /** Storage provider that held the source file. */
    storageProvider: string;
}

/** The complete attachment manifest included in the export envelope. */
export interface AttachmentManifest {
    /** Total number of attachments. */
    count: number;
    /** Total size of all attachments in bytes. */
    totalSizeBytes: number;
    /** Individual attachment entries. */
    entries: AttachmentManifestEntry[];
}

/** A resolved attachment: manifest entry + its binary content. */
export interface AttachmentContent {
    /** The manifest entry this content belongs to. */
    entry: AttachmentManifestEntry;
    /** The raw file content. */
    buffer: Buffer;
}

/** Result of an attachment export operation. */
export interface AttachmentExportResult {
    /** The manifest to include in the export envelope. */
    manifest: AttachmentManifest;
    /** The resolved file contents (for bundling). */
    contents: AttachmentContent[];
    /** Files that could not be read (non-blocking). */
    warnings: string[];
}

/** Result of importing a single attachment. */
export interface AttachmentImportEntry {
    /** Original file record ID from the source. */
    sourceFileRecordId: string;
    /** New path key in the target tenant's storage. */
    targetPathKey: string;
    /** Whether the import succeeded. */
    success: boolean;
    /** Error message if failed. */
    error?: string;
}

/** Result of an attachment import operation. */
export interface AttachmentImportResult {
    /** Number of attachments successfully imported. */
    imported: number;
    /** Number of attachments that failed. */
    failed: number;
    /** Total bytes written. */
    totalBytesWritten: number;
    /** Per-entry results. */
    entries: AttachmentImportEntry[];
    /** ID remapping: sourceFileRecordId → targetPathKey */
    pathKeyMap: Map<string, string>;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum size for a single attachment (100MB). */
export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;

/** Maximum total attachment size per bundle (1GB). */
export const MAX_BUNDLE_ATTACHMENT_SIZE_BYTES = 1024 * 1024 * 1024;

// ─── Export ─────────────────────────────────────────────────────────

/**
 * File record shape expected from the database query.
 * Matches the Prisma FileRecord model fields we need.
 */
export interface FileRecordRow {
    id: string;
    pathKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    domain: string;
    storageProvider: string;
    /** AV scan status — when present, gated through the shared predicate. */
    scanStatus?: string;
}

/**
 * Export file attachments for a set of file records.
 *
 * Reads each file from the storage provider, verifies SHA-256 integrity,
 * and builds a manifest + content array for bundling.
 *
 * Files that cannot be read (missing, corrupted) are logged as warnings
 * but do NOT block the export — the manifest entry is omitted.
 *
 * @param fileRecords  - FileRecord rows from the database
 * @param storage      - Storage provider to read files from
 * @returns Manifest, file contents, and any warnings
 */
export async function exportAttachments(
    fileRecords: FileRecordRow[],
    storage: StorageProvider,
): Promise<AttachmentExportResult> {
    const entries: AttachmentManifestEntry[] = [];
    const contents: AttachmentContent[] = [];
    const warnings: string[] = [];
    let totalSizeBytes = 0;
    let declaredCumulativeSize = 0; // Tracks DB-declared sizes for pre-read guard

    for (const record of fileRecords) {
        // R5-P1 #3 — single shared AV gate: never bundle a file the download
        // predicate would block (INFECTED, or PENDING under strict mode).
        // Fail CLOSED on an unknown scanStatus. The `!== undefined` guard this
        // replaces let an undefined status skip the gate entirely — while
        // `isScanPending` in the client mirror classifies a falsy status as
        // PENDING, i.e. explicitly NOT servable. The predicate already handles
        // null/undefined correctly, so let it own the decision rather than
        // second-guessing it at the call site.
        if (!isDownloadAllowed(record.scanStatus)) {
            warnings.push(
                `Skipped attachment ${record.id} (${record.originalName}): ` +
                `blocked by antivirus scan gate (status ${record.scanStatus})`,
            );
            continue;
        }
        // Guard: skip oversized files
        if (record.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
            warnings.push(
                `Skipped attachment ${record.id} (${record.originalName}): ` +
                `${record.sizeBytes} bytes exceeds max ${MAX_ATTACHMENT_SIZE_BYTES}`,
            );
            continue;
        }

        // Guard: total bundle size (uses declared sizes for accurate pre-read check)
        if (declaredCumulativeSize + record.sizeBytes > MAX_BUNDLE_ATTACHMENT_SIZE_BYTES) {
            warnings.push(
                `Skipped attachment ${record.id} (${record.originalName}): ` +
                `total bundle size would exceed ${MAX_BUNDLE_ATTACHMENT_SIZE_BYTES} bytes`,
            );
            continue;
        }

        try {
            const buffer = await streamToBuffer(storage.readStream(record.pathKey));

            // Verify SHA-256 against the database record
            const actualHash = computeSha256(buffer);
            if (actualHash !== record.sha256) {
                warnings.push(
                    `Skipped attachment ${record.id} (${record.originalName}): ` +
                    `SHA-256 mismatch (expected ${record.sha256}, got ${actualHash})`,
                );
                continue;
            }

            const entry: AttachmentManifestEntry = {
                fileRecordId: record.id,
                sourcePathKey: record.pathKey,
                originalName: record.originalName,
                mimeType: record.mimeType,
                sizeBytes: buffer.length,
                sha256: actualHash,
                domain: record.domain,
                storageProvider: record.storageProvider,
            };

            entries.push(entry);
            contents.push({ entry, buffer });
            totalSizeBytes += buffer.length;
            declaredCumulativeSize += record.sizeBytes;
        } catch (err) {
            // Non-blocking: log warning and skip this file
            warnings.push(
                `Failed to read attachment ${record.id} (${record.originalName}): ` +
                `${(err as Error).message}`,
            );
        }
    }

    if (warnings.length > 0) {
        logger.warn('attachment export completed with warnings', {
            component: 'bundle-attachments',
            warningCount: warnings.length,
            successCount: entries.length,
        });
    }

    return {
        manifest: {
            count: entries.length,
            totalSizeBytes,
            entries,
        },
        contents,
        warnings,
    };
}

// ─── Import ─────────────────────────────────────────────────────────

/**
 * Import file attachments into a target tenant's storage.
 *
 * For each attachment:
 *   1. Verify SHA-256 against manifest
 *   2. Generate a new tenant-scoped pathKey (tenant isolation)
 *   3. Write the file to storage
 *   4. Track the source → target pathKey mapping
 *
 * The caller uses the pathKeyMap to update FileRecord entries in the DB.
 *
 * @param manifest    - Attachment manifest from the export bundle
 * @param contents    - File content buffers indexed by fileRecordId
 * @param targetTenantId - The tenant to import files into
 * @param storage     - Storage provider to write files to
 * @returns Import results with pathKey remapping
 */
export async function importAttachments(
    manifest: AttachmentManifest,
    contents: Map<string, Buffer>,
    targetTenantId: string,
    storage: StorageProvider,
): Promise<AttachmentImportResult> {
    const entries: AttachmentImportEntry[] = [];
    const pathKeyMap = new Map<string, string>();
    let imported = 0;
    let failed = 0;
    let totalBytesWritten = 0;

    for (const manifestEntry of manifest.entries) {
        const buffer = contents.get(manifestEntry.fileRecordId);

        if (!buffer) {
            entries.push({
                sourceFileRecordId: manifestEntry.fileRecordId,
                targetPathKey: '',
                success: false,
                error: `No content found for fileRecordId ${manifestEntry.fileRecordId}`,
            });
            failed++;
            continue;
        }

        // Verify SHA-256
        const actualHash = computeSha256(buffer);
        if (actualHash !== manifestEntry.sha256) {
            entries.push({
                sourceFileRecordId: manifestEntry.fileRecordId,
                targetPathKey: '',
                success: false,
                error: `SHA-256 mismatch: expected ${manifestEntry.sha256}, got ${actualHash}`,
            });
            failed++;
            continue;
        }

        try {
            // Generate new tenant-scoped path (never reuse source paths)
            const domain = (manifestEntry.domain || 'general') as StorageDomain;
            const targetPathKey = buildTenantObjectKey(
                targetTenantId,
                domain,
                manifestEntry.originalName,
            );

            // Write to target storage
            await storage.write(targetPathKey, buffer, {
                mimeType: manifestEntry.mimeType,
            });

            pathKeyMap.set(manifestEntry.fileRecordId, targetPathKey);
            entries.push({
                sourceFileRecordId: manifestEntry.fileRecordId,
                targetPathKey,
                success: true,
            });
            imported++;
            totalBytesWritten += buffer.length;
        } catch (err) {
            entries.push({
                sourceFileRecordId: manifestEntry.fileRecordId,
                targetPathKey: '',
                success: false,
                error: `Write failed: ${(err as Error).message}`,
            });
            failed++;
        }
    }

    return {
        imported,
        failed,
        totalBytesWritten,
        entries,
        pathKeyMap,
    };
}

// ─── Utilities ──────────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a buffer. */
export function computeSha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

/** Collect a Readable stream into a single Buffer. */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

/**
 * Create an empty manifest (for envelopes without attachments).
 */
export function emptyManifest(): AttachmentManifest {
    return { count: 0, totalSizeBytes: 0, entries: [] };
}
