/**
 * File distribution ledger — "what already carried these bytes?"
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE PROBLEM
 * ═══════════════════════════════════════════════════════════════════
 *
 * An AV verdict can arrive long after upload — that asynchrony is the entire
 * reason `/api/storage/av-webhook` exists. When the verdict is INFECTED the
 * file is quarantined and every FUTURE read is refused. Nothing addressed the
 * reads that had ALREADY happened, or the copies already handed out:
 *
 *   • audit-pack ZIPs pushed into a customer's SharePoint — outside our
 *     control the moment the upload completes;
 *   • presigned download URLs, which keep working until they expire no matter
 *     what the row now says;
 *   • portability bundles that embed the bytes.
 *
 * So an auditor could be holding a ZIP containing malware we have since
 * condemned, and the product could not name the auditor, the pack, or the day.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE SHAPE
 * ═══════════════════════════════════════════════════════════════════
 *
 * Record distribution AT THE MOMENT BYTES LEAVE (one ledger entry per file per
 * egress), then JOIN ON THE HASH when a verdict flips. The join is on the
 * content hash, not the row id: the same malicious bytes can sit under several
 * FileRecord rows (re-upload, evidence versioning), and an exposure answer that
 * only covers the row the scanner happened to name is the wrong answer.
 *
 * WHY THE AUDIT TRAIL IS THE STORE, not a new table. A distribution record is
 * a claim about who received what — it is evidence, and its whole value is
 * that it cannot be edited after the fact. `AuditLog` is already exactly that
 * store: hash-chained, append-only at both the application layer and a DB
 * trigger, tenant-scoped under RLS, streamed to the tenant's SIEM, and already
 * classified in `docs/data-retention.md`. A fresh `FileDistribution` table
 * would have been a mutable, un-chained sibling that had to re-earn every one
 * of those properties. The lookup stays an indexed equality query
 * (`@@index([tenantId, action])`, plus `entityId` narrowing), not a JSON scan.
 *
 * WHAT THIS DOES NOT DO. It does not un-send anything. Recording is
 * deliberately FAIL-SAFE at every call site: a ledger write that throws logs
 * loudly and lets the download or export proceed, because refusing a legitimate
 * auditor's download to protect our own bookkeeping is the worse failure. That
 * makes the ledger a lower bound on exposure — `exhaustive: false` says so in
 * the report rather than letting a reader assume completeness.
 *
 * @module app-layer/services/file-distribution
 */
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { logger } from '@/lib/observability/logger';

// ─── Actions ────────────────────────────────────────────────────────

/** Ledger entry: these bytes left the platform through `channel`. */
export const FILE_DISTRIBUTED_ACTION = 'FILE_DISTRIBUTED';

/** The answer, written back into the same trail when a verdict flips. */
export const FILE_EXPOSURE_ASSESSED_ACTION = 'FILE_EXPOSURE_ASSESSED';

/** Marks a ledger entry's `detailsJson` so a reader can recognise one. */
export const FILE_DISTRIBUTION_KIND = 'file_distribution';

// ─── Channels ───────────────────────────────────────────────────────

/** Every way bytes currently leave the platform. */
export type DistributionChannel =
    | 'EVIDENCE_DOWNLOAD'
    | 'TRUST_CENTER_DOWNLOAD'
    | 'AUDIT_PACK_SHAREPOINT'
    | 'PORTABILITY_BUNDLE';

/**
 * Channels whose copies cannot be taken back at all.
 *
 * A presigned URL is *bounded* — it stops working at a known instant (#2040
 * pinned the trust-center URL to the authenticated path's 300s), so the
 * exposure it represents has an end date we can state. A ZIP sitting in a
 * customer's SharePoint tenant has none: it is a permanent copy, and the only
 * honest remediation is telling a human which artefact to go and delete.
 * Keeping the two classes separate in the report is the point — collapsing
 * them into one "distributions" count is what makes such a count useless.
 */
export const UNREVOCABLE_CHANNELS: ReadonlySet<DistributionChannel> = new Set<DistributionChannel>([
    'AUDIT_PACK_SHAREPOINT',
    'PORTABILITY_BUNDLE',
]);

/** True when a copy through this channel is permanent. */
export function isUnrevocable(channel: string): boolean {
    return UNREVOCABLE_CHANNELS.has(channel as DistributionChannel);
}

// ─── Recording ──────────────────────────────────────────────────────

export interface RecordDistributionInput {
    tenantId: string;
    fileRecordId: string;
    /** Content hash — the join key when a verdict flips. */
    sha256: string;
    channel: DistributionChannel;
    /** Who received it, as an opaque user id. NEVER an email — see Epic C.4. */
    actorUserId?: string | null;
    /**
     * Where the bytes went, in non-identifying terms: a SharePoint drive id, a
     * storage provider name. Anything that names a PERSON belongs in
     * `contextType`/`contextId` instead, so the identity is recoverable by
     * joining the referenced row rather than copied into the SIEM payload.
     */
    destination?: string | null;
    /** Owning artefact, e.g. `AuditPack` / `TrustCenterAccessRequest`. */
    contextType?: string | null;
    contextId?: string | null;
    /**
     * For a presigned URL: the instant it stops working. Omit when the bytes
     * were streamed or embedded — those are already fully delivered.
     */
    signedUrlExpiresAt?: Date | null;
}

/** The `detailsJson` payload of one ledger entry. */
export interface DistributionDetails {
    category: 'custom';
    kind: typeof FILE_DISTRIBUTION_KIND;
    channel: DistributionChannel;
    sha256: string;
    destination: string | null;
    contextType: string | null;
    contextId: string | null;
    signedUrlExpiresAt: string | null;
    revocable: boolean;
}

/**
 * Append one ledger entry. NEVER throws — a failure here must not fail the
 * download or export that is already in flight.
 *
 * @returns true when the entry landed, false when it was skipped or failed.
 */
export async function recordFileDistribution(input: RecordDistributionInput): Promise<boolean> {
    // A record without a tenant, a file or a hash cannot be joined on later,
    // so it is not a record — it is noise that would inflate the counts the
    // exposure report is supposed to be trusted for.
    if (!input.tenantId || !input.fileRecordId || !input.sha256) {
        logger.warn('file-distribution: skipped an unjoinable ledger entry', {
            component: 'file-distribution',
            channel: input.channel,
            hasTenant: Boolean(input.tenantId),
            hasFileRecord: Boolean(input.fileRecordId),
            hasSha256: Boolean(input.sha256),
        });
        return false;
    }

    const details: DistributionDetails = {
        category: 'custom',
        kind: FILE_DISTRIBUTION_KIND,
        channel: input.channel,
        sha256: input.sha256,
        destination: input.destination ?? null,
        contextType: input.contextType ?? null,
        contextId: input.contextId ?? null,
        signedUrlExpiresAt: input.signedUrlExpiresAt ? input.signedUrlExpiresAt.toISOString() : null,
        revocable: !isUnrevocable(input.channel),
    };

    try {
        await appendAuditEntry({
            tenantId: input.tenantId,
            userId: input.actorUserId ?? null,
            actorType: input.actorUserId ? 'USER' : 'SYSTEM',
            entity: 'FileRecord',
            entityId: input.fileRecordId,
            action: FILE_DISTRIBUTED_ACTION,
            detailsJson: details,
        });
        return true;
    } catch (err) {
        logger.error('file-distribution: ledger write failed — the exposure record is now incomplete', {
            component: 'file-distribution',
            channel: input.channel,
            fileRecordId: input.fileRecordId,
            tenantId: input.tenantId,
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return false;
    }
}

/** Record a batch (one export, many files). Never throws. */
export async function recordFileDistributions(inputs: RecordDistributionInput[]): Promise<number> {
    let recorded = 0;
    for (const input of inputs) {
        // guardrail-allow: n+1 — one hash-chained append per file is the point:
        // the per-file entityId is what keeps the later exposure lookup an
        // indexed equality query instead of a JSON scan over batch payloads.
        if (await recordFileDistribution(input)) recorded += 1;
    }
    return recorded;
}

// ─── Reporting ──────────────────────────────────────────────────────

/** One thing that already carried the bytes. */
export interface ExposureArtefact {
    channel: string;
    occurredAt: string;
    recipientUserId: string | null;
    destination: string | null;
    contextType: string | null;
    contextId: string | null;
    revocable: boolean;
    signedUrlExpiresAt: string | null;
    /** A presigned URL that has NOT expired yet — live exposure, right now. */
    signedUrlLive: boolean;
}

export interface FileExposureReport {
    fileRecordId: string;
    sha256: string;
    /** Other rows holding the SAME bytes, whose distributions also count. */
    siblingFileRecordIds: string[];
    totalDistributions: number;
    byChannel: Record<string, number>;
    firstDistributedAt: string | null;
    lastDistributedAt: string | null;
    /** Copies we cannot take back — each needs a human to go and delete it. */
    unrevocableCopies: number;
    /** Signed URLs still working at `assessedAt`. */
    liveSignedUrls: number;
    /**
     * When the last still-live signed URL stops working. This is the bounded
     * half of the exposure story: after this instant, every remaining copy is
     * one of the `unrevocableCopies`.
     */
    signedUrlExposureEndsAt: string | null;
    /** Opaque recipient ids, deduped. */
    recipientUserIds: string[];
    artefacts: ExposureArtefact[];
    /**
     * False when the ledger is known to be a LOWER BOUND: the row cap was hit,
     * or the sibling-hash lookup was truncated. A reader must not read a
     * truncated report as "this is everything".
     */
    exhaustive: boolean;
    assessedAt: string;
}

/** Ledger rows read per assessment. */
export const EXPOSURE_ROW_CAP = 500;
/** FileRecord rows sharing one hash that are followed. */
export const EXPOSURE_SIBLING_CAP = 200;
/** Artefacts listed individually in the report (counts stay exact). */
export const EXPOSURE_ARTEFACT_CAP = 50;

export type LedgerClient = {
    fileRecord: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
    auditLog: {
        findMany: (args: unknown) => Promise<Array<{
            entityId: string;
            userId: string | null;
            createdAt: Date;
            detailsJson: unknown;
        }>>;
    };
};

function readDetails(raw: unknown): Partial<DistributionDetails> {
    if (!raw || typeof raw !== 'object') return {};
    return raw as Partial<DistributionDetails>;
}

/**
 * Answer "what already carried these bytes?" for one file.
 *
 * Reads are tenant-filtered explicitly, on top of RLS.
 */
export async function buildFileExposureReport(opts: {
    tenantId: string;
    fileRecordId: string;
    sha256: string | null | undefined;
    now?: Date;
    /**
     * REQUIRED. There is deliberately no fall-back to the module-level client.
     *
     * These reads are the half of the ledger that RLS can scope, so the caller
     * has to say which connection they run on — a tenant-bound `PrismaTx` from
     * `runInTenantJobContext`, or the global client passed explicitly where no
     * binding exists. An optional parameter let an unbound caller look bound;
     * a required one puts the choice in the diff.
     */
    client: LedgerClient;
}): Promise<FileExposureReport> {
    const client = opts.client;
    const now = opts.now ?? new Date();
    const sha256 = opts.sha256 ?? '';

    // ─── 1. Everything holding the same bytes ───
    let exhaustive = true;
    const ids = new Set<string>([opts.fileRecordId]);
    if (sha256) {
        const siblings = await client.fileRecord.findMany({
            where: { tenantId: opts.tenantId, sha256 },
            select: { id: true },
            take: EXPOSURE_SIBLING_CAP + 1,
        });
        if (siblings.length > EXPOSURE_SIBLING_CAP) exhaustive = false;
        for (const s of siblings.slice(0, EXPOSURE_SIBLING_CAP)) ids.add(s.id);
    }

    // ─── 2. Every egress recorded against any of them ───
    const rows = await client.auditLog.findMany({
        where: {
            tenantId: opts.tenantId,
            action: FILE_DISTRIBUTED_ACTION,
            entityId: { in: [...ids] },
        },
        orderBy: { createdAt: 'asc' },
        take: EXPOSURE_ROW_CAP + 1,
    });
    if (rows.length > EXPOSURE_ROW_CAP) exhaustive = false;
    const ledger = rows.slice(0, EXPOSURE_ROW_CAP);

    // ─── 3. Fold ───
    const byChannel: Record<string, number> = {};
    const recipients = new Set<string>();
    const artefacts: ExposureArtefact[] = [];
    let unrevocableCopies = 0;
    let liveSignedUrls = 0;
    let signedUrlExposureEndsAt: number | null = null;

    for (const row of ledger) {
        const d = readDetails(row.detailsJson);
        const channel = typeof d.channel === 'string' ? d.channel : 'UNKNOWN';
        byChannel[channel] = (byChannel[channel] ?? 0) + 1;
        if (row.userId) recipients.add(row.userId);

        // Fall CLOSED on an unrecognised channel: a ledger entry we cannot
        // classify is treated as a permanent copy, because assuming it expires
        // on its own is the assumption that under-reports exposure.
        const revocable = d.revocable === true && channel !== 'UNKNOWN';
        if (!revocable) unrevocableCopies += 1;

        const expiresAt = typeof d.signedUrlExpiresAt === 'string' ? Date.parse(d.signedUrlExpiresAt) : NaN;
        const live = Number.isFinite(expiresAt) && expiresAt > now.getTime();
        if (live) {
            liveSignedUrls += 1;
            if (signedUrlExposureEndsAt === null || expiresAt > signedUrlExposureEndsAt) {
                signedUrlExposureEndsAt = expiresAt;
            }
        }

        if (artefacts.length < EXPOSURE_ARTEFACT_CAP) {
            artefacts.push({
                channel,
                occurredAt: row.createdAt.toISOString(),
                recipientUserId: row.userId ?? null,
                destination: d.destination ?? null,
                contextType: d.contextType ?? null,
                contextId: d.contextId ?? null,
                revocable,
                signedUrlExpiresAt: typeof d.signedUrlExpiresAt === 'string' ? d.signedUrlExpiresAt : null,
                signedUrlLive: live,
            });
        }
    }

    return {
        fileRecordId: opts.fileRecordId,
        sha256,
        siblingFileRecordIds: [...ids].filter((id) => id !== opts.fileRecordId),
        totalDistributions: ledger.length,
        byChannel,
        firstDistributedAt: ledger.length ? ledger[0].createdAt.toISOString() : null,
        lastDistributedAt: ledger.length ? ledger[ledger.length - 1].createdAt.toISOString() : null,
        unrevocableCopies,
        liveSignedUrls,
        signedUrlExposureEndsAt:
            signedUrlExposureEndsAt === null ? null : new Date(signedUrlExposureEndsAt).toISOString(),
        recipientUserIds: [...recipients],
        artefacts,
        exhaustive,
        assessedAt: now.toISOString(),
    };
}

/**
 * Build the report for a file that has just been quarantined and write it back
 * into the same hash-chained trail, next to the `FILE_QUARANTINED` row.
 *
 * NEVER throws: the quarantine has already committed and must stand on its own.
 * Returns null when the assessment could not be produced.
 */
export async function assessExposureOnInfection(opts: {
    tenantId: string;
    fileRecordId: string;
    sha256: string | null | undefined;
    uploadedByUserId?: string | null;
    engine?: string | null;
    now?: Date;
    client: LedgerClient;
}): Promise<FileExposureReport | null> {
    try {
        const report = await buildFileExposureReport(opts);
        await recordFileExposureReport(report, opts);
        return report;
    } catch (err) {
        logger.error('file-distribution: exposure assessment failed', {
            component: 'file-distribution',
            tenantId: opts.tenantId,
            fileRecordId: opts.fileRecordId,
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return null;
    }
}

/**
 * Write a built report into the hash-chained trail.
 *
 * Split from `assessExposureOnInfection` so a caller that wants the READS
 * tenant-bound can scope them itself and still land the row here. Takes NO
 * client on purpose: `appendAuditEntry` opens its own advisory-locked
 * transaction, and nesting that inside an interactive one holds two pooled
 * connections per file (the #123 precedent — read in one transaction, audit
 * outside any, transition in a second).
 *
 * Throws on failure; `assessExposureOnInfection` is the swallowing wrapper.
 */
export async function recordFileExposureReport(
    report: FileExposureReport,
    opts: {
        tenantId: string;
        fileRecordId: string;
        uploadedByUserId?: string | null;
        engine?: string | null;
    },
): Promise<void> {
    // Even a ZERO-distribution report is worth writing. "Nothing left the
    // platform" is the answer an incident responder most needs and cannot
    // otherwise obtain — an absent row is indistinguishable from an
    // assessment that never ran.
    await appendAuditEntry({
        tenantId: opts.tenantId,
        userId: opts.uploadedByUserId ?? null,
        actorType: 'SYSTEM',
        entity: 'FileRecord',
        entityId: opts.fileRecordId,
        action: FILE_EXPOSURE_ASSESSED_ACTION,
        detailsJson: { category: 'custom', kind: 'file_exposure', engine: opts.engine ?? null, ...report },
    });

    const level = report.totalDistributions > 0 ? 'warn' : 'info';
    logger[level]('file-distribution: exposure assessed for a newly INFECTED file', {
        component: 'file-distribution',
        tenantId: opts.tenantId,
        fileRecordId: opts.fileRecordId,
        totalDistributions: report.totalDistributions,
        unrevocableCopies: report.unrevocableCopies,
        liveSignedUrls: report.liveSignedUrls,
        signedUrlExposureEndsAt: report.signedUrlExposureEndsAt,
        exhaustive: report.exhaustive,
    });
}
