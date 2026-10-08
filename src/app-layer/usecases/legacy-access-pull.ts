/**
 * Pulling a legacy access snapshot: complete and verifiable, or visibly not
 * complete.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER OF WRITES IS THE SAFETY PROPERTY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The snapshot row is created `PENDING`, every account is written, and only then
 * is it marked `COMPLETE`. Nothing has to RUN in order for a failure to be
 * recorded — a crash, an OOM, a killed worker, a lost database connection all
 * leave a `PENDING` row, and every reader filters on `COMPLETE`. The absence of a
 * transition is the failure signal.
 *
 * That is why `COMPLETE` is a separate final `update` rather than a field set in
 * the same transaction as the account writes. One big transaction would be
 * ATOMIC, which sounds stronger and is weaker here: it would leave nothing at all
 * behind on a crash, and "no snapshot" is indistinguishable from "the job never
 * ran". A `PENDING` row says somebody tried and did not finish.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE ROW BOUND IS AUTHORITATIVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * {@link LEGACY_SNAPSHOT_MAX_ACCOUNTS} lives HERE, not in the transport. The MCP
 * client carries a `MAX_TOTAL_ROWS` default and it is a backstop: how many
 * accounts a snapshot may hold is a product decision about what this product will
 * store and ask a human to review, and a transport module is the wrong place to
 * hold a policy it cannot explain. The client's default stays as the last line of
 * defence for a caller that forgets to pass one.
 *
 * @module app-layer/usecases/legacy-access-pull
 */

import type { LegacyAccessRefusalReason, Prisma } from '@prisma/client';

import { buildSystemContext } from '@/app-layer/context-system';
import {
    SYNC_BOOKKEEPING_TX_OPTIONS,
    SYNC_WRITE_TX_OPTIONS,
} from '@/app-layer/integrations/sync-transaction';
import { acquireSyncLock, releaseSyncLock } from '@/app-layer/integrations/connection-lock';
import { markAuthFailure } from '@/app-layer/integrations/connection-health';
import { IntegrationAuthError } from '@/app-layer/integrations/http-resilience';
import { LEGACY_MCP_PROVIDER_ID } from '@/app-layer/integrations/providers/legacy-mcp';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { pullSnapshot, type LegacyMcpClientError } from '@/lib/mcp/client';
import {
    PAYLOAD_HASH_ALGORITHM_VERSION,
    computePayloadHash,
    projectedColumns,
    type CanonicalAccount,
    type StoredMapping,
} from '@/lib/legacy-access/canonical';
import {
    LegacyIngestError,
    assertNoSchemaDrift,
    mapRows,
    type IngestOutcome,
} from '@/lib/legacy-access/ingest';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { enqueue } from '@/app-layer/jobs/queue';
import { notFound } from '@/lib/errors/types';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { assertCanAdmin } from '../policies/common';
import { readStoredMapping } from './legacy-access-mapping';

/**
 * The most accounts one snapshot may hold.
 *
 * A product bound, not a transport one — see the module docblock. Chosen as the
 * point past which a recertification campaign stops being a thing a human can
 * complete: a reviewer confirming one account every ten seconds would need over
 * five working days for 20,000, so a snapshot larger than this is evidence the
 * connection is pointed at the wrong table rather than at an application's access
 * list.
 */
export const LEGACY_SNAPSHOT_MAX_ACCOUNTS = 50_000;

/** One account write batch. Bounded so a tx budget binds a known amount of work. */
const ACCOUNT_WRITE_CHUNK = 500;

export interface LegacyPullInput {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly triggeredBy?: string;
}

export interface LegacyPullResult {
    readonly executionId: string | null;
    readonly snapshotId: string | null;
    /** `SKIPPED_LOCKED` means another pull holds the connection lock. */
    readonly status: 'COMPLETE' | 'PARTIAL' | 'SKIPPED_LOCKED' | 'NOT_APPLICABLE';
    readonly rowCount: number;
    readonly payloadHash: string | null;
    readonly refusalReason: LegacyAccessRefusalReason | null;
    readonly refusalDetail: string | null;
    readonly overshared: readonly string[];
}

/** Transport failure kind → the reason recorded on the snapshot. */
const TRANSPORT_REASONS: Readonly<Record<LegacyMcpClientError['kind'], LegacyAccessRefusalReason>> = {
    'authentication-failed': 'AUTHENTICATION_FAILED',
    'ssrf-blocked': 'SSRF_BLOCKED',
    timeout: 'TIMEOUT',
    'contract-violation': 'CONTRACT_VIOLATION',
    'cap-exceeded': 'CAP_EXCEEDED',
    'torn-snapshot': 'TORN_SNAPSHOT',
};

/**
 * Run one pull.
 *
 * Never called inside a request — the admin route enqueues the job that calls
 * this. A pull dials a customer-hosted server, pages until it has the whole
 * table, and writes thousands of rows; doing that on a request thread means an
 * HTTP timeout decides whether a snapshot is complete.
 */
export async function runLegacyAccessPull(input: LegacyPullInput): Promise<LegacyPullResult> {
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'legacy-access-pull' });
    const bookkeeping = <T>(fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
        runInTenantContext(ctx, fn, SYNC_BOOKKEEPING_TX_OPTIONS);

    // One pull at a time per connection. Re-enqueuing a running pull does
    // nothing — two concurrent pulls would each open a snapshot against the same
    // remote snapshot id and each believe it had the whole table.
    const lockToken = await bookkeeping((db) => acquireSyncLock(db, input.connectionId));
    if (!lockToken) {
        // A null token has TWO causes and they need different responses.
        // `acquireSyncLock` claims the lock with a conditional `updateMany` keyed
        // on the connection id, so it returns null both when the lock is genuinely
        // held AND when no such connection exists — and its own log line says
        // "sync already running" either way. Reporting SKIPPED_LOCKED for a deleted
        // connection would leave an operator waiting out a 30-minute lease that
        // will never clear, so the cause is resolved here rather than guessed.
        const exists = await bookkeeping((db) =>
            db.integrationConnection.count({
                where: { id: input.connectionId, tenantId: ctx.tenantId },
            })
        );
        if (exists === 0) {
            logger.info('legacy access pull skipped — no such connection', {
                component: 'legacy-access',
                connectionId: input.connectionId,
            });
            return emptyResult('NOT_APPLICABLE');
        }
        logger.info('legacy access pull skipped — connection lock held', {
            component: 'legacy-access',
            connectionId: input.connectionId,
        });
        return emptyResult('SKIPPED_LOCKED');
    }

    try {
        return await pullUnderLock(ctx, input, bookkeeping);
    } finally {
        // `finally`, so a throw releases the lock rather than wedging the
        // connection until the lease expires.
        await bookkeeping((db) => releaseSyncLock(db, input.connectionId, lockToken));
    }
}

async function pullUnderLock(
    ctx: RequestContext,
    input: LegacyPullInput,
    bookkeeping: <T>(fn: (db: PrismaTx) => Promise<T>) => Promise<T>
): Promise<LegacyPullResult> {
    const now = new Date();

    // ── 1. Open the run, before any network read ────────────────────────────
    // Committed first on purpose: from here on there is a row on disk saying
    // this pull started, whatever happens next.
    const opened = await bookkeeping(async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: input.connectionId, tenantId: ctx.tenantId },
            select: { id: true, provider: true, configJson: true, secretEncrypted: true },
        });
        const execution = await db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                connectionId: conn?.id,
                provider: conn?.provider ?? LEGACY_MCP_PROVIDER_ID,
                automationKey: `${LEGACY_MCP_PROVIDER_ID}.pull`,
                status: conn ? 'RUNNING' : 'ERROR',
                errorMessage: conn ? undefined : 'Legacy access connection not found',
                triggeredBy: input.triggeredBy ?? 'scheduled',
                executedAt: now,
                ...(conn ? {} : { completedAt: now }),
            },
        });
        return { conn, executionId: execution.id };
    });

    const { conn, executionId } = opened;
    if (!conn) {
        return { ...emptyResult('NOT_APPLICABLE'), executionId };
    }

    // ── 2. The mapping ──────────────────────────────────────────────────────
    // An absent or unusable mapping produces NO snapshot. A snapshot row is
    // evidence of a pull ATTEMPT against a remote table, and this path never
    // dials — recording one would claim we looked. The execution row is where
    // "a pass ran and refused" is recorded in this codebase, as it is for the
    // identity leaver pass's NOT_APPLICABLE outcomes.
    const mapping = readStoredMapping(conn.configJson);
    if (!mapping) {
        await failExecution(bookkeeping, executionId, 'No legacy access mapping is saved for this connection');
        return { ...emptyResult('NOT_APPLICABLE'), executionId, refusalReason: 'MAPPING_MISSING' };
    }

    const config = (conn.configJson ?? {}) as Record<string, unknown>;
    const url = typeof config.endpointUrl === 'string' ? config.endpointUrl.trim() : '';
    const secrets = readSecrets(conn.secretEncrypted);
    const token = typeof secrets.bearerToken === 'string' ? secrets.bearerToken.trim() : '';
    if (!url || !token) {
        await failExecution(bookkeeping, executionId, 'Connection is missing its endpoint or bearer token');
        return { ...emptyResult('NOT_APPLICABLE'), executionId, refusalReason: 'MAPPING_MISSING' };
    }

    // ── 3. Read ─────────────────────────────────────────────────────────────
    // `fields` is the projection derived from the mapping, which is the
    // mechanism behind "a sensitive column never leaves the legacy network".
    const pull = await pullSnapshot({
        url,
        token,
        fields: projectedColumns(mapping),
        maxTotalRows: LEGACY_SNAPSHOT_MAX_ACCOUNTS,
    });

    if (pull.reason?.kind === 'authentication-failed') {
        // Converted to `IntegrationAuthError` deliberately: `markAuthFailure`
        // no-ops on any other class, so handing it the client's own error would
        // read as correct and do nothing. `invalid_token` is an RFC 6749 code
        // from a fixed set — never the server's own message, which that field's
        // docblock forbids because it is persisted verbatim.
        await bookkeeping((db) =>
            markAuthFailure(
                db,
                conn.id,
                new IntegrationAuthError(401, url, 'invalid_token'),
                new Date(),
                conn.provider
            )
        );
    }

    // ── 4. Drift, before anything is stored ─────────────────────────────────
    // `.map(c => c.name)` — a manifest column is `{ name, type, nullable }`, not a
    // string. The fingerprint and the mapping both speak in NAMES.
    const observedColumns = (pull.manifest?.columns ?? []).map((c) => c.name);
    let ingest: IngestOutcome;
    try {
        if (!pull.manifest) {
            throw new LegacyIngestError(
                'ROW_SCHEMA_INVALID',
                'the server returned no readable manifest, so there is no column set to check'
            );
        }
        assertNoSchemaDrift(mapping, observedColumns);
        assertLayoutAgrees(mapping, pull.manifest.layout);
        if (!pull.complete) {
            const reason = pull.reason ? TRANSPORT_REASONS[pull.reason.kind] : 'INCOMPLETE_READ';
            return await recordRefusal(ctx, bookkeeping, {
                conn,
                executionId,
                mapping,
                observedColumns,
                rowsReceived: pull.rows.length,
                reason,
                // OUR message, not the server's. The client builds these from
                // counts and fixed phrases for exactly this reason.
                detail: pull.reason?.message ?? 'the read did not cover every advertised page',
            });
        }
        ingest = mapRows(mapping, pull.rows as readonly Record<string, unknown>[], observedColumns);
    } catch (err) {
        if (err instanceof LegacyIngestError) {
            return await recordRefusal(ctx, bookkeeping, {
                conn,
                executionId,
                mapping,
                observedColumns,
                rowsReceived: pull.rows.length,
                reason: err.refusal,
                detail: err.detail,
            });
        }
        throw err;
    }

    if (ingest.accounts.length > LEGACY_SNAPSHOT_MAX_ACCOUNTS) {
        return await recordRefusal(ctx, bookkeeping, {
            conn,
            executionId,
            mapping,
            observedColumns,
            rowsReceived: pull.rows.length,
            reason: 'CAP_EXCEEDED',
            detail:
                `${ingest.accounts.length} accounts exceeds the ${LEGACY_SNAPSHOT_MAX_ACCOUNTS} a `
                + 'snapshot may hold — check the connection is pointed at an access table',
        });
    }

    // ── 5. Store ────────────────────────────────────────────────────────────
    const payloadHash = computePayloadHash(ingest.accounts);
    const remoteSnapshotId = pull.manifest.snapshot.id;

    const snapshotId = await bookkeeping(async (db) => {
        const snap = await db.legacyAccessSnapshot.create({
            data: {
                tenantId: ctx.tenantId,
                connectionId: conn.id,
                remoteSnapshotId,
                mappingVersion: mapping.version,
                columnSetFingerprint: mapping.columnSetFingerprint,
                payloadHashAlgorithmVersion: PAYLOAD_HASH_ALGORITHM_VERSION,
                rowsReceived: pull.rows.length,
                oversharedColumns: [...ingest.overshared],
                unparsedDateCount: ingest.unparsedDates,
                status: 'PENDING',
                pulledAt: now,
            },
            select: { id: true },
        });
        return snap.id;
    });

    for (let i = 0; i < ingest.accounts.length; i += ACCOUNT_WRITE_CHUNK) {
        const batch = ingest.accounts.slice(i, i + ACCOUNT_WRITE_CHUNK);
        await runInTenantContext(
            ctx,
            (db) =>
                db.legacyAccount.createMany({
                    data: batch.map((a) => toAccountRow(ctx.tenantId, snapshotId, a)),
                }),
            SYNC_WRITE_TX_OPTIONS
        );
    }

    // ── 6. COMPLETE, as the final act ───────────────────────────────────────
    // Counted FROM THE DATABASE rather than from `ingest.accounts.length`. The
    // two agree unless a write silently dropped a row, and that is precisely the
    // case worth catching: `createMany` without `skipDuplicates` throws rather
    // than dropping, so a disagreement here would mean something stranger. The
    // number that goes on the row is the number of rows that exist.
    const stored = await bookkeeping((db) =>
        db.legacyAccount.count({ where: { tenantId: ctx.tenantId, snapshotId } })
    );

    const completedAt = new Date();
    await bookkeeping(async (db) => {
        await db.legacyAccessSnapshot.update({
            where: { id: snapshotId },
            data: {
                status: stored === ingest.accounts.length ? 'COMPLETE' : 'PARTIAL',
                ...(stored === ingest.accounts.length
                    ? { payloadHash }
                    : {
                        refusalReason: 'INTERNAL_ERROR' as const,
                        refusalDetail: `wrote ${ingest.accounts.length} accounts but ${stored} are stored`,
                    }),
                rowCount: stored,
                completedAt,
            },
        });
        await db.integrationExecution.update({
            where: { id: executionId },
            data: {
                // All three values, used for what they mean rather than collapsed
                // to ok/not-ok.
                //
                // NOT_APPLICABLE for a complete pull of an EMPTY table: the enum's
                // own comment says "no data" is not "compliant", and that is the
                // case exactly. The snapshot is still COMPLETE — an application
                // with no accounts is a true observation, and refusing to record
                // it would lose the fact. Invariant 5 is enforced where it bites,
                // at campaign CREATION, which refuses an empty population; a
                // snapshot is evidence, not a certificate.
                //
                // ERROR only for the row-count disagreement, which means something
                // internally wrong rather than a verdict about the far end.
                status: stored !== ingest.accounts.length
                    ? 'ERROR'
                    : stored === 0 ? 'NOT_APPLICABLE' : 'PASSED',
                completedAt,
                ...(stored === ingest.accounts.length
                    ? {}
                    : { errorMessage: 'snapshot row count disagreed with the write' }),
            },
        });
        await flagOversharing(db, conn.id, ingest, completedAt);
        await logEvent(db, ctx, {
            entityType: 'LegacyAccessSnapshot',
            entityId: snapshotId,
            action: 'LEGACY_ACCESS_SNAPSHOT_PULLED',
            details:
                `Legacy access snapshot pulled for connection "${conn.id}": ${stored} accounts, `
                + `mapping version ${mapping.version}`,
            detailsJson: {
                category: 'custom',
                event: 'legacy_access_snapshot_pulled',
                connectionId: conn.id,
                snapshotId,
                remoteSnapshotId,
                mappingVersion: mapping.version,
                columnSetFingerprint: mapping.columnSetFingerprint,
                // The integrity evidence, in the hash-chained trail. An auditor can
                // recompute it from the stored accounts and compare.
                payloadHash,
                payloadHashAlgorithmVersion: PAYLOAD_HASH_ALGORITHM_VERSION,
                rowCount: stored,
                rowsReceived: pull.rows.length,
                oversharedColumns: ingest.overshared,
                unparsedDateCount: ingest.unparsedDates,
            },
        });
    });

    return {
        executionId,
        snapshotId,
        status: stored === ingest.accounts.length ? 'COMPLETE' : 'PARTIAL',
        rowCount: stored,
        payloadHash: stored === ingest.accounts.length ? payloadHash : null,
        refusalReason: stored === ingest.accounts.length ? null : 'INTERNAL_ERROR',
        refusalDetail: null,
        overshared: ingest.overshared,
    };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emptyResult(status: LegacyPullResult['status']): LegacyPullResult {
    return {
        executionId: null,
        snapshotId: null,
        status,
        rowCount: 0,
        payloadHash: null,
        refusalReason: null,
        refusalDetail: null,
        overshared: [],
    };
}

function readSecrets(encrypted: string | null): Record<string, unknown> {
    if (!encrypted) return {};
    try {
        const parsed: unknown = JSON.parse(decryptField(encrypted));
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        // A secret that will not decrypt or parse reads as ABSENT, which the
        // caller turns into a named refusal. Rethrowing would surface as an
        // unhandled job error carrying a decryption message about a credential.
        return {};
    }
}

async function failExecution(
    bookkeeping: <T>(fn: (db: PrismaTx) => Promise<T>) => Promise<T>,
    executionId: string,
    message: string
): Promise<void> {
    await bookkeeping((db) =>
        db.integrationExecution.update({
            where: { id: executionId },
            data: { status: 'ERROR', errorMessage: message, completedAt: new Date() },
        })
    );
}

interface RefusalInput {
    readonly conn: { readonly id: string };
    readonly executionId: string;
    readonly mapping: StoredMapping;
    readonly observedColumns: readonly string[];
    readonly rowsReceived: number;
    readonly reason: LegacyAccessRefusalReason;
    readonly detail: string;
}

/**
 * Record a refusal as a PARTIAL snapshot with a named reason, and store NO
 * accounts.
 *
 * The snapshot exists so the refusal is visible on the surface an operator reads,
 * and `payloadHash` stays null: a hash over a population we did not finish
 * reading would certify the wrong thing, and a reader comparing hashes would find
 * it valid.
 */
async function recordRefusal(
    ctx: RequestContext,
    bookkeeping: <T>(fn: (db: PrismaTx) => Promise<T>) => Promise<T>,
    input: RefusalInput
): Promise<LegacyPullResult> {
    const completedAt = new Date();
    const snapshotId = await bookkeeping(async (db) => {
        const snap = await db.legacyAccessSnapshot.create({
            data: {
                tenantId: ctx.tenantId,
                connectionId: input.conn.id,
                // The far end's id is unknown on most refusal paths — a drift or a
                // torn read may never have produced a readable manifest. Empty
                // rather than invented.
                remoteSnapshotId: '',
                mappingVersion: input.mapping.version,
                columnSetFingerprint: input.mapping.columnSetFingerprint,
                payloadHashAlgorithmVersion: PAYLOAD_HASH_ALGORITHM_VERSION,
                rowsReceived: input.rowsReceived,
                rowCount: 0,
                status: 'PARTIAL',
                refusalReason: input.reason,
                refusalDetail: input.detail,
                pulledAt: completedAt,
                completedAt,
            },
            select: { id: true },
        });
        await db.integrationExecution.update({
            where: { id: input.executionId },
            // PARTIAL, not ERROR. The run COMPLETED and produced a verdict; what
            // is incomplete is its output. That is the documented meaning of the
            // value, and it keeps a refusal distinguishable from a crash, which
            // leaves the row RUNNING. The SharePoint export is the precedent the
            // enum comment cites: recording an incomplete run as a clean one left
            // the operator's only durable record saying it was fine.
            data: { status: 'PARTIAL', errorMessage: input.reason, completedAt },
        });
        await logEvent(db, ctx, {
            entityType: 'LegacyAccessSnapshot',
            entityId: snap.id,
            action: 'LEGACY_ACCESS_SNAPSHOT_REFUSED',
            details: `Legacy access pull refused: ${input.reason}`,
            detailsJson: {
                category: 'custom',
                event: 'legacy_access_snapshot_refused',
                connectionId: input.conn.id,
                snapshotId: snap.id,
                reason: input.reason,
                // System-generated, and never a cell value — the rule
                // `LegacyIngestError.detail` enforces.
                detail: input.detail,
                mappingVersion: input.mapping.version,
                rowsReceived: input.rowsReceived,
            },
        });
        return snap.id;
    });

    logger.warn('legacy access pull refused', {
        component: 'legacy-access',
        connectionId: input.conn.id,
        reason: input.reason,
    });

    return {
        executionId: input.executionId,
        snapshotId,
        status: 'PARTIAL',
        rowCount: 0,
        payloadHash: null,
        refusalReason: input.reason,
        refusalDetail: input.detail,
        overshared: [],
    };
}

/**
 * Mirror the OVERSHARING condition onto the connection.
 *
 * Cleared when a pull sees no extra columns, so a server that was fixed stops
 * wearing the flag. A sticky flag would make the banner permanent and therefore
 * ignored.
 */
async function flagOversharing(
    db: PrismaTx,
    connectionId: string,
    ingest: IngestOutcome,
    now: Date
): Promise<void> {
    if (ingest.overshared.length === 0) {
        await db.integrationConnection.updateMany({
            where: { id: connectionId },
            data: { oversharingObservedAt: null, oversharingColumns: [] },
        });
        return;
    }
    await db.integrationConnection.updateMany({
        where: { id: connectionId },
        data: { oversharingObservedAt: now, oversharingColumns: [...ingest.overshared] },
    });
    logger.warn('legacy MCP server returned columns the projection did not request', {
        component: 'legacy-access',
        connectionId,
        // COUNTS and a denied/not-denied split. The names are on the row for an
        // operator; a log line is the wrong place to accumulate a customer's
        // schema.
        oversharedCount: ingest.overshared.length,
        declaredDeniedCount: ingest.declaredDenied.length,
    });
}

/** Canonical account → database row. The one place `createdAt` becomes `sourceCreatedAt`. */
function toAccountRow(
    tenantId: string,
    snapshotId: string,
    a: CanonicalAccount
): Prisma.LegacyAccountCreateManyInput {
    return {
        tenantId,
        snapshotId,
        accountKey: a.accountKey,
        username: a.username,
        displayName: a.displayName,
        givenName: a.givenName,
        familyName: a.familyName,
        email: a.email,
        employeeNumber: a.employeeNumber,
        department: a.department,
        title: a.title,
        managerRef: a.managerRef,
        status: a.status,
        lastLoginAt: a.lastLoginAt,
        // The canonical field is `createdAt`; the column is `sourceCreatedAt`,
        // because the row needs its own insert time and two `createdAt`s on one
        // model would be a trap. The rename lives HERE and nowhere else, so the
        // hash-recompute path has exactly one place to mirror.
        sourceCreatedAt: a.createdAt,
        expiresAt: a.expiresAt,
        entitlements: [...a.entitlements],
        isPrivileged: a.isPrivileged,
        accountType: a.accountType,
    };
}


/**
 * Refuse a pull whose server declares an entitlement layout the mapping does not
 * expect.
 *
 * The mapping's layout is what an administrator confirmed; the manifest's is what
 * the server says today. A disagreement is drift of the same family as a changed
 * column set, with the same remedy — a person re-confirms — so it carries the
 * same reason.
 *
 * It is worth a check of its own because ONE of the two directions is silent.
 * Server `long` read as `wide` produces repeated account keys, which
 * {@link mapRows} already refuses loudly as `DUPLICATE_ACCOUNT_KEY`. Server
 * `wide` read as `long` produces exactly one row per account and quietly keeps
 * whichever single entitlement the one mapped column held — a snapshot that looks
 * complete and understates everybody's access, which is the direction
 * recertification cannot afford.
 *
 * `none` and `delimited` are both compatible with a `wide` server: `none` means
 * the administrator chose not to collect entitlements, and `delimited` is one
 * wide column carrying several values.
 */
function assertLayoutAgrees(mapping: StoredMapping, declared: 'wide' | 'long'): void {
    const expectsLong = mapping.entitlements.kind === 'long';
    if (expectsLong === (declared === 'long')) return;
    throw new LegacyIngestError(
        'SCHEMA_DRIFT',
        `the server declares a "${declared}" entitlement layout and mapping version `
        + `${mapping.version} was confirmed against "${mapping.entitlements.kind}" — an `
        + 'administrator must re-confirm the mapping'
    );
}

/**
 * Ask for a pull. Enqueues and returns the job id.
 *
 * Lives in the usecase layer rather than in the route for the reason the layer
 * rules give: a route handler is an HTTP boundary — parse, call, respond — and
 * `tests/guards/regression-scanner.test.ts` enforces that a route does not reach
 * `lib/prisma` itself. The connection lookup and the audit row are both data
 * access, so they belong here.
 *
 * The lookup is NOT the security boundary — the job re-reads the connection under
 * tenant context and would find nothing. It is the difference between a 404 an
 * administrator can act on and a queued job that quietly records
 * `NOT_APPLICABLE` somewhere they are not looking.
 */
export async function requestLegacyAccessPull(
    ctx: RequestContext,
    connectionId: string
): Promise<{ readonly jobId: string | undefined }> {
    assertCanAdmin(ctx);

    const conn = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { id: true },
        })
    );
    if (!conn) throw notFound('Legacy access connection not found');

    const job = await enqueue('legacy-access-pull', {
        tenantId: ctx.tenantId,
        connectionId: conn.id,
    });

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            entityType: 'IntegrationConnection',
            entityId: conn.id,
            action: 'LEGACY_ACCESS_PULL_REQUESTED',
            details: `Legacy access pull requested for connection "${conn.id}"`,
            detailsJson: {
                category: 'custom',
                event: 'legacy_access_pull_requested',
                connectionId: conn.id,
                jobId: job.id ?? null,
                requestedByUserId: ctx.userId ?? null,
            },
        })
    );

    return { jobId: job.id };
}
