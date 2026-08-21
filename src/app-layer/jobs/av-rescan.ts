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
 *   - **A row that cannot reach a verdict must not hold the page.** The
 *     bullets above all end the same way: the row keeps its honest PENDING.
 *     That is right, and on its own it starves the queue — the sweep is
 *     bounded and ordered oldest-first, so a handful of rows whose object is
 *     gone from storage or whose bytes no longer match their digest sit at
 *     the head of every future page and nothing behind them is ever examined.
 *     The backlog not draining is the user-visible complaint this whole chain
 *     exists to fix. So each row we leave PENDING gets an ATTEMPT recorded
 *     against it — `scanAttempts` / `lastScanAttemptAt` / `nextScanAttemptAt`,
 *     columns disjoint from the verdict ones — and the selection skips a row
 *     until its exponential backoff expires and orders fewest-attempts first.
 *     The attempt write is a SEPARATE statement from the verdict write and
 *     never shares one: `FileRepository.recordScanAttempt` refuses at runtime
 *     to touch `scanStatus`, `scanDetails`, `scannedAt` or `status`. A row
 *     that DOES reach a verdict is written exactly as it was before — no
 *     attempt bookkeeping rides along, because a verdict makes the row
 *     unselectable anyway and the counter would only be noise.
 *
 *   - **A row that cannot reach a verdict must not abort the page either.**
 *     The bullet above covers a row that FAILS; this one covers a row that
 *     explodes. `scanBuffer` returning `{ status: 'ERROR' }` is a handled
 *     outcome, but it can also *throw* — a socket reset mid-INSTREAM, a
 *     payload that kills the parser, a DNS failure on the clamd host. An
 *     unhandled throw propagates out of the loop and out of `runJob`, so one
 *     poison row stops every row behind it on this run AND on every future
 *     run, because nothing was written that would change which page is
 *     selected next time. The throw is therefore caught per row and treated
 *     as exactly what it is: no verdict. The row keeps its honest PENDING and
 *     gets the same attempt record as every other leave-pending branch. It is
 *     counted apart from `scannerError` — "the scanner answered ERROR forty
 *     times" and "the scanner blew up forty times" are different pages of the
 *     runbook.
 *
 *   - **An abnormal INFECTED proportion halts the run.** This job condemns
 *     files unattended, and `INFECTED` is terminal for a download: the only
 *     way back is an OWNER walking
 *     `POST /api/t/:slug/admin/files/:fileId/clear-quarantine` file by file.
 *     A rescan that flips a large fraction of a tenant's library is far more
 *     likely to be a bad signature update than an outbreak, so once enough
 *     files have a verdict to make the ratio mean anything
 *     (`AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS` — an ABSOLUTE floor, so a
 *     three-file tenant with one real infection can never trip it) the run
 *     stops as soon as the infected share crosses
 *     `AV_RESCAN_INFECTION_BREAKER_RATIO`. Verdicts already written are LEFT
 *     ALONE — a job that condemned a file wrongly has no better claim to be
 *     right when it un-condemns it, and the reversal path is a deliberate,
 *     audited, reason-carrying admin action. The halt is announced as its own
 *     log event and its own audit row, and names the reversal route: a silent
 *     halt is indistinguishable from a clean finish, which is the same
 *     absence problem as a silent success.
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
import type { ScanResult } from '@/lib/storage/av-scan';
import { AV_SCAN_MAX_BYTES } from '@/app-layer/services/file-scan';
import { computeSha256, streamToBuffer } from '@/app-layer/services/bundle-attachments';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
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

/**
 * How many rows must reach a VERDICT before the infection ratio is allowed to
 * mean anything.
 *
 * An ABSOLUTE floor, and it is the half of the breaker that stops it being
 * actively harmful. A ratio on its own halts a three-file tenant with one
 * genuine infection at 33%, and a one-file tenant at 100% — turning a working
 * scan into an operator ticket every time. Below this count the run simply
 * does not evaluate the breaker.
 */
export const AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS = 20;

/**
 * The infected share of settled rows that halts the run.
 *
 * Chosen high rather than sensitive. The signal being caught is a bad
 * signature update, which condemns essentially everything it looks at, so the
 * true positive sits near 1.0 and there is nothing to gain from crowding a
 * real outbreak. Halting is not free: every row behind the breaker stays
 * PENDING and un-previewable until an operator decides, so a jumpy threshold
 * trades one library-wide failure for a recurring one.
 */
export const AV_RESCAN_INFECTION_BREAKER_RATIO = 0.5;

/**
 * What an operator should do about a halt, carried on the log line, the audit
 * row and the returned result.
 *
 * A halt that only says "stopped" leaves the reader to discover on their own
 * that the rows already condemned are recoverable, and how. The reversal path
 * shipped with the un-quarantine route; naming it here is the difference
 * between a halt that is actionable and one that is alarming.
 */
export const AV_RESCAN_HALT_REMEDIATION =
    'Verdicts already written were left in place. Verify the ClamAV signature ' +
    'database before re-running; clear any false positive with POST ' +
    '/api/t/:slug/admin/files/:fileId/clear-quarantine (OWNER only).';

/** Why a run stopped before it reached the end of its page. */
export type AvRescanHaltReason = 'infection-ratio';

/**
 * The breaker predicate, kept apart from the loop so it can be reasoned about
 * (and tested) without a page of rows around it.
 *
 * The denominator is SETTLED rows — the ones that actually reached a verdict —
 * not rows examined. A page half of which could not be read from storage says
 * nothing either way about whether the signature is sound, and folding those
 * in would let a storage outage silently suppress a breaker that should have
 * fired.
 */
export function infectionBreakerTripped(counts: { clean: number; infected: number }): boolean {
    const settled = counts.clean + counts.infected;
    if (settled < AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS) return false;
    return counts.infected / settled > AV_RESCAN_INFECTION_BREAKER_RATIO;
}

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
    /**
     * Rows actually EXAMINED this run — incremented as the loop reaches each
     * one, not set from the page size up front. The two are the same number
     * unless the run halted early, and when it did, reporting the page size
     * would credit the run with rows it never looked at.
     */
    scanned: number;
    clean: number;
    infected: number;
    leftPending: number;
    /** Bytes read back did not match `FileRecord.sha256`. */
    integrityMismatch: number;
    /** Declared size above the clamd stream cap — never read, never scanned. */
    oversize: number;
    /** Scanner answered `ERROR` — unreachable / timed out / unparseable. */
    scannerError: number;
    /**
     * Scanner THREW rather than answering. Counted apart from `scannerError`
     * because it is a different page of the runbook: an ERROR is clamd saying
     * it could not do the job, a throw is the call itself coming apart.
     */
    scannerThrew: number;
    /** Object could not be read from storage at all. */
    readError: number;
    /** A `CLEAN` from `engine: 'disabled'` — refused, never persisted. */
    refusedSyntheticClean: number;
    /** Row was no longer PENDING when the claim ran. */
    lostClaim: number;
    /**
     * Rows left PENDING that had an attempt recorded and a backoff applied,
     * so the page they were holding is now free for the rows behind them.
     * Equals `leftPending` minus the handful whose attempt write lost its own
     * race (a verdict landed between the scan and the bookkeeping).
     */
    backedOff: number;
    /**
     * True when the run stopped before the end of its page. Distinct from a
     * clean finish on purpose — `scanned < limit` alone is also what a small
     * tenant looks like.
     */
    halted: boolean;
    /** Why it halted, `null` when it did not. */
    haltReason: AvRescanHaltReason | null;
    /** What to do about the halt, `null` when there was none. */
    haltRemediation: string | null;
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
                scannerThrew: 0,
                readError: 0,
                refusedSyntheticClean: 0,
                lostClaim: 0,
                backedOff: 0,
                halted: false,
                haltReason: null,
                haltRemediation: null,
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

            // ── Select only what is DUE ──────────────────────────────
            //
            // `scanStatus: 'PENDING'` is the honest record of "no verdict",
            // not a work queue: a row whose object is missing or whose bytes
            // no longer match its digest is permanently PENDING and, ordered
            // oldest-first under a `take`, would hold the head of every
            // future page. The backoff gate is what lets the queue move past
            // it, and the attempts-first ordering is what stops a
            // much-retried row outranking one never tried. `NULL` means
            // never attempted — every row that predates this ships as due.
            const now = new Date();
            const rows = await prisma.fileRecord.findMany({
                where: {
                    tenantId,
                    scanStatus: 'PENDING',
                    status: 'STORED',
                    deletedAt: null,
                    OR: [{ nextScanAttemptAt: null }, { nextScanAttemptAt: { lte: now } }],
                },
                select: {
                    id: true,
                    pathKey: true,
                    sha256: true,
                    sizeBytes: true,
                    storageProvider: true,
                    originalName: true,
                    scanAttempts: true,
                },
                orderBy: [{ scanAttempts: 'asc' }, { createdAt: 'asc' }],
                take,
            });


            /**
             * Leave a row PENDING and stop it holding the page.
             *
             * Two writes exist in this job and they are kept apart on
             * purpose. The verdict write below says what the scanner decided;
             * this one says only that we tried, in columns no gate and no
             * auditor reads. It is guarded by `scanStatus: 'PENDING'` for the
             * same reason the verdict write is — if another writer landed a
             * verdict while we were scanning, theirs stands and our attempt
             * counter has no business touching the row.
             *
             * A failure here is swallowed: the bookkeeping is an
             * optimisation of WHEN the row is retried, and losing it must
             * never cost the operator the rest of the page.
             */
            const leavePending = async (row: { id: string; scanAttempts: number }) => {
                out.leftPending++;
                try {
                    const attempts = await FileRepository.recordScanAttempt(prisma, row.id, {
                        tenantId,
                        attempts: row.scanAttempts,
                        now: new Date(),
                    });
                    if (attempts !== null) out.backedOff++;
                } catch (err) {
                    logger.warn('av-rescan could not record a scan attempt', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            };

            for (const row of rows) {
                // Counted HERE, not from `rows.length` before the loop: a run
                // that halts early must not claim credit for the rows it
                // never looked at.
                out.scanned++;

                // ── Too big to scan is not "safe" ────────────────────
                //
                // clamd aborts past its own StreamMaxLength, so the round
                // trip would end in an ERROR anyway. Reaching that state
                // locally, without moving the bytes, is the same outcome for
                // less money. The row stays PENDING; SKIPPED would make it
                // servable.
                if (row.sizeBytes > AV_SCAN_MAX_BYTES) {
                    out.oversize++;
                    await leavePending(row);
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
                    await leavePending(row);
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
                    await leavePending(row);
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
                //
                // The try/catch is the whole point. `scanBuffer` has two ways
                // of failing and only one of them is a return value: a socket
                // reset mid-INSTREAM, a DNS failure on the clamd host or a
                // payload that kills the response parser all THROW. Uncaught,
                // that throw leaves the loop, leaves `runJob`, and takes every
                // row behind this one with it — on this run and on every run
                // after, since nothing was written that would change which
                // page gets selected next time. One poison row is not allowed
                // to be a permanent outage of the sweep.
                let result: ScanResult;
                try {
                    result = await scanBuffer(buffer);
                } catch (err) {
                    // A throw is not a verdict, and it is not `SKIPPED`
                    // either. The row keeps its honest PENDING and takes the
                    // same attempt record every other leave-pending branch
                    // takes, so the backoff moves it out of the way.
                    out.scannerThrew++;
                    await leavePending(row);
                    logger.error('av-rescan: the scanner threw; leaving file pending', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        fileId: row.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                if (result.status === 'ERROR') {
                    out.scannerError++;
                    await leavePending(row);
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
                    await leavePending(row);
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

                // ── Circuit breaker ──────────────────────────────────
                //
                // Evaluated only after the row is fully settled — verdict
                // durable, audit row written — so the halt never orphans a
                // half-finished row.
                //
                // Verdicts already written are LEFT ALONE. Rolling them back
                // is tempting and wrong: the same run that condemned them is
                // the one now saying it does not trust itself, and it would
                // be reversing an INFECTED verdict unattended, with no reason
                // string and no human deciding — precisely the shape the
                // clear-quarantine route exists to avoid. The rows BEHIND the
                // breaker are untouched, including their attempt counters:
                // they were never examined, so they have not earned a backoff
                // and must come back on the next run at full priority.
                if (infectionBreakerTripped(out)) {
                    out.halted = true;
                    out.haltReason = 'infection-ratio';
                    out.haltRemediation = AV_RESCAN_HALT_REMEDIATION;

                    // Its OWN log event, not a field on the completion line.
                    // A halt and a clean finish are the same shape from the
                    // outside — both stop early relative to the page, both
                    // return a result — so the difference has to be
                    // something an alert can match on.
                    logger.error('av-rescan.halted', {
                        component: 'av-rescan',
                        tenantId,
                        jobRunId,
                        haltReason: out.haltReason,
                        scanned: out.scanned,
                        infected: out.infected,
                        clean: out.clean,
                        selected: rows.length,
                        notExamined: rows.length - out.scanned,
                        ratio: out.infected / (out.infected + out.clean),
                        thresholdRatio: AV_RESCAN_INFECTION_BREAKER_RATIO,
                        minVerdicts: AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS,
                        remediation: AV_RESCAN_HALT_REMEDIATION,
                    });

                    // And an audit row, so the halt reaches the SIEM stream
                    // alongside the `FILE_QUARANTINED` rows it is casting
                    // doubt on. Anchored on the tenant rather than a file —
                    // the subject is the run, not any one row.
                    await appendAuditEntry({
                        tenantId,
                        userId: options.initiatedByUserId,
                        actorType: 'SYSTEM',
                        entity: 'Tenant',
                        entityId: tenantId,
                        action: 'AV_RESCAN_HALTED',
                        details: null,
                        metadataJson: {
                            jobRunId,
                            haltReason: out.haltReason,
                            scanned: out.scanned,
                            infected: out.infected,
                            clean: out.clean,
                            selected: rows.length,
                            thresholdRatio: AV_RESCAN_INFECTION_BREAKER_RATIO,
                            minVerdicts: AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS,
                            remediation: AV_RESCAN_HALT_REMEDIATION,
                        },
                        requestId: options.requestId ?? null,
                    });

                    break;
                }
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
                scannerThrew: out.scannerThrew,
                lostClaim: out.lostClaim,
                backedOff: out.backedOff,
                halted: out.halted,
                haltReason: out.haltReason,
                durationMs: out.durationMs,
            });

            return out;
        },
        { tenantId: options.tenantId },
    );
}
