import { PrismaTx } from '@/lib/db-context';
import { env } from '@/env';
import { RequestContext } from '../types';

export class FileRepository {
    static async createPending(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            pathKey: string;
            originalName: string;
            mimeType: string;
            sizeBytes: number;
            sha256: string;
            storageProvider?: string;
            bucket?: string | null;
            domain?: string;
        },
    ) {
        return db.fileRecord.create({
            data: {
                tenantId: ctx.tenantId,
                pathKey: data.pathKey,
                originalName: data.originalName,
                mimeType: data.mimeType,
                sizeBytes: data.sizeBytes,
                sha256: data.sha256,
                status: 'PENDING',
                uploadedByUserId: ctx.userId,
                storageProvider: data.storageProvider || env.STORAGE_PROVIDER,
                bucket: data.bucket || null,
                domain: data.domain || 'general',
            },
        });
    }

    /**
     * @param scan verdict from `scanUploadOrRefuse`, when the caller scanned
     *   the bytes before writing them. Omitted leaves `scanStatus` alone.
     *
     * Note there is no `scanStatus: 'PENDING'` in the data block any more.
     * `createPending` already relies on the schema default, so the stamp was
     * redundant — and it ran AFTER the upload path could have learned a
     * verdict, so it silently reset every scan result back to PENDING. Do not
     * restore it "for symmetry".
     */
    static async markStored(
        db: PrismaTx,
        _ctx: RequestContext,
        id: string,
        scan?: { scanStatus: 'CLEAN' | 'SKIPPED'; scanDetails?: string; scannedAt?: Date },
    ) {
        return db.fileRecord.update({
            where: { id },
            data: {
                status: 'STORED',
                storedAt: new Date(),
                ...(scan
                    ? {
                          scanStatus: scan.scanStatus,
                          scanDetails: scan.scanDetails ?? null,
                          scannedAt: scan.scannedAt ?? new Date(),
                      }
                    : {}),
            },
        });
    }

    static async markFailed(db: PrismaTx, _ctx: RequestContext, id: string) {
        return db.fileRecord.update({
            where: { id },
            data: { status: 'FAILED' },
        });
    }

    static async markDeleted(db: PrismaTx, _ctx: RequestContext, id: string) {
        return db.fileRecord.update({
            where: { id },
            data: { status: 'DELETED' },
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.fileRecord.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
    }

    static async getByIdForTenant(db: PrismaTx, tenantId: string, id: string) {
        return db.fileRecord.findFirst({
            where: { id, tenantId },
        });
    }

    static async listByTenant(db: PrismaTx, ctx: RequestContext, options?: { status?: string }) {
        const where: Record<string, unknown> = { tenantId: ctx.tenantId };
        if (options?.status) where.status = options.status;
        return db.fileRecord.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Find the FileRecord that already owns a SHA-256 hash for a tenant (dedup).
     *
     * Two dispositions claim a hash, and the lookup has to see BOTH:
     *
     *   STORED    the canonical copy. A later identical upload reuses this row
     *             instead of storing the same bytes twice.
     *   INFECTED  quarantined. The AV webhook moves `scanStatus` to INFECTED
     *             and `status` to FAILED in one atomic write, so a quarantined
     *             row no longer reads STORED — and a STORED-only lookup
     *             therefore dropped it straight out of the dedup index. The
     *             identical bytes could then be re-uploaded as a brand-new
     *             PENDING row, with the verdict already in the table and no
     *             longer attached to anything. A condemned hash stays
     *             condemned; this query is where that is decided.
     *
     * Infected is matched FIRST, deliberately. The same bytes may have been
     * stored before the signature that catches them shipped, in which case both
     * rows exist — and then the verdict has to win rather than whichever row
     * `findFirst` happened to reach. Two narrow queries rather than one `OR`
     * because that ordering must not depend on the planner.
     */
    static async findBySha256(db: PrismaTx, tenantId: string, sha256: string) {
        const quarantined = await db.fileRecord.findFirst({
            where: { tenantId, sha256, scanStatus: 'INFECTED' },
        });
        if (quarantined) return quarantined;

        return db.fileRecord.findFirst({
            where: { tenantId, sha256, status: 'STORED' },
        });
    }

    /**
     * Find old PENDING FileRecords for cleanup.
     */
    static async findPendingOlderThan(db: PrismaTx, tenantId: string, olderThan: Date) {
        return db.fileRecord.findMany({
            where: {
                tenantId,
                status: 'PENDING',
                createdAt: { lt: olderThan },
            },
        });
    }

    // ─── AV Scan Lifecycle ───

    static async updateScanStatus(
        db: PrismaTx,
        id: string,
        scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED',
        scanDetails?: string,
    ) {
        return db.fileRecord.update({
            where: { id },
            data: {
                scanStatus,
                ...(scanDetails ? { scanDetails } : {}),
                updatedAt: new Date(),
            },
        });
    }

    static async markScanClean(db: PrismaTx, id: string) {
        return FileRepository.updateScanStatus(db, id, 'CLEAN');
    }

    static async markScanInfected(db: PrismaTx, id: string, details?: string) {
        return FileRepository.updateScanStatus(db, id, 'INFECTED', details);
    }

    static async findPendingScan(db: PrismaTx, tenantId?: string) {
        const where: Record<string, unknown> = { scanStatus: 'PENDING', status: 'STORED' };
        if (tenantId) where.tenantId = tenantId;
        return db.fileRecord.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            take: 100,
        });
    }

    static async getByPathKey(db: PrismaTx, pathKey: string) {
        return db.fileRecord.findFirst({
            where: { pathKey },
        });
    }

    // R5-P1 #1 — `isFileOwnedByTenant` was removed. It treated a match on the
    // caller-writable `Evidence.content` as proof of file ownership, which let
    // an attacker "own" any tenant's pathKey by filing an evidence row pointing
    // at it. `downloadFile` now resolves ownership through the tenant-scoped
    // FileRecord directly (+ assertTenantKey), so the method is gone entirely.
}
