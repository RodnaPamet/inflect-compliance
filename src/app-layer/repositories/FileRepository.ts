import { PrismaTx } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { env } from '@/env';
import { RequestContext } from '../types';

/**
 * Backoff floor. A row that has just failed once is not interesting again for
 * a quarter of an hour: none of the reasons a rescan fails (missing object,
 * digest mismatch, unparseable payload, scanner down) resolve faster than an
 * operator can act.
 */
export const SCAN_ATTEMPT_BACKOFF_BASE_MS = 15 * 60_000;

/**
 * Backoff ceiling. Capped rather than unbounded because the failure modes DO
 * get fixed — storage is restored, clamd is upgraded — and a row must return
 * to the queue on its own once that happens, without an operator knowing to
 * go looking for it.
 */
export const SCAN_ATTEMPT_BACKOFF_MAX_MS = 24 * 60 * 60_000;

/**
 * Delay before the `n`th attempt is eligible again. Doubles per attempt from
 * the floor to the ceiling: 15m, 30m, 1h, 2h, 4h, 8h, 16h, then 24h forever.
 */
export function scanAttemptBackoffMs(attempts: number): number {
    // A non-finite count would propagate through the shift into
    // `new Date(now + NaN)` — an Invalid Date, which Prisma writes as NULL,
    // which reads back as "due now" and reinstates the starvation this whole
    // change exists to remove. Failing closed to one attempt is the safe read.
    const n = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
    // Exponent is clamped before the shift: 2 ** 1024 is Infinity, and
    // `Math.min(Infinity, cap)` would still be the cap, but `new Date(now +
    // Infinity)` on the way there is an Invalid Date if anyone reorders this.
    const doublings = Math.min(n - 1, 32);
    return Math.min(SCAN_ATTEMPT_BACKOFF_BASE_MS * 2 ** doublings, SCAN_ATTEMPT_BACKOFF_MAX_MS);
}

/**
 * The columns an attempt record is allowed to write — nothing that a
 * downloader, a gate, or an auditor reads as a scan result.
 */
export const SCAN_ATTEMPT_COLUMNS = [
    'scanAttempts',
    'lastScanAttemptAt',
    'nextScanAttemptAt',
] as const;

/**
 * Columns that assert a VERDICT. An attempt record that touched one of these
 * would be publishing a scan result it does not have — the exact failure the
 * rescan job is built to avoid — so it is refused here rather than trusted to
 * a code reviewer noticing a merged object literal.
 */
export const SCAN_VERDICT_COLUMNS = ['scanStatus', 'scanDetails', 'scannedAt', 'status'] as const;

export function assertAttemptColumnsOnly(data: Record<string, unknown>): void {
    for (const column of Object.keys(data)) {
        if ((SCAN_VERDICT_COLUMNS as readonly string[]).includes(column)) {
            throw badRequest(
                `recordScanAttempt refuses to write the verdict column "${column}": ` +
                    'an attempt record must never assert a scan result',
            );
        }
        if (!(SCAN_ATTEMPT_COLUMNS as readonly string[]).includes(column)) {
            throw badRequest(`recordScanAttempt refuses to write the unknown column "${column}"`);
        }
    }
}

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

    /**
     * Rows the AV sweep should look at next.
     *
     * The predicate carries `scanStatus: 'PENDING'` because that is still the
     * honest record of "no verdict yet" — but PENDING alone is not a work
     * queue. A row can be permanently unable to reach a verdict (its object is
     * gone from storage, its bytes no longer match `sha256`, clamd cannot
     * parse it) and correctly stay PENDING forever. Selected oldest-first with
     * a `take`, those rows sit at the head of the page on every run and the
     * backlog behind them never drains.
     *
     * Two things keep that from happening, and both read the ATTEMPT columns,
     * never the verdict ones:
     *
     *  - `nextScanAttemptAt` gates a row out until its backoff expires. NULL
     *    means never attempted, which is due now — so rows written before
     *    this shipped are picked up immediately.
     *  - the ordering puts fewest-attempts first, so a row that has failed
     *    nine times can never be ahead of one that has never been tried, even
     *    when both are due.
     */
    static async findPendingScan(db: PrismaTx, tenantId?: string, now: Date = new Date()) {
        const where: Record<string, unknown> = {
            scanStatus: 'PENDING',
            status: 'STORED',
            OR: [{ nextScanAttemptAt: null }, { nextScanAttemptAt: { lte: now } }],
        };
        if (tenantId) where.tenantId = tenantId;
        return db.fileRecord.findMany({
            where,
            orderBy: [{ scanAttempts: 'asc' }, { createdAt: 'asc' }],
            take: 100,
        });
    }

    /**
     * Record that a scan was ATTEMPTED and failed to produce a verdict, and
     * push the row's next eligibility out by the backoff for its new attempt
     * count.
     *
     * This is deliberately a separate statement from the verdict write, and
     * touches a disjoint set of columns. Sharing either would defeat the
     * point: a verdict is terminal and must never be fabricated by a
     * bookkeeping write, and an attempt count is frequent and says nothing at
     * all about whether the file is safe.
     *
     * `assertAttemptColumnsOnly` guards that split. Today it cannot fire —
     * the data it checks is a literal built three lines below — and saying
     * otherwise would be claiming a defence that never runs. What it is for
     * is the NEXT edit: the moment anyone threads a caller-supplied object
     * into this write, a merged `scanStatus` becomes a fabricated verdict
     * rather than a bookkeeping bump. It is exported and directly tested so
     * the rule is enforced somewhere a test can see, instead of resting on a
     * reviewer noticing.
     *
     * `scanStatus: 'PENDING'` in the predicate means a row that won a verdict
     * from another writer while we were scanning it cannot have its attempt
     * counter bumped afterwards — the same conditional-claim shape the
     * verdict write uses.
     *
     * @returns the row's new attempt count, or `null` if it was no longer
     *   PENDING (nothing was written).
     */
    static async recordScanAttempt(
        db: PrismaTx,
        id: string,
        opts: { tenantId: string; attempts: number; now?: Date },
    ): Promise<number | null> {
        const now = opts.now ?? new Date();
        const current = Number.isFinite(opts.attempts) ? Math.max(0, Math.floor(opts.attempts)) : 0;
        const attempts = current + 1;
        const data = {
            scanAttempts: attempts,
            lastScanAttemptAt: now,
            nextScanAttemptAt: new Date(now.getTime() + scanAttemptBackoffMs(attempts)),
        };
        assertAttemptColumnsOnly(data);

        const written = await db.fileRecord.updateMany({
            where: { id, tenantId: opts.tenantId, scanStatus: 'PENDING' },
            data,
        });
        return written.count === 0 ? null : attempts;
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
