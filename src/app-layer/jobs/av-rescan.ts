/**
 * `av-rescan` — the bounded, one-off catch-up sweep for evidence stuck at
 * `scanStatus: 'PENDING'`.
 *
 * ## Why it exists
 *
 * `isDownloadAllowed` blocks PENDING in `strict` mode, and until the inline
 * upload scan landed nothing ever moved a `FileRecord` off its PENDING
 * default. Every file uploaded before that shipped is therefore un-previewable
 * forever, because the only writer of a verdict is the request that already
 * held the bytes — and that request is long gone. This job re-reads those
 * bytes from storage and finishes the job the upload could not.
 *
 * ## Why it is the most dangerous shape in the AV subsystem
 *
 * It writes verdicts unattended, in bulk, on bytes it did not receive from the
 * user. Everything below is a consequence of that sentence.
 *
 *   - **The synthetic CLEAN must never reach a row.** `scanBuffer`
 *     manufactures `{ status: 'CLEAN', engine: 'disabled' }` when
 *     `CLAMAV_HOST` is unset — a value meant to keep dev and CI usable, not a
 *     verdict. One unattended run on such a box would stamp CLEAN across every
 *     PENDING row in the tenant, and `isDownloadAllowed` serves CLEAN in every
 *     mode, forever, including after the operator switches back to `strict`.
 *     The inline path blocks this twice (a mode check before the call and an
 *     engine check after it) and so does this job: the mode check is the one
 *     that matters in practice, the engine check is what survives someone
 *     later reworking the mode logic.
 *
 *   - **Bytes read back from storage are not the bytes that were uploaded**
 *     until proven so. A truncated or partial read scans as CLEAN — the
 *     scanner is perfectly happy with a prefix — and that CLEAN would be
 *     recorded against the full object. So the SHA-256 is verified against
 *     `FileRecord.sha256` BEFORE the buffer is offered to the scanner, the
 *     same check `bundle-attachments.ts` makes before putting a file into an
 *     export bundle. A mismatch is a storage-integrity incident, not a scan
 *     result: the row stays PENDING and the operator gets a log line.
 *
 *   - **`SKIPPED` is servable**, so it can never be repurposed to mean "too
 *     big to scan" or "the scanner was down". Both of those are "we do not
 *     know", and the honest record of "we do not know" is the PENDING the row
 *     already carries. Writing SKIPPED would publish an unscanned file.
 *
 *   - **Concurrency is a conditional claim, never a lease.** The tempting
 *     design stamps the row (`scanStatus: 'SCANNING'`) before the scan so two
 *     workers do not duplicate it. That trades a duplicated 3-second scan for
 *     a permanent one: a worker killed mid-scan leaves a row that no later run
 *     selects and no gate ever serves. Instead nothing is written until a
 *     verdict exists, and then a single
 *     `updateMany({ where: { id, scanStatus: 'PENDING' } })` settles the race
 *     in the database — the same shape the AV webhook uses. Duplicate work is
 *     the cost; a lost row is not on the table. `scanStatus: 'PENDING'` in the
 *     predicate also means this job can never overwrite an INFECTED verdict or
 *     a fresher one another writer landed while we were scanning.
 *
 *   - **The verdict is written BEFORE the audit row** — the inverse of the
 *     inline upload path, for the opposite reason. There, the file is refused
 *     and never stored, so the audit entry is the ONLY record it existed;
 *     losing it to a crash loses the event. Here the row persists either way,
 *     and the failure worth avoiding is the mirror image: an audit trail
 *     asserting a verdict that a crash stopped us persisting. Auditing after
 *     the claim also means we only audit the writes we actually won.
 *
 *   - **Nothing is scanned inside a tenant transaction.** clamd's timeout is
 *     30 s; a transaction held open across it pins a Postgres backend (and,
 *     through PgBouncer's transaction pooling, a pooled server connection) for
 *     the duration, once per file. The scan is an out-of-process round trip
 *     that has no business inside a database transaction.
 *
 *   - **Provenance is stamped in `scanDetails`.** A row that says CLEAN should
 *     say who decided that. `source: 'rescan-job'` distinguishes these
 *     verdicts from `inline-upload` ones at a glance, which is what an
 *     operator needs when a rescan turns out to have been run against a
 *     misconfigured scanner.
 *
 * ## Bounded
 *
 * One tenant, one page of rows, `take` always present. This is an operator
 * tool run deliberately, not a cron — it is registered on-demand in the
 * executor registry and is not in `schedules.ts`. Re-run it until
 * `scanned` comes back zero.
 */
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { env } from '@/env';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { getProviderByName } from '@/lib/storage';
import { scanBuffer } from '@/lib/storage/av-scan';
import { AV_SCAN_MAX_BYTES } from '@/app-layer/services/file-scan';
import { computeSha256, streamToBuffer } from '@/app-layer/services/bundle-attachments';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import type { StorageProviderType } from '@/lib/storage/types';

// ─── Bounds ─────────────────────────────────────────────────────────

/** Rows examined per run when the caller does not say otherwise. */
export const AV_RESCAN_DEFAULT_LIMIT = 200;

/**
 * Hard ceiling on a single run, applied to whatever the caller asks for.
 *
 * Each row costs a full object read plus a clamd round trip, so an
 * unbounded run is a self-inflicted outage on both storage and the scanner.
 * The operator re-runs the job instead; it is idempotent by construction —
 * a row that got a verdict is no longer PENDING and is no longer selected.
 */
export const AV_RESCAN_MAX_LIMIT = 1_000;

// ─── Contract ───────────────────────────────────────────────────────

export interface AvRescanOptions {
    /** REQUIRED. The sweep is deliberately single-tenant. */
    tenantId: string;
    /** Operator who triggered the run — the actor on every audit row. */
    initiatedByUserId: string;
    /** Rows to examine this run. Clamped to `AV_RESCAN_MAX_LIMIT`. */
    limit?: number;
    /** Log-correlation id from the triggering request, when there was one. */
    requestId?: string;
}

/**
 * Outcome counters.
 *
 * `clean + infected` are the rows this run gave a verdict. `leftPending` is
 * every row we deliberately did NOT stamp, broken down by reason below — the
 * reasons sum to it exactly. `lostClaim` is counted apart: those rows are not
 * pending any more, another writer simply got there first.
 */
export interface AvRescanResult {
    tenantId: string;
    jobRunId: string;
    /** Rows selected and considered this run. */
    scanned: number;
    clean: number;
    infected: number;
    leftPending: number;
    /** Bytes read back did not match `FileRecord.sha256`. */
    integrityMismatch: number;
    /** Declared size above the clamd stream cap — never read, never scanned. */
    oversize: number;
    /** Scanner unreachable / timed out / unparseable. */
    scannerError: number;
    /** Object could not be read from storage at all. */
    readError: number;
    /** A `CLEAN` from `engine: 'disabled'` — refused, never persisted. */
    refusedSyntheticClean: number;
    /** Row was no longer PENDING when the claim ran. */
    lostClaim: number;
    durationMs: number;
}

// ─── Job ────────────────────────────────────────────────────────────

export async function runAvRescan(options: AvRescanOptions): Promise<AvRescanResult> {
    return runJob(
        'av-rescan',
        async () => {
            const jobRunId = crypto.randomUUID();
            const started = Date.now();
            const { tenantId } = options;

            const out: AvRescanResult = {
                tenantId,
                jobRunId,
                scanned: 0,
                clean: 0,
                infected: 0,
                leftPending: 0,
                integrityMismatch: 0,
                oversize: 0,
                scannerError: 0,
                readError: 0,
                refusedSyntheticClean: 0,
                lostClaim: 0,
                durationMs: 0,
            };

            // ── Guard 1 of 2 against the synthetic CLEAN ──────────────
            //
            // In `disabled` mode `scanBuffer` never contacts a scanner and
            // returns a fabricated CLEAN. Persisting that across a whole
            // tenant is the single worst thing this job could do, so it does
            // not even enumerate rows: no read, no scan, no write.
            if (env.AV_SCAN_MODE === 'disabled') {
                logger.warn('av-rescan refused to run: AV_SCAN_MODE is disabled', {
                    component: 'av-rescan',
                    tenantId,
                    jobRunId,
                });
                out.durationMs = Date.now() - started;
                return out;
            }

            const take = Math.max(
                1,
                Math.min(options.limit ?? AV_RESCAN_DEFAULT_LIMIT, AV_RESCAN_MAX_LIMIT),
            );

            const rows = await prisma.fileRecord.findMany({
                where: {
                    tenantId,
                    scanStatus: 'PENDING',
                    status: 'STORED',
                    deletedAt: null,
                },
                select: {
                    id: true,
                    pathKey: true,
                    sha256: true,
                    sizeBytes: true,
                    storageProvider: true,
                    originalName: true,
                },
                orderBy: { createdAt: 'asc' },
                take,
            });

            out.scanned = rows.length;

            for (const row of rows) {
                // ── Too big to scan is not "safe" ────────────────────
                //
                // clamd aborts past its own StreamMaxLength, so the round
                // trip would end in an ERROR anyway. Reaching that state
                // locally, without moving the bytes, is the same outcome for
                // less money. The row stays PENDING; SKIPPED would make it
                // servable.
                if (row.sizeBytes > AV_SCAN_MAX_BYTES) {
                    out.oversize++;
                    out.leftPending++;
                    logger.warn('av-rescan left a file pending: exceeds scan cap', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        sizeBytes: row.sizeBytes,
                        capBytes: AV_SCAN_MAX_BYTES,
                    });
                    continue;
                }

                // ── Read the object ─────────────────────────────────
                //
                // Read via the provider the row was WRITTEN with, not the
                // configured default — a tenant mid-migration has rows on
                // both.
                let buffer: Buffer;
                try {
                    const provider = getProviderByName(
                        row.storageProvider as StorageProviderType,
                    );
                    buffer = await streamToBuffer(provider.readStream(row.pathKey));
                } catch (err) {
                    out.readError++;
                    out.leftPending++;
                    logger.warn('av-rescan could not read an object; leaving it pending', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                // ── Byte identity, BEFORE the scanner sees the bytes ──
                //
                // A truncated read scans CLEAN, and that CLEAN would be
                // recorded against the whole object. Mirrors the check
                // `bundle-attachments.ts` makes before an export bundle
                // accepts a file. A mismatch is a storage incident: it is
                // reported, and the row keeps its honest PENDING.
                const actualHash = computeSha256(buffer);
                if (actualHash !== row.sha256) {
                    out.integrityMismatch++;
                    out.leftPending++;
                    logger.error('av-rescan: stored bytes do not match the record digest', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        expectedSha256: row.sha256,
                        actualSha256: actualHash,
                        expectedBytes: row.sizeBytes,
                        actualBytes: buffer.length,
                    });
                    continue;
                }

                // ── Scan. Outside every transaction, by construction —
                // there is no transaction open anywhere in this loop.
                const result = await scanBuffer(buffer);

                if (result.status === 'ERROR') {
                    out.scannerError++;
                    out.leftPending++;
                    logger.warn('av-rescan: scan did not complete; leaving file pending', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        engine: result.engine,
                    });
                    continue;
                }

                // ── Guard 2 of 2 against the synthetic CLEAN ──────────
                //
                // Unreachable while the mode check above stands, which is
                // exactly why it is here: it is what still refuses the
                // fabricated verdict after someone reworks the mode logic.
                if (result.engine === 'disabled') {
                    out.refusedSyntheticClean++;
                    out.leftPending++;
                    logger.error('av-rescan refused a synthetic CLEAN from engine "disabled"', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                    });
                    continue;
                }

                const verdict: 'CLEAN' | 'INFECTED' =
                    result.status === 'INFECTED' ? 'INFECTED' : 'CLEAN';

                // ── Claim + verdict, one statement ───────────────────
                //
                // The predicate is the concurrency control. No row was
                // touched before this point, so a crash anywhere above
                // leaves the row exactly as a later run needs to find it.
                // `scanStatus` is the ONLY column written here: quarantine
                // (`status`) belongs to the webhook path, and this job must
                // never be the thing that flips it.
                const claimed = await prisma.fileRecord.updateMany({
                    where: { id: row.id, scanStatus: 'PENDING' },
                    data: {
                        scanStatus: verdict,
                        scanDetails: JSON.stringify({
                            engine: result.engine,
                            durationMs: result.durationMs,
                            threat: result.threat ?? null,
                            source: 'rescan-job',
                            jobRunId,
                        }),
                        scannedAt: new Date(),
                    },
                });

                if (claimed.count === 0) {
                    // Another writer landed a verdict while we were scanning
                    // (upload retry, AV webhook, a sibling run). Theirs
                    // stands — ours is discarded without an audit row,
                    // because we did not write anything to audit.
                    out.lostClaim++;
                    logger.info('av-rescan: row was no longer pending at claim time', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        attemptedStatus: verdict,
                    });
                    continue;
                }

                if (verdict === 'INFECTED') out.infected++;
                else out.clean++;

                // ── Audit AFTER the verdict is durable ───────────────
                //
                // Infections reuse the action string the webhook and the
                // inline upload path already write, so one SIEM rule catches
                // a quarantine no matter which of the three found it.
                await appendAuditEntry({
                    tenantId,
                    userId: options.initiatedByUserId,
                    actorType: 'SYSTEM',
                    entity: 'FileRecord',
                    entityId: row.id,
                    action: verdict === 'INFECTED' ? 'FILE_QUARANTINED' : 'FILE_RESCANNED',
                    details: null,
                    metadataJson: {
                        jobRunId,
                        scanStatus: verdict,
                        engine: result.engine,
                        threat: result.threat ?? null,
                        sizeBytes: row.sizeBytes,
                        source: 'rescan-job',
                    },
                    requestId: options.requestId ?? null,
                });
            }

            out.durationMs = Date.now() - started;

            logger.info('av-rescan.complete', {
                component: 'av-rescan',
                tenantId,
                jobRunId,
                scanned: out.scanned,
                clean: out.clean,
                infected: out.infected,
                leftPending: out.leftPending,
                integrityMismatch: out.integrityMismatch,
                oversize: out.oversize,
                scannerError: out.scannerError,
                readError: out.readError,
                refusedSyntheticClean: out.refusedSyntheticClean,
                lostClaim: out.lostClaim,
                durationMs: out.durationMs,
            });

            return out;
        },
        { tenantId: options.tenantId },
    );
}
