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
import {
    assertCanClearFileQuarantine,
    assertCanViewQuarantinedFiles,
} from '../policies/admin.policies';
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

// ═══════════════════════════════════════════════════════════════════
// The read side: finding the file to act on.
//
// `clearFileQuarantine` above takes a `fileId` and nothing else, and
// until this existed there was no way to obtain one. An operator had
// to lift the id out of the audit trail — which is a hash-chained,
// append-only log, not a work queue — so the escape hatch shipped with
// no handle on it. This is the handle.
// ═══════════════════════════════════════════════════════════════════

/** Default page size — one screenful without a scroll marathon. */
export const DEFAULT_QUARANTINE_PAGE_SIZE = 50;
/**
 * Hard ceiling on a page. A single bad signature update can condemn
 * thousands of rows at once, which is exactly why this query may never
 * be allowed to answer "all of them": the caller pages, or it waits.
 */
export const MAX_QUARANTINE_PAGE_SIZE = 100;

/**
 * Bound on the threat text echoed back. `scanDetails` is written from
 * scanner output, so its length is not ours to trust.
 */
export const MAX_THREAT_TEXT = 300;

/** What the engine said, normalised across the writers that produce it. */
export interface QuarantineVerdict {
    /** Scanning engine, when it identified itself. */
    engine: string | null;
    /** The signature or message — the thing an operator judges. */
    threat: string | null;
    /** Which writer landed the verdict (`rescan-job`, the webhook, …). */
    source: string | null;
    /**
     * True when `scanDetails` was not the JSON envelope either writer
     * produces. The raw text still comes back as `threat`, truncated —
     * an unparseable verdict is a thing to show an operator, not to
     * swallow.
     */
    unparsed: boolean;
}

export interface QuarantinedFileRow {
    fileId: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    domain: string;
    /** `FileRecordStatus` — FAILED for a webhook quarantine, STORED otherwise. */
    status: string;
    /** When the verdict was stamped. Null if the writer left no stamp. */
    quarantinedAt: Date | null;
    uploadedAt: Date;
    uploadedByUserId: string;
    verdict: QuarantineVerdict;
}

export interface ListQuarantinedFilesResult {
    files: QuarantinedFileRow[];
    /**
     * Opaque position to pass back as `cursor`; null on the last page.
     *
     * Opaque on purpose: it encodes the sort key (`scannedAt`, `id`), not a
     * row identity, so the walk survives the very action this list exists to
     * feed. A `fileId` cursor would not — clearing that file's quarantine
     * drops it out of the INFECTED set, and the next page comes back empty.
     */
    nextCursor: string | null;
}

function clip(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_THREAT_TEXT
        ? `${trimmed.slice(0, MAX_THREAT_TEXT)}…`
        : trimmed;
}

/**
 * Normalise `scanDetails` into something an operator can read.
 *
 * Two writers produce it and they do not agree on a shape:
 *   av-webhook   `{ engine, result, details, receivedAt }`
 *   av-rescan    `{ engine, durationMs, threat, source, jobRunId }`
 *
 * Rather than pick one and silently render the other blank, this reads
 * whichever threat-bearing key is present. A value that is not the JSON
 * envelope at all (an older row, a hand-written detail string) is not
 * discarded either — it comes back as `threat` with `unparsed: true`,
 * because the whole point of the surface is judging a verdict, and a
 * verdict you cannot see is worse than an ugly one.
 */
export function summariseScanVerdict(scanDetails: string | null): QuarantineVerdict {
    if (!scanDetails || !scanDetails.trim()) {
        return { engine: null, threat: null, source: null, unparsed: false };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(scanDetails);
    } catch {
        return { engine: null, threat: clip(scanDetails), source: null, unparsed: true };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { engine: null, threat: clip(scanDetails), source: null, unparsed: true };
    }
    const envelope = parsed as Record<string, unknown>;
    return {
        engine: clip(envelope.engine),
        threat: clip(envelope.threat) ?? clip(envelope.details) ?? clip(envelope.result),
        source: clip(envelope.source),
        unparsed: false,
    };
}

/**
 * Enumerate this tenant's quarantined files, newest verdict first.
 *
 * Gated on `admin.tenant_lifecycle` — see
 * `assertCanViewQuarantinedFiles` for why the read carries the same
 * OWNER-only key as the write it feeds.
 *
 * `pathKey` is deliberately NOT in the projection. It is a storage
 * locator for bytes the scanner condemned; nothing on this surface
 * needs it, and a response that carries it turns an operator's list
 * into a pointer at live malware.
 *
 * @throws forbidden — caller lacks `admin.tenant_lifecycle`.
 */
/**
 * Cursor codec for the quarantine walk.
 *
 * The token carries the SORT KEY — `scannedAt` (which is nullable) and `id` —
 * base64url'd so callers treat it as opaque and do not build one by hand.
 *
 * A malformed or truncated token decodes to `undefined`, which means "start
 * from the beginning". That is the deliberate choice: the alternative is an
 * empty page, and on a surface whose job is to show what is quarantined, an
 * empty page reads as "nothing is quarantined". Silently showing page one is
 * wrong in a way the reader can SEE; silently showing nothing is not.
 */
function encodeQuarantineCursor(row: { scannedAt: Date | null; id: string }): string {
    const stamp = row.scannedAt ? row.scannedAt.toISOString() : '';
    return Buffer.from(`${stamp}|${row.id}`, 'utf8').toString('base64url');
}

function decodeQuarantineCursor(
    token: string | undefined,
): { scannedAt: Date | null; id: string } | undefined {
    const raw = (token ?? '').trim();
    if (!raw) return undefined;
    let decoded: string;
    try {
        decoded = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
        return undefined;
    }
    const sep = decoded.indexOf('|');
    if (sep < 0) return undefined;
    const stamp = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!id) return undefined;
    if (!stamp) return { scannedAt: null, id };
    const scannedAt = new Date(stamp);
    if (Number.isNaN(scannedAt.getTime())) return undefined;
    return { scannedAt, id };
}

export async function listQuarantinedFiles(
    ctx: RequestContext,
    options: { limit?: number; cursor?: string } = {},
): Promise<ListQuarantinedFilesResult> {
    assertCanViewQuarantinedFiles(ctx);

    const requested =
        typeof options.limit === 'number' && Number.isFinite(options.limit)
            ? Math.floor(options.limit)
            : DEFAULT_QUARANTINE_PAGE_SIZE;
    const take = Math.min(MAX_QUARANTINE_PAGE_SIZE, Math.max(1, requested));
    const after = decodeQuarantineCursor(options.cursor);

    // One extra row is the page-boundary probe: its presence is what
    // distinguishes "the last page" from "a full page that happens to
    // end here", and it is dropped before the caller sees it.
    const rows = await runInTenantContext(ctx, (db) =>
        FileRepository.listQuarantined(db, ctx.tenantId, { take: take + 1, after }),
    );

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
        files: page.map((row) => ({
            fileId: row.id,
            originalName: row.originalName,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            sha256: row.sha256,
            domain: row.domain,
            status: row.status,
            quarantinedAt: row.scannedAt,
            uploadedAt: row.createdAt,
            uploadedByUserId: row.uploadedByUserId,
            verdict: summariseScanVerdict(row.scanDetails),
        })),
        nextCursor: hasMore ? encodeQuarantineCursor(page[page.length - 1]) : null,
    };
}
