/**
 * audit-pack-snapshot-encryption — the nightly backfill that closes #5455.
 *
 * #5150 put `AuditPackItem.snapshotJson` in `ENCRYPTED_FIELDS`, so every
 * snapshot written since is ciphertext. Rows written before it are not, and
 * nothing else will ever change that: the read path passes a value with no
 * `v1:`/`v2:` envelope through untouched, and both rotation sweeps select only
 * values that already carry one. A `TEST_RUN` item frozen before #5150 holds
 * the tester's notes, the finding summary and the executor's email in clear.
 *
 * This job finds those rows and encrypts each one under ITS OWN TENANT'S DEK
 * (`v2:`), the envelope the middleware would have written. Scheduled daily
 * (owner decision, 2026-11-19) rather than run once, so it needs no operator
 * step, and keeps closing anything a bypass path writes in plaintext later.
 * Once nothing is left it costs two counts over the table a night.
 *
 * ## Why raw SQL and an explicit key
 *
 * The extended client encrypts on write only with an ambient audit context
 * naming the tenant: without one `resolveTenantDekPair` returns no pair and the
 * write lands under the global KEK (`v1:`), which is not what the column's
 * other rows carry (the trap #5455 records). So the job does what the rotation
 * sweeps do: reads the true on-disk value with raw SQL, unwraps the tenant's
 * DEK from its own row, and writes `encryptWithKey(dek, value)` with a raw
 * UPDATE. Every ciphertext is decrypted again before it is written; a value
 * that does not round-trip is an error, never a write.
 *
 * ## Why every batch locks the tenant row
 *
 * A DEK rotation that started between this job's key read and its write would
 * be catastrophic. `rotateTenantDek` moves the current DEK to
 * `previousEncryptedDek` and the rotation sweep re-encrypts every `v2:` row
 * under the new one, then clears the previous key. A row this job wrote under
 * the OLD key after the sweep had passed it would be left under a key that is
 * then thrown away: unreadable for good.
 *
 * So each batch runs in one transaction that first takes `FOR SHARE` on the
 * tenant row and checks that the wrapped DEK is still the one it unwrapped and
 * that no rotation is in flight. The rotation's swap is an UPDATE of that row,
 * so it waits for the batch to commit, and its sweep then sees the batch's
 * rows as `v2:` and rewrites them like any other. A tenant whose key moved
 * since the pass began stops (`KEY_CHANGED`) and is retried the next night; a
 * tenant mid-rotation is not touched at all (`ROTATION_IN_FLIGHT`).
 *
 * ## Zero is never complete
 *
 * Every run reports a census of the column — plaintext, `v2:`, `v1:`, empty,
 * total — read before and after. "Nothing was rewritten" therefore comes with
 * the numbers that say why: no plaintext left among N enveloped rows reads
 * differently from a table with no rows, and from rows left behind by a tenant
 * that was skipped. A tenant's pass reports what it left (`remaining`), and
 * only a run whose census ends with zero plaintext rows reports none.
 *
 * Per-row UPDATEs are conditional on the value read, so a snapshot rewritten
 * by the application after the SELECT is left as the application wrote it.
 *
 * @module app-layer/jobs/audit-pack-snapshot-encryption
 */
import type { AuditPackSnapshotEncryptionPayload, JobRunResult } from './types';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { recordAuditPackSnapshotEncryption } from '@/lib/observability/integration-metrics';
import { encryptWithKey, decryptWithKey } from '@/lib/security/encryption';
import { unwrapDek } from '@/lib/security/tenant-keys';
import { ensureTenantDek } from '@/lib/security/tenant-key-manager';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const COMPONENT = 'audit-pack-snapshot-encryption';

/** Rows per locked batch. Small: each batch holds `FOR SHARE` on the tenant row. */
export const SNAPSHOT_ENCRYPTION_BATCH_SIZE = 100;

/**
 * The plaintext predicate, in one place. A value is plaintext when it is a
 * non-empty string with neither envelope; the middleware passes `''` through
 * untouched, so an empty snapshot is not counted as exposed.
 */
const PLAINTEXT_PREDICATE = `"snapshotJson" <> ''
          AND "snapshotJson" NOT LIKE 'v1:%'
          AND "snapshotJson" NOT LIKE 'v2:%'`;

export type TenantSnapshotEncryptionOutcome =
    /** Every plaintext row the pass found is now `v2:`. */
    | 'ENCRYPTED'
    /** Discovered, but no plaintext row was left when the pass read it. */
    | 'NOTHING_TO_DO'
    /** `previousEncryptedDek` is set: a DEK rotation is in flight. Not touched. */
    | 'ROTATION_IN_FLIGHT'
    /** The DEK or the rotation state changed during the pass. Stopped; retried tomorrow. */
    | 'KEY_CHANGED'
    /** Rows could not be encrypted or written, or the tenant could not be read. */
    | 'ERROR';

export interface TenantSnapshotEncryptionResult {
    tenantId: string;
    outcome: TenantSnapshotEncryptionOutcome;
    /** Plaintext rows read by this pass. */
    scanned: number;
    /** Rows written as `v2:` ciphertext. */
    encrypted: number;
    /** Rows the application rewrote between the read and the write; left as written. */
    changedUnderneath: number;
    /** Rows that failed to encrypt, verify or write. */
    errors: number;
    /** Plaintext rows this tenant still holds after the pass. */
    remaining: number;
}

/** The column, counted. `plaintext` is what the job exists to bring to zero. */
export interface SnapshotCensus {
    total: number;
    plaintext: number;
    v2: number;
    v1: number;
    empty: number;
}

export interface SnapshotEncryptionSweepResult {
    before: SnapshotCensus;
    after: SnapshotCensus;
    tenants: TenantSnapshotEncryptionResult[];
}

/** Count the column by envelope. One pass over the table; there is no index on the column, and none is needed for a nightly count. */
export async function snapshotCensus(tenantId?: string): Promise<SnapshotCensus> {
    const where = tenantId ? 'WHERE "tenantId" = $1' : '';
    const params = tenantId ? [tenantId] : [];
    const rows = await prisma.$queryRawUnsafe<Array<Record<keyof SnapshotCensus, bigint | number>>>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE ${PLAINTEXT_PREDICATE}) AS plaintext,
                count(*) FILTER (WHERE "snapshotJson" LIKE 'v2:%') AS v2,
                count(*) FILTER (WHERE "snapshotJson" LIKE 'v1:%') AS v1,
                count(*) FILTER (WHERE "snapshotJson" = '') AS empty
         FROM "AuditPackItem" ${where}`,
        ...params,
    );
    const r = rows[0];
    return {
        total: Number(r?.total ?? 0),
        plaintext: Number(r?.plaintext ?? 0),
        v2: Number(r?.v2 ?? 0),
        v1: Number(r?.v1 ?? 0),
        empty: Number(r?.empty ?? 0),
    };
}

/** Tenants holding at least one plaintext snapshot. */
async function discoverTenants(): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<Array<{ tenantId: string }>>(
        `SELECT DISTINCT "tenantId" FROM "AuditPackItem" WHERE ${PLAINTEXT_PREDICATE} ORDER BY "tenantId"`,
    );
    return rows.map((r) => r.tenantId);
}

type TenantKeyRow = { encryptedDek: string | null; previousEncryptedDek: string | null };

async function readTenantKeys(tenantId: string): Promise<TenantKeyRow | null> {
    return prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { encryptedDek: true, previousEncryptedDek: true },
    });
}

/**
 * Encrypt one tenant's plaintext snapshots under its own DEK.
 *
 * Never throws: every failure is an outcome with counts, so one tenant cannot
 * stop the rest of the sweep.
 */
export async function encryptTenantAuditPackSnapshots(
    tenantId: string,
    opts: { batchSize?: number } = {},
): Promise<TenantSnapshotEncryptionResult> {
    const batchSize = Math.max(1, opts.batchSize ?? SNAPSHOT_ENCRYPTION_BATCH_SIZE);
    const out: TenantSnapshotEncryptionResult = {
        tenantId,
        outcome: 'ENCRYPTED',
        scanned: 0,
        encrypted: 0,
        changedUnderneath: 0,
        errors: 0,
        remaining: 0,
    };
    const finish = async (outcome: TenantSnapshotEncryptionOutcome) => {
        out.outcome = outcome;
        // Whatever stopped the pass, the rows it DID write are recorded.
        if (out.encrypted > 0) {
            try {
                await appendAuditEntry({
                    tenantId,
                    userId: null,
                    actorType: 'SYSTEM',
                    entity: 'AuditPackItem',
                    entityId: tenantId,
                    action: 'AUDIT_PACK_SNAPSHOTS_ENCRYPTED',
                    detailsJson: {
                        category: 'custom',
                        operation: 'plaintext_snapshots_encrypted',
                        encrypted: out.encrypted,
                        errors: out.errors,
                        issue: 5455,
                    },
                });
            } catch (err) {
                // The rows are written; a missing audit row must still be loud.
                logger.error('audit-pack-snapshot-encryption.audit_failed', {
                    component: COMPONENT,
                    tenantId,
                    error: err instanceof Error ? err.message : 'unknown',
                });
            }
        }
        try {
            out.remaining = (await snapshotCensus(tenantId)).plaintext;
        } catch {
            // The count is a report, not the work. Unknown is reported as -1,
            // never as 0, which would read as "nothing left".
            out.remaining = -1;
        }
        return out;
    };

    let keys: TenantKeyRow | null;
    let dek: Buffer;
    try {
        keys = await readTenantKeys(tenantId);
        if (!keys) {
            logger.error('audit-pack-snapshot-encryption.tenant_missing', { component: COMPONENT, tenantId });
            out.errors++;
            return finish('ERROR');
        }
        if (keys.previousEncryptedDek !== null) return finish('ROTATION_IN_FLIGHT');
        if (keys.encryptedDek === null) {
            // The application creates a missing DEK on first use; do the same,
            // then read the row the creation settled on.
            await ensureTenantDek(tenantId);
            keys = await readTenantKeys(tenantId);
            if (!keys?.encryptedDek) {
                out.errors++;
                return finish('ERROR');
            }
            if (keys.previousEncryptedDek !== null) return finish('ROTATION_IN_FLIGHT');
        }
        dek = unwrapDek(keys.encryptedDek!);
    } catch (err) {
        logger.error('audit-pack-snapshot-encryption.key_unavailable', {
            component: COMPONENT,
            tenantId,
            error: err instanceof Error ? err.message : 'unknown',
        });
        out.errors++;
        return finish('ERROR');
    }
    const wrapped = keys.encryptedDek!;

    // Keyset on id, so a row that fails is passed over rather than read again.
    let lastId = '';
    for (;;) {
        // Counted per batch and added to the result only once the batch has
        // committed: a rolled-back batch wrote nothing, and must report nothing.
        type Batch = {
            rows: number;
            lastId: string;
            scanned: number;
            encrypted: number;
            changedUnderneath: number;
            errors: number;
            stop?: TenantSnapshotEncryptionOutcome;
        };
        let batch: Batch;
        try {
            batch = await prisma.$transaction(
                async (tx): Promise<Batch> => {
                    const b: Batch = { rows: 0, lastId, scanned: 0, encrypted: 0, changedUnderneath: 0, errors: 0 };
                    const locked = await tx.$queryRawUnsafe<TenantKeyRow[]>(
                        `SELECT "encryptedDek", "previousEncryptedDek" FROM "Tenant" WHERE id = $1 FOR SHARE`,
                        tenantId,
                    );
                    const now = locked[0];
                    if (!now || now.encryptedDek !== wrapped || now.previousEncryptedDek !== null) {
                        return { ...b, stop: 'KEY_CHANGED' };
                    }
                    const rows = await tx.$queryRawUnsafe<Array<{ id: string; value: string }>>(
                        `SELECT id, "snapshotJson" AS value FROM "AuditPackItem"
                         WHERE "tenantId" = $1 AND ${PLAINTEXT_PREDICATE} AND id > $2
                         ORDER BY id LIMIT $3`,
                        tenantId,
                        lastId,
                        batchSize,
                    );
                    for (const row of rows) {
                        b.scanned++;
                        let ciphertext: string;
                        try {
                            ciphertext = encryptWithKey(dek, row.value);
                            if (decryptWithKey(dek, ciphertext) !== row.value) throw new Error('round trip mismatch');
                        } catch (err) {
                            b.errors++;
                            logger.error('audit-pack-snapshot-encryption.encrypt_failed', {
                                component: COMPONENT,
                                tenantId,
                                id: row.id,
                                error: err instanceof Error ? err.message : 'unknown',
                            });
                            continue;
                        }
                        const updated = await tx.$executeRawUnsafe(
                            `UPDATE "AuditPackItem" SET "snapshotJson" = $1 WHERE id = $2 AND "snapshotJson" = $3`,
                            ciphertext,
                            row.id,
                            row.value,
                        );
                        if (updated > 0) b.encrypted++;
                        else b.changedUnderneath++;
                    }
                    b.rows = rows.length;
                    if (rows.length > 0) b.lastId = rows[rows.length - 1].id;
                    return b;
                },
                // The platform's connection wait; a longer run budget, since a
                // batch is up to SNAPSHOT_ENCRYPTION_BATCH_SIZE updates.
                { maxWait: TENANT_TX_OPTIONS.maxWait, timeout: 30_000 },
            );
        } catch (err) {
            // A failed statement aborts the whole batch: nothing in it was
            // written. Counted as an error; tomorrow's run reads it again.
            logger.error('audit-pack-snapshot-encryption.batch_failed', {
                component: COMPONENT,
                tenantId,
                error: err instanceof Error ? err.message : 'unknown',
            });
            out.errors++;
            return finish('ERROR');
        }
        out.scanned += batch.scanned;
        out.encrypted += batch.encrypted;
        out.changedUnderneath += batch.changedUnderneath;
        out.errors += batch.errors;
        lastId = batch.lastId;
        if (batch.stop) return finish(batch.stop);
        if (batch.rows < batchSize) break;
    }

    if (out.errors > 0) return finish('ERROR');
    return finish(out.scanned === 0 ? 'NOTHING_TO_DO' : 'ENCRYPTED');
}

/** The scheduled sweep: census, every tenant with plaintext, census again. */
export async function runAuditPackSnapshotEncryptionSweep(
    payload: AuditPackSnapshotEncryptionPayload,
): Promise<SnapshotEncryptionSweepResult> {
    const before = await snapshotCensus(payload.tenantId);
    const tenantIds = payload.tenantId
        ? (before.plaintext > 0 ? [payload.tenantId] : [])
        : before.plaintext > 0
            ? await discoverTenants()
            : [];
    const tenants: TenantSnapshotEncryptionResult[] = [];
    for (const tenantId of tenantIds) {
        const r = await encryptTenantAuditPackSnapshots(tenantId);
        tenants.push(r);
        recordAuditPackSnapshotEncryption({ outcome: r.outcome, encrypted: r.encrypted });
    }
    const after = await snapshotCensus(payload.tenantId);
    if (tenantIds.length === 0) {
        recordAuditPackSnapshotEncryption({
            outcome: before.total === 0 ? 'EMPTY_TABLE' : 'NO_PLAINTEXT',
            encrypted: 0,
        });
    }
    logger.info('audit-pack-snapshot-encryption.sweep_complete', {
        component: COMPONENT,
        before,
        after,
        tenants: tenants.length,
        outcomes: tenants.reduce<Record<string, number>>((acc, t) => {
            acc[t.outcome] = (acc[t.outcome] ?? 0) + 1;
            return acc;
        }, {}),
    });
    if (after.plaintext > 0) {
        logger.warn('audit-pack-snapshot-encryption.plaintext_remains', {
            component: COMPONENT,
            remaining: after.plaintext,
            tenantsLeft: tenants.filter((t) => t.remaining !== 0).map((t) => ({ tenantId: t.tenantId, outcome: t.outcome, remaining: t.remaining })),
        });
    }
    return { before, after, tenants };
}

/** BullMQ executor body. */
export async function runAuditPackSnapshotEncryptionJob(
    payload: AuditPackSnapshotEncryptionPayload,
): Promise<JobRunResult> {
    return runJob(
        'audit-pack-snapshot-encryption',
        async () => {
            const jobRunId = crypto.randomUUID();
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const r = await runAuditPackSnapshotEncryptionSweep(payload);
            const errored = r.tenants.filter((t) => t.outcome === 'ERROR').length;
            const sum = (pick: (t: TenantSnapshotEncryptionResult) => number) =>
                r.tenants.reduce((n, t) => n + pick(t), 0);
            return {
                jobName: 'audit-pack-snapshot-encryption',
                jobRunId,
                success: errored === 0,
                // Not retried: the work is idempotent and tomorrow's tick reads
                // whatever is left. A retry minutes later would meet the same fault.
                ...(errored > 0 ? { errorMessage: `${errored} tenant pass(es) ended in ERROR`, noRetry: true } : {}),
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: sum((t) => t.scanned),
                itemsActioned: sum((t) => t.encrypted),
                itemsSkipped: sum((t) => t.changedUnderneath),
                details: {
                    before: r.before,
                    after: r.after,
                    tenants: r.tenants.length,
                    encrypted: sum((t) => t.encrypted),
                    errors: sum((t) => t.errors),
                    rotationInFlight: r.tenants.filter((t) => t.outcome === 'ROTATION_IN_FLIGHT').length,
                    keyChanged: r.tenants.filter((t) => t.outcome === 'KEY_CHANGED').length,
                    errored,
                },
            };
        },
        { tenantId: payload.tenantId },
    );
}
