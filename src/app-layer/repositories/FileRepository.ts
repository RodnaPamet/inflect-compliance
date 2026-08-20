import { PrismaTx } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
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

    /**
     * Record a scan verdict.
     *
     * INFECTED IS TERMINAL ON THIS PATH. This used to be an unconditional
     * `update`, which made the repository a general-purpose setter that could
     * walk a row from INFECTED back to CLEAN. The download gates trust
     * `scanStatus` alone, so that transition is a served-malware bug — and it
     * needed no attacker, only a rescan job posting a later verdict.
     *
     * The write is now a conditional `updateMany` claim, the same shape
     * `av-webhook/route.ts` already uses and for the same reason: a
     * read-then-write would let two racing scan results both pass a prior
     * read of the current verdict. The predicate makes the database settle it
     * in one statement.
     *
     * @returns the updated row, or `null` when the claim was refused — the
     *   row is already INFECTED, or no longer exists. Refusal is a value
     *   rather than a throw so a batch rescan can count and log reversal
     *   attempts instead of aborting the batch. It is NOT silence: a caller
     *   must never read `null` as success.
     *
     * Clearing a false-positive quarantine is deliberately not reachable from
     * here. See {@link clearInfectedVerdict}.
     */
    static async updateScanStatus(
        db: PrismaTx,
        id: string,
        scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED',
        scanDetails?: string,
    ) {
        const claimed = await db.fileRecord.updateMany({
            where: { id, scanStatus: { not: 'INFECTED' } },
            data: {
                scanStatus,
                ...(scanDetails ? { scanDetails } : {}),
                updatedAt: new Date(),
            },
        });
        if (claimed.count === 0) return null;
        return db.fileRecord.findUnique({ where: { id } });
    }

    /** @returns `null` if the row is already INFECTED — see {@link updateScanStatus}. */
    static async markScanClean(db: PrismaTx, id: string) {
        return FileRepository.updateScanStatus(db, id, 'CLEAN');
    }

    static async markScanInfected(db: PrismaTx, id: string, details?: string) {
        return FileRepository.updateScanStatus(db, id, 'INFECTED', details);
    }

    /**
     * THE SANCTIONED ESCAPE HATCH from a terminal INFECTED verdict.
     *
     * This is the only way a quarantined FileRecord returns to service, and
     * it exists for exactly one consumer: an admin clearing a false positive.
     * It is deliberately not a general-purpose setter — the ordinary path,
     * {@link updateScanStatus}, cannot reach CLEAN from INFECTED at all, and
     * this one cannot reach anything except CLEAN, from INFECTED, once.
     *
     * CONTRACT FOR THE CALLING USECASE (authorization and the audit chain
     * live above this layer, so the repository cannot enforce them itself —
     * what it enforces is that you cannot call it without having done them):
     *
     *   1. AUTHORIZE FIRST. Gate the route with
     *      `requirePermission('admin.tenant_lifecycle', …)` from
     *      `@/lib/security/permission-middleware`. Returning suspected
     *      malware to circulation is an OWNER-grade decision, not an
     *      evidence-editor one — `admin.tenant_lifecycle` is the key ADMIN
     *      is explicitly denied and only OWNER carries.
     *   2. WRITE THE AUDIT ROW FIRST, through the canonical hash-chained
     *      writer — `appendAuditEntry({ action: 'FILE_QUARANTINE_CLEARED',
     *      entity: 'FileRecord', entityId: id, … })` from `@/lib/audit` —
     *      and pass the returned `id` as `auditLogId`. Use that writer, not
     *      `logEvent` from `@/app-layer/events/audit`: `logEvent` resolves
     *      to void, so it cannot hand you the id this signature demands.
     *      The ordering is deliberate: the audit entry records that the
     *      decision was TAKEN, so it must survive even when this write then
     *      refuses. Requiring the id in the signature is what makes
     *      "audited" a compile-time obligation rather than a convention the
     *      next caller forgets.
     *   3. CAPTURE A HUMAN `reason`. It is stamped into `scanDetails`, so the
     *      row carries the provenance of its own reversal — nobody reading
     *      the FileRecord later sees a bare CLEAN with no history.
     *
     * The transition is exact and atomic. The predicate names the source
     * state and the data block moves both columns together, mirroring the
     * webhook's fold-both-writes-into-one-statement rule: there is no window
     * in which the row is readable as CLEAN-but-still-quarantined. A DELETED
     * row is excluded from the predicate so clearing a verdict can never
     * resurrect a deleted file.
     *
     * @returns the restored row, or `null` when there was nothing to clear —
     *   the row was not INFECTED, was DELETED, or belongs to another tenant.
     */
    static async clearInfectedVerdict(
        db: PrismaTx,
        id: string,
        override: {
            /** Tenant that owns the row. Defence in depth beside RLS. */
            tenantId: string;
            /** The admin who took the decision. */
            clearedByUserId: string;
            /** Human justification. Stamped into `scanDetails`. */
            reason: string;
            /** Id of the `AuditLog` row written BEFORE this call. */
            auditLogId: string;
        },
    ) {
        if (!override.reason.trim()) {
            throw badRequest('clearInfectedVerdict requires a reason for the reversal');
        }
        if (!override.auditLogId.trim()) {
            throw badRequest(
                'clearInfectedVerdict requires the id of the audit entry recording the decision',
            );
        }

        const cleared = await db.fileRecord.updateMany({
            where: {
                id,
                tenantId: override.tenantId,
                scanStatus: 'INFECTED',
                // Quarantine lifts in the same statement, and only from a
                // state that can hold a live file. DELETED stays DELETED.
                status: { in: ['FAILED', 'STORED'] },
            },
            data: {
                scanStatus: 'CLEAN',
                status: 'STORED',
                scanDetails: JSON.stringify({
                    result: 'false_positive_cleared',
                    reason: override.reason,
                    clearedByUserId: override.clearedByUserId,
                    auditLogId: override.auditLogId,
                    clearedAt: new Date().toISOString(),
                }),
                scannedAt: new Date(),
                updatedAt: new Date(),
            },
        });
        if (cleared.count === 0) return null;
        return db.fileRecord.findUnique({ where: { id } });
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
