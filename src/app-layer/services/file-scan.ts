/**
 * Invoke the AV scanner at upload time and turn its result into something
 * persistable.
 *
 * The gate (`isDownloadAllowed`) has always been correct and is applied on
 * every serving path. What was missing is the other half: NOTHING in the
 * codebase called `scanBuffer` / `scanStream` / `triggerAsyncScan`, so every
 * `FileRecord` sat at its `scanStatus: 'PENDING'` default forever. The control
 * was wired at the gate and never at the scan — a ClamAV container deployed and
 * idle, and a production table reading 4 PENDING / 2 SKIPPED / 0 CLEAN.
 *
 * Scanning happens INLINE, in the request that already holds the bytes, and
 * BEFORE they reach storage. Two reasons it is not a background job: the
 * infected bytes never enter the bucket or the SHA-256 dedup index, and a
 * BullMQ job would not run on a developer laptop or in CI — the two places a
 * regression would otherwise be noticed.
 *
 * The mapping of outcomes is the whole design:
 *
 *   INFECTED  refuse the upload outright, after an audit row. The file is
 *             never written, so there is nothing to quarantine later.
 *   CLEAN     return a verdict for the caller to persist through `markStored`.
 *   ERROR     return undefined -> the row keeps its PENDING default and the
 *             download gate decides what that means. clamd being unreachable
 *             must NOT fail an upload; evidence ingest cannot depend on the
 *             scanner being up.
 *   disabled  return undefined WITHOUT calling the scanner. `scanBuffer`
 *             synthesises `status: 'CLEAN', engine: 'disabled'` in this mode,
 *             and persisting that would permanently mark an unscanned file
 *             clean — surviving a later switch to strict. PENDING is the
 *             honest record of "not scanned", and it is servable anyway while
 *             the mode is disabled.
 *   oversize  same as ERROR. "Too big to scan" is not "safe".
 */
import { scanBuffer } from '@/lib/storage/av-scan';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '../types';

/**
 * Largest buffer we will hand to clamd.
 *
 * clamd's own `StreamMaxLength` defaults to 25 MB and aborts the stream past
 * it, while uploads are capped far higher — so sending a 100 MB file means a
 * round trip that ends in an abort and lands on PENDING anyway. Skipping
 * locally reaches the same state deterministically and without the transfer.
 *
 * Keep this at or below the deployed clamd's `StreamMaxLength`, or large files
 * silently stay PENDING.
 */
export const AV_SCAN_MAX_BYTES = 25 * 1024 * 1024;

/** A scan result worth writing to the FileRecord. */
export interface StoredScan {
    scanStatus: 'CLEAN';
    scanDetails: string;
    scannedAt: Date;
}

/**
 * Scan an about-to-be-stored upload.
 *
 * @throws badRequest('FILE_INFECTED') when the scanner reports an infection.
 * @returns a verdict to persist, or `undefined` to leave the row at PENDING.
 */
export async function scanUploadOrRefuse(
    ctx: RequestContext,
    buffer: Buffer,
    meta: { originalName: string; mimeType: string; sizeBytes: number },
): Promise<StoredScan | undefined> {
    // Never call the scanner in disabled mode — see the note above on why its
    // synthetic CLEAN must not be persisted.
    if (env.AV_SCAN_MODE === 'disabled') return undefined;

    if (buffer.length > AV_SCAN_MAX_BYTES) {
        logger.warn('av-scan skipped: buffer exceeds scan cap', {
            component: 'file-scan',
            sizeBytes: buffer.length,
            capBytes: AV_SCAN_MAX_BYTES,
            originalName: meta.originalName,
        });
        return undefined;
    }

    const result = await scanBuffer(buffer);

    if (result.status === 'INFECTED') {
        // Audit BEFORE throwing — the refusal is the security event, and it is
        // the only record that this file was ever offered. Reuses the action
        // string the AV webhook already writes so one SIEM rule catches both
        // dispositions.
        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                action: 'FILE_QUARANTINED',
                entityType: 'FileRecord',
                entityId: meta.originalName,
                details: `Refused infected upload: ${meta.originalName}`,
                detailsJson: {
                    category: 'access',
                    operation: 'login',
                    detail: `Refused infected upload: ${meta.originalName}`,
                    threat: result.threat ?? 'unknown',
                    engine: result.engine,
                    sizeBytes: meta.sizeBytes,
                    disposition: 'refused_at_upload',
                },
            }),
        );
        logger.warn('av-scan refused an infected upload', {
            component: 'file-scan',
            threat: result.threat,
            engine: result.engine,
            originalName: meta.originalName,
        });
        throw badRequest(
            'FILE_INFECTED',
            'This file was rejected by the malware scanner.',
        );
    }

    if (result.status === 'ERROR') {
        // clamd unreachable, timed out, unconfigured, or unparseable. Leave the
        // row PENDING and let the download gate apply the configured policy.
        logger.warn('av-scan did not complete; leaving file unscanned', {
            component: 'file-scan',
            engine: result.engine,
            rawOutput: result.rawOutput,
            originalName: meta.originalName,
        });
        return undefined;
    }

    // A real CLEAN from a real engine. `engine: 'disabled'` cannot reach here —
    // that branch returned above — but assert it rather than assume it.
    if (result.engine === 'disabled') return undefined;

    return {
        scanStatus: 'CLEAN',
        scanDetails: JSON.stringify({
            engine: result.engine,
            durationMs: result.durationMs,
            source: 'inline-upload',
        }),
        scannedAt: new Date(),
    };
}
