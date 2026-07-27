/**
 * File download usecase — provider-dispatched.
 * Uses the storage abstraction for all file operations.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { notFound, forbidden } from '@/lib/errors/types';
import { assertTenantKey } from '@/lib/storage';
import { isDownloadAllowed, getBlockedReason } from '@/lib/storage/av-scan';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import type { StorageProviderType } from '@/lib/storage/types';

/**
 * Download a file by its storage pathKey.
 *
 * R5-P1 #1 — this path used to trust `FileRepository.isFileOwnedByTenant`,
 * which returned true whenever ANY Evidence row in the caller's OWN tenant had
 * `content === fileName` — and `content` is caller-writable on create. An
 * attacker filed an evidence row whose content was a victim tenant's pathKey,
 * passed the check, and read the victim's bytes. It now mirrors
 * `downloadEvidenceFile`: assert the key belongs to this tenant BEFORE any
 * storage read, resolve ownership through the tenant-scoped `FileRecord` ONLY
 * (never `Evidence.content`), gate on the single shared AV predicate, and read
 * from the backend that actually stored the file (fixing the old S3-mode break).
 */
export async function downloadFile(ctx: RequestContext, fileName: string) {
    assertCanRead(ctx);
    // The pathKey must live under this tenant's prefix — closes the cross-tenant
    // chain at the door, regardless of any DB lookup below.
    assertTenantKey(fileName, ctx.tenantId);
    logger.info('file download started', { component: 'file', fileName });

    return runInTenantContext(ctx, async (db) => {
        const fileRecord = await db.fileRecord.findFirst({
            where: { tenantId: ctx.tenantId, pathKey: fileName },
        });
        if (!fileRecord) throw notFound('File not found');

        // ─── Single shared AV gate ───
        if (!isDownloadAllowed(fileRecord.scanStatus)) {
            throw forbidden(getBlockedReason(fileRecord.scanStatus));
        }

        await logEvent(db, ctx, {
            action: 'READ',
            entityType: 'File',
            entityId: fileName,
            details: `Downloaded file: ${fileRecord.originalName}`,
            detailsJson: {
                category: 'access',
                operation: 'login',
                detail: `File downloaded: ${fileRecord.originalName}`,
            },
        });

        // ─── Dual-read: dispatch by the record's own storage provider ───
        const recordProvider = (fileRecord.storageProvider || 'local') as StorageProviderType;
        const { getProviderByName } = await import('@/lib/storage/index');
        const readProvider = getProviderByName(recordProvider);

        if (readProvider.name === 's3') {
            const downloadUrl = await readProvider.createSignedDownloadUrl(fileRecord.pathKey, {
                expiresIn: 300,
                downloadFilename: fileRecord.originalName,
            });
            return {
                mode: 'redirect' as const,
                downloadUrl,
                name: fileRecord.originalName,
                mimeType: fileRecord.mimeType,
            };
        }

        // Local: stream through the server, collected into a buffer for the route.
        try {
            const stream = readProvider.readStream(fileRecord.pathKey);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            return {
                mode: 'stream' as const,
                buffer: Buffer.concat(chunks),
                mimeType: fileRecord.mimeType,
                name: fileRecord.originalName,
            };
        } catch {
            throw notFound('File not found on disk');
        }
    });
}
