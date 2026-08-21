/**
 * File quarantine reversal — the false-positive escape hatch.
 *
 * When ClamAV condemns an upload the FileRecord goes
 * `scanStatus: INFECTED` + `status: FAILED`, and every download gate
 * (`isDownloadAllowed`) refuses it from then on. That terminality is
 * deliberate — see `FileRepository.updateScanStatus`, where a later
 * scan verdict CANNOT walk a row back to CLEAN, because a rescan job
 * posting a stale-but-newer CLEAN would otherwise serve malware.
 *
 * The cost of that design is that a bad signature update — and they
 * happen — can brick a whole evidence library with no in-app remedy.
 * This usecase is the single sanctioned way back, and it satisfies
 * the three obligations `FileRepository.clearInfectedVerdict` states
 * in its contract but cannot itself enforce:
 *
 *   1. AUTHORIZE FIRST — `assertCanClearFileQuarantine` demands
 *      `admin.tenant_lifecycle`, the OWNER-only key ADMIN is
 *      explicitly denied. The HTTP route carries the same key via
 *      `requirePermission`, so both entrances are gated.
 *   2. AUDIT BEFORE THE WRITE — `appendAuditEntry` runs before the
 *      state transition and its returned id is handed to the
 *      repository. The entry records that the DECISION was taken, so
 *      it must survive even when the write then refuses (a racing
 *      rescan, a row deleted underneath us). That is why the audit
 *      row is not rolled back on refusal: an operator asking "who
 *      tried to un-quarantine this file" gets an answer either way.
 *   3. CAPTURE A REASON — stamped into `scanDetails` so the row
 *      carries the provenance of its own reversal.
 *
 * @module usecases/file-quarantine
 */
import type { RequestContext } from '../types';
import { assertCanClearFileQuarantine } from '../policies/admin.policies';
import { FileRepository } from '../repositories/FileRepository';
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest, notFound, conflict } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * A reason short enough to be a shrug ("ok", "fp") is not provenance.
 * Ten characters is low enough not to be a hurdle and high enough to
 * force a sentence fragment a reviewer can act on.
 */
export const MIN_QUARANTINE_CLEAR_REASON = 10;
/** Bounded so the JSON stamped into `scanDetails` stays a readable column. */
export const MAX_QUARANTINE_CLEAR_REASON = 500;

export interface ClearFileQuarantineInput {
    /** `FileRecord.id` of the quarantined row. */
    fileId: string;
    /** Human justification — why this verdict is believed to be wrong. */
    reason: string;
}

export interface ClearFileQuarantineResult {
    fileId: string;
    originalName: string;
    scanStatus: string;
    status: string;
    /** The audit row written BEFORE the transition. */
    auditLogId: string;
}

/**
 * Return one quarantined file to circulation.
 *
 * @throws forbidden — caller lacks `admin.tenant_lifecycle`.
 * @throws badRequest — reason missing or out of bounds.
 * @throws notFound — no such file in this tenant.
 * @throws conflict — the row is not in a clearable state (never
 *   INFECTED, already cleared, or DELETED). Also thrown when the
 *   repository claim loses a race, in which case the audit row
 *   recording the attempt has already been committed.
 */
export async function clearFileQuarantine(
    ctx: RequestContext,
    input: ClearFileQuarantineInput,
): Promise<ClearFileQuarantineResult> {
    assertCanClearFileQuarantine(ctx);

    const fileId = (input.fileId ?? '').trim();
    if (!fileId) throw badRequest('fileId is required');

    // Strip markup before the value is stamped into `scanDetails`: the
    // column is read back by the admin UI, the evidence export, and any
    // SDK consumer reading the row verbatim.
    const reason = sanitizePlainText(input.reason).trim();
    if (reason.length < MIN_QUARANTINE_CLEAR_REASON) {
        throw badRequest(
            `A reason of at least ${MIN_QUARANTINE_CLEAR_REASON} characters is required to clear a quarantine.`,
        );
    }
    if (reason.length > MAX_QUARANTINE_CLEAR_REASON) {
        throw badRequest(
            `Reason must be ${MAX_QUARANTINE_CLEAR_REASON} characters or fewer.`,
        );
    }

    // ─── 1. Resolve the row (tenant-scoped) and refuse early ───
    const record = await runInTenantContext(ctx, (db) =>
        FileRepository.getById(db, ctx, fileId),
    );
    if (!record) throw notFound('File not found');
    if (record.scanStatus !== 'INFECTED') {
        throw conflict(
            `File is not quarantined (scanStatus: ${record.scanStatus}); there is nothing to clear.`,
        );
    }
    if (record.status === 'DELETED') {
        throw conflict('A deleted file cannot be returned to circulation.');
    }

    // ─── 2. Audit BEFORE the write ───
    // Deliberately outside the transition: this records that the
    // decision was taken, and must outlive a refused write.
    const entry = await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.actorType ?? 'USER',
        entity: 'FileRecord',
        entityId: record.id,
        action: 'FILE_QUARANTINE_CLEARED',
        details: `Malware quarantine cleared for ${record.originalName}`,
        requestId: ctx.requestId,
        detailsJson: {
            category: 'status_change',
            entityName: 'FileRecord',
            fromStatus: 'INFECTED',
            toStatus: 'CLEAN',
            reason,
        },
        metadataJson: {
            fileName: record.originalName,
            sha256: record.sha256,
            previousScanDetails: record.scanDetails ?? null,
        },
    });

    // ─── 3. The transition itself ───
    const restored = await runInTenantContext(ctx, (db) =>
        FileRepository.clearInfectedVerdict(db, record.id, {
            tenantId: ctx.tenantId,
            clearedByUserId: ctx.userId,
            reason,
            auditLogId: entry.id,
        }),
    );

    if (!restored) {
        // The claim was refused between the read and the write. The
        // audit row above stays — the attempt is part of the record.
        logger.warn('file-quarantine.clear_refused', {
            component: 'file-quarantine',
            tenantId: ctx.tenantId,
            fileId: record.id,
            auditLogId: entry.id,
        });
        throw conflict(
            'The file changed state before the quarantine could be cleared. Re-check its scan status and retry.',
        );
    }

    logger.info('file-quarantine.cleared', {
        component: 'file-quarantine',
        tenantId: ctx.tenantId,
        fileId: restored.id,
        auditLogId: entry.id,
    });

    return {
        fileId: restored.id,
        originalName: restored.originalName,
        scanStatus: restored.scanStatus,
        status: restored.status,
        auditLogId: entry.id,
    };
}
