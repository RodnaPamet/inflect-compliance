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

    static async markStored(db: PrismaTx, _ctx: RequestContext, id: string) {
        return db.fileRecord.update({
            where: { id },
            data: { status: 'STORED', storedAt: new Date(), scanStatus: 'PENDING' },
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
     * Find a STORED FileRecord with the same SHA-256 hash for a tenant (dedup).
     */
    static async findBySha256(db: PrismaTx, tenantId: string, sha256: string) {
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
