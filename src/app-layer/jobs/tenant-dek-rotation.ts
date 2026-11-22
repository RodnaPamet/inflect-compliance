/**
 * Per-tenant DEK rotation re-encrypt sweep.
 *
 * Triggered by `rotateTenantDek` (in `src/lib/security/tenant-key-manager.ts`)
 * AFTER the atomic DEK swap moves the prior wrapped DEK into
 * `Tenant.previousEncryptedDek` and writes a fresh DEK to
 * `Tenant.encryptedDek`. This job's job is to walk every v2
 * ciphertext belonging to the rotated tenant and rewrite it under the
 * new primary DEK, then clear `previousEncryptedDek` so the dual-DEK
 * fallback in the encryption middleware can stop attempting it.
 *
 * ## Concrete steps
 *
 *   1. Resolve both DEKs by unwrapping `Tenant.encryptedDek` and
 *      `Tenant.previousEncryptedDek` from the row, after dropping this
 *      process's DEK caches. Never through `getTenantDek`: the rotation
 *      was primed in the web process, and this worker's cache may still
 *      hold the OLD key as the current one (#5057).
 *
 *   2. For each (model, field) in the encrypted-fields manifest that
 *      has a `tenantId` column, walk rows carrying a v2 ciphertext:
 *        - Decrypt under the previous DEK (NOT the dual-key helper —
 *          rows that primary-decrypt are by definition not what we
 *          want to rewrite, and silently re-encrypting them is just
 *          wasted churn). Skip on auth failure: that row is already
 *          under the new primary (the middleware rewrote it on a
 *          read-modify-write since the rotation kicked off).
 *        - Re-encrypt with the new primary DEK.
 *        - Single-row UPDATE.
 *
 *   3. On success (totalErrors === 0), clear
 *      `Tenant.previousEncryptedDek` and invalidate the previous-DEK
 *      cache. On failure, leave the column populated — the dual-DEK
 *      fallback keeps reads working until the operator investigates
 *      and re-enqueues.
 *
 * ## Idempotency
 *
 * Re-runs after a crash are safe:
 *   - Rows already rewritten under the new primary FAIL the
 *     decrypt-under-previous step and are skipped (we count them as
 *     "skipped: already rewritten" rather than "errors").
 *   - The final clear-previous step is gated on `totalErrors === 0`,
 *     so a partial sweep stays partial until the operator's investigation.
 *
 * ## What this job does NOT do
 *
 *   - Master-KEK rotation. That's `key-rotation.ts`. The two are
 *     orthogonal: this job uses tenant DEKs (v2); `key-rotation.ts`
 *     handles v1 ciphertexts under the master KEK and re-wraps the
 *     tenant's wrapped-DEK under the new master KEK.
 *   - v1 ciphertexts. Those carry no tenant-DEK envelope; they're
 *     untouched by a per-tenant DEK rotation.
 *   - Re-encrypting plaintext or pre-encryption legacy values. Only
 *     `v2:` ciphertexts are touched.
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import {
    encryptWithKey,
    decryptWithKey,
} from '@/lib/security/encryption';
import {
    unwrapDek,
} from '@/lib/security/tenant-keys';
import {
    clearTenantDekCache,
    clearTenantPreviousDekCache,
} from '@/lib/security/tenant-key-manager';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { appendAuditEntry } from '@/lib/audit/audit-writer';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Mid-rotation progress payload.
 *
 * Stable shape — surfaced via `GET /api/t/:slug/admin/tenant-dek-rotation`
 * (and the alias `/admin/rotate-dek`). Consumers (admin UI, ops
 * scripts) parse this to render live status. Carries NO secrets,
 * NO key material — only counts + structural identifiers.
 */
export interface TenantDekRotationProgress {
    /**
     * Lifecycle phase. Strict ordering:
     *   - `starting`    job entered, fields not yet enumerated
     *   - `sweeping`    iterating per (model, field), per-batch updates
     *   - `finalising`  sweep done, clearing previousEncryptedDek
     *   - `complete`    final state, no further updates
     *   - `noop`        previousEncryptedDek already clear (sibling won)
     */
    phase: 'starting' | 'sweeping' | 'finalising' | 'complete' | 'noop';
    /** Current (model, field) when phase = 'sweeping'. */
    currentModel?: string;
    currentField?: string;
    /** 0-indexed position of the current field across the manifest. */
    fieldIndex: number;
    /** Total fields the sweep will touch. Set at phase=starting. */
    fieldsTotal: number;
    /** Cumulative across all fields swept so far in THIS run. */
    totalScanned: number;
    totalRewritten: number;
    totalSkipped: number;
    totalErrors: number;
}

export interface TenantDekRotationOptions {
    tenantId: string;
    initiatedByUserId: string;
    requestId?: string;
    /** Override SELECT batch size per (model, field). Default 500. */
    batchSize?: number;
    /**
     * GAP-22: optional progress callback. Wired from the BullMQ
     * worker as `(p) => job.updateProgress(p)`. Cron / CLI
     * entrypoints leave this unset; the job degrades gracefully —
     * progress just isn't surfaced live. Awaited so the GET
     * status endpoint sees the latest value immediately.
     */
    onProgress?: (progress: TenantDekRotationProgress) => Promise<void>;
}

export interface TenantDekRotationPerFieldResult {
    model: string;
    field: string;
    scanned: number;
    rewritten: number;
    skipped: number;
    errors: number;
}

export interface TenantDekRotationResult {
    tenantId: string;
    previousEncryptedDekCleared: boolean;
    perField: TenantDekRotationPerFieldResult[];
    totalScanned: number;
    totalRewritten: number;
    totalSkipped: number;
    totalErrors: number;
    durationMs: number;
    jobRunId: string;
}

// ─── Safety helpers ─────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string, kind: string): void {
    if (!IDENT_RE.test(name)) {
        throw new Error(
            `tenant-dek-rotation: invalid ${kind} identifier: ${JSON.stringify(name)}`,
        );
    }
}

// ─── tenantId-column probe (mirrors key-rotation.ts) ────────────────
//
// The encrypted-fields manifest doesn't expose which models have a
// tenantId column, so we probe each manifest model once via a
// zero-row SELECT. Only a definite answer is cached (for the process's
// lifetime, which is safe because the schema cannot change under a
// running process); a probe that fails for any other reason throws.

const _modelHasTenantIdCache = new Map<string, boolean>();

async function modelHasTenantIdColumn(model: string): Promise<boolean> {
    assertIdentifier(model, 'model');
    const cached = _modelHasTenantIdCache.get(model);
    if (cached !== undefined) return cached;
    try {
        await prisma.$queryRawUnsafe(
            `SELECT "tenantId" FROM "${model}" LIMIT 0`,
        );
        _modelHasTenantIdCache.set(model, true);
        return true;
    } catch (err) {
        // ONLY Postgres' undefined_column (42703) means "this model has no
        // tenantId". Any other failure — a dropped connection, a pool or
        // statement timeout — is thrown, never cached as false: a model
        // skipped on a transient error contributed no errors to the sweep,
        // so the run reported clean while that model's rows were never
        // touched (#5108).
        if (isUndefinedColumnError(err)) {
            _modelHasTenantIdCache.set(model, false);
            return false;
        }
        logger.error('tenant-dek-rotation.model_probe_failed', {
            component: 'tenant-dek-rotation',
            model,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}

function isUndefinedColumnError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const meta = err.meta as { code?: unknown } | undefined;
        if (meta?.code === '42703') return true;
    }
    return err instanceof Error && /column "?tenantId"? does not exist/i.test(err.message);
}

// ─── Per-field sweep ────────────────────────────────────────────────

function readsUnder(key: Buffer, value: string): boolean {
    try {
        decryptWithKey(key, value);
        return true;
    } catch {
        return false;
    }
}

async function sweepV2Field(
    tenantId: string,
    previousDek: Buffer,
    newDek: Buffer,
    model: string,
    field: string,
    batchSize: number,
    onBatch?: (batch: TenantDekRotationPerFieldResult) => Promise<void>,
): Promise<TenantDekRotationPerFieldResult> {
    assertIdentifier(model, 'model');
    assertIdentifier(field, 'field');

    const out: TenantDekRotationPerFieldResult = {
        model,
        field,
        scanned: 0,
        rewritten: 0,
        skipped: 0,
        errors: 0,
    };

    // Read raw SQL — bypass the encryption middleware so we see actual
    // v2 ciphertexts (not decrypted plaintext from the middleware's
    // read path).
    //
    // Cursor pagination on `id` is mandatory here: rewritten rows are
    // STILL `v2:%` (just now under the new DEK), so a no-cursor
    // SELECT would re-fetch the same first batch indefinitely. We
    // advance the cursor on every row processed (rewritten OR
    // skipped), guaranteeing forward progress.
    let lastId: string | null = null;

    while (true) {
        const sql = lastId === null
            ? `
                SELECT id, "${field}" AS value
                FROM "${model}"
                WHERE "tenantId" = $1
                  AND "${field}" IS NOT NULL
                  AND "${field}" LIKE 'v2:%'
                ORDER BY id
                LIMIT $2
            `
            : `
                SELECT id, "${field}" AS value
                FROM "${model}"
                WHERE "tenantId" = $1
                  AND "${field}" IS NOT NULL
                  AND "${field}" LIKE 'v2:%'
                  AND id > $3
                ORDER BY id
                LIMIT $2
            `;

        let rows: Array<{ id: string; value: string }>;
        try {
            rows = lastId === null
                ? await prisma.$queryRawUnsafe<
                    Array<{ id: string; value: string }>
                >(sql, tenantId, batchSize)
                : await prisma.$queryRawUnsafe<
                    Array<{ id: string; value: string }>
                >(sql, tenantId, batchSize, lastId);
        } catch (err) {
            logger.error('tenant-dek-rotation.select_failed', {
                component: 'tenant-dek-rotation',
                tenantId,
                model,
                field,
                error: err instanceof Error ? err.message : String(err),
            });
            out.errors++;
            return out;
        }

        if (rows.length === 0) break;
        out.scanned += rows.length;

        for (const row of rows) {
            // Decrypt strictly under the PREVIOUS DEK. A row that
            // FAILS the previous decrypt has already been rewritten
            // (by us in a prior run, or by a read-modify-write
            // through the middleware) and doesn't need a second pass
            // — count it as skipped, not an error.
            let plaintext: string;
            try {
                plaintext = decryptWithKey(previousDek, row.value);
            } catch {
                // Skipped only when the row provably reads under the NEW
                // DEK. A row that reads under neither key is an error, so
                // the previous DEK is kept: clearing it on a row we could
                // not account for is how a sweep turns an anomaly into
                // permanent loss (#5057).
                if (readsUnder(newDek, row.value)) {
                    out.skipped++;
                } else {
                    out.errors++;
                    logger.error('tenant-dek-rotation.row_unreadable', {
                        component: 'tenant-dek-rotation',
                        tenantId,
                        model,
                        field,
                        id: row.id,
                    });
                }
                continue;
            }

            let fresh: string;
            try {
                fresh = encryptWithKey(newDek, plaintext);
            } catch (err) {
                out.errors++;
                logger.error('tenant-dek-rotation.encrypt_failed', {
                    component: 'tenant-dek-rotation',
                    tenantId,
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : 'unknown',
                });
                continue;
            }

            try {
                // Conditional on the ciphertext read, so a user edit that
                // landed after the SELECT is not reverted to the old
                // plaintext (#5109).
                const updated = await prisma.$executeRawUnsafe(
                    `UPDATE "${model}" SET "${field}" = $1 WHERE id = $2 AND "${field}" = $3`,
                    fresh,
                    row.id,
                    row.value,
                );
                if (updated > 0) {
                    out.rewritten++;
                } else {
                    // The row moved on. It is settled only if its current
                    // value reads under the new DEK (or the row is gone or
                    // cleared); otherwise keep the previous DEK.
                    const current = await prisma.$queryRawUnsafe<
                        Array<{ value: string | null }>
                    >(`SELECT "${field}" AS value FROM "${model}" WHERE id = $1`, row.id);
                    const value = current[0]?.value ?? null;
                    if (value === null || !value.startsWith('v2:') || readsUnder(newDek, value)) {
                        out.skipped++;
                    } else {
                        out.errors++;
                        logger.error('tenant-dek-rotation.concurrent_write_unreadable', {
                            component: 'tenant-dek-rotation',
                            tenantId,
                            model,
                            field,
                            id: row.id,
                        });
                    }
                }
            } catch (err) {
                out.errors++;
                logger.error('tenant-dek-rotation.update_failed', {
                    component: 'tenant-dek-rotation',
                    tenantId,
                    model,
                    field,
                    id: row.id,
                    error: err instanceof Error ? err.message : 'unknown',
                });
            }
        }

        // Advance cursor unconditionally so we don't re-fetch
        // rewritten rows on the next page.
        lastId = rows[rows.length - 1].id;

        // GAP-22: per-batch progress hook. Snapshot, not mutation —
        // the caller assembles the cross-field aggregate.
        if (onBatch) {
            try {
                await onBatch({ ...out });
            } catch {
                // Progress reporting is best-effort. A Redis blip on
                // updateProgress must not stop the sweep.
            }
        }

        if (rows.length < batchSize) break;
    }

    return out;
}

// ─── Public entry point ─────────────────────────────────────────────

/**
 * Run the full per-tenant DEK re-encrypt sweep. Structured as:
 *   1. Audit-log "started" event.
 *   2. Resolve previous DEK directly (bypass cache — we want a fresh
 *      read of the column).
 *   3. Resolve new primary DEK via the manager's cache.
 *   4. For each (model, field) in the manifest that has a tenantId
 *      column, sweep v2 ciphertexts.
 *   5. On totalErrors === 0: clear `previousEncryptedDek`, drop the
 *      previous-DEK cache, log + audit completion.
 *   6. On totalErrors > 0: leave `previousEncryptedDek` populated for
 *      the dual-DEK fallback; audit completion with errors so the
 *      operator can investigate and re-enqueue.
 */
export async function runTenantDekRotation(
    options: TenantDekRotationOptions,
): Promise<TenantDekRotationResult> {
    return runJob(
        'tenant-dek-rotation',
        async () => {
            const jobRunId = crypto.randomUUID();
            const started = Date.now();
            const batchSize = Math.max(1, options.batchSize ?? 500);
            const { tenantId, onProgress } = options;

            // GAP-22: small helper that swallows progress-reporting
            // exceptions. Live progress is informational; a transient
            // Redis failure must never abort the rotation.
            const reportProgress = async (
                p: TenantDekRotationProgress,
            ): Promise<void> => {
                if (!onProgress) return;
                try {
                    await onProgress(p);
                } catch {
                    /* best-effort */
                }
            };

            await appendAuditEntry({
                tenantId,
                userId: options.initiatedByUserId,
                actorType: 'SYSTEM',
                entity: 'TenantKey',
                entityId: tenantId,
                action: 'TENANT_DEK_ROTATION_STARTED',
                details: null,
                metadataJson: { jobRunId },
                requestId: options.requestId ?? null,
            });

            await reportProgress({
                phase: 'starting',
                fieldIndex: 0,
                fieldsTotal: 0, // resolved below
                totalScanned: 0,
                totalRewritten: 0,
                totalSkipped: 0,
                totalErrors: 0,
            });

            // Resolve both DEKs. previousEncryptedDek is read directly
            // (no cache) because (a) the column was just populated by
            // rotateTenantDek so a stale cache could mask the fresh
            // value; (b) the negative cache for "no previous DEK"
            // would short-circuit a freshly-rotated tenant if a
            // sibling process recently saw NULL.
            const tenant = await prisma.tenant.findUnique({
                where: { id: tenantId },
                select: { encryptedDek: true, previousEncryptedDek: true },
            });
            if (!tenant) {
                throw new Error(
                    `tenant-dek-rotation: tenant ${tenantId} not found`,
                );
            }
            if (!tenant.previousEncryptedDek) {
                // No-op — the rotation completed in a sibling process
                // (or was never started). Nothing to do.
                logger.info('tenant-dek-rotation.no_previous_dek', {
                    component: 'tenant-dek-rotation',
                    tenantId,
                    jobRunId,
                });
                await reportProgress({
                    phase: 'noop',
                    fieldIndex: 0,
                    fieldsTotal: 0,
                    totalScanned: 0,
                    totalRewritten: 0,
                    totalSkipped: 0,
                    totalErrors: 0,
                });
                return {
                    tenantId,
                    previousEncryptedDekCleared: false,
                    perField: [],
                    totalScanned: 0,
                    totalRewritten: 0,
                    totalSkipped: 0,
                    totalErrors: 0,
                    durationMs: Date.now() - started,
                    jobRunId,
                };
            }

            // BOTH keys come from the row, never from this process's DEK
            // cache (#5057). The rotation was primed in the WEB process;
            // this worker may hold the tenant's OLD DEK in its cache from
            // any job it ran before. Resolving the new key through that
            // cache re-encrypted every row under the old key and then
            // cleared the only wrapped copy of it. Dropping both caches
            // also stops this process writing new rows under the old key.
            clearTenantDekCache(tenantId);
            clearTenantPreviousDekCache(tenantId);
            if (!tenant.encryptedDek) {
                throw new Error(
                    `tenant-dek-rotation: tenant ${tenantId} has a previous DEK but no current DEK`,
                );
            }
            const previousDek = unwrapDek(tenant.previousEncryptedDek);
            const newDek = unwrapDek(tenant.encryptedDek);
            if (crypto.timingSafeEqual(previousDek, newDek)) {
                throw new Error(
                    `tenant-dek-rotation: tenant ${tenantId} current and previous DEK are the same key`,
                );
            }

            // Sweep every (model, field) whose model carries a tenantId.
            const perField: TenantDekRotationPerFieldResult[] = [];
            let totalScanned = 0;
            let totalRewritten = 0;
            let totalSkipped = 0;
            let totalErrors = 0;

            // First pass — enumerate the (model, field) pairs we'll
            // sweep so the progress payload can include `fieldsTotal`
            // from the very first update.
            const fieldsToSweep: Array<{ model: string; field: string }> = [];
            for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
                const hasTenantId = await modelHasTenantIdColumn(model);
                if (!hasTenantId) continue;
                for (const field of fields) {
                    fieldsToSweep.push({ model, field });
                }
            }
            const fieldsTotal = fieldsToSweep.length;

            for (let idx = 0; idx < fieldsToSweep.length; idx++) {
                const { model, field } = fieldsToSweep[idx];

                // Initial per-field update — useful for surfacing the
                // model+field name even before the first batch lands.
                await reportProgress({
                    phase: 'sweeping',
                    currentModel: model,
                    currentField: field,
                    fieldIndex: idx,
                    fieldsTotal,
                    totalScanned,
                    totalRewritten,
                    totalSkipped,
                    totalErrors,
                });

                const result = await sweepV2Field(
                    tenantId,
                    previousDek,
                    newDek,
                    model,
                    field,
                    batchSize,
                    // Per-batch progress: roll the running per-field
                    // counters into the cumulative totals so the GET
                    // status endpoint shows monotonic increase.
                    async (batch) => {
                        await reportProgress({
                            phase: 'sweeping',
                            currentModel: model,
                            currentField: field,
                            fieldIndex: idx,
                            fieldsTotal,
                            totalScanned: totalScanned + batch.scanned,
                            totalRewritten: totalRewritten + batch.rewritten,
                            totalSkipped: totalSkipped + batch.skipped,
                            totalErrors: totalErrors + batch.errors,
                        });
                    },
                );
                perField.push(result);
                totalScanned += result.scanned;
                totalRewritten += result.rewritten;
                totalSkipped += result.skipped;
                totalErrors += result.errors;
            }

            await reportProgress({
                phase: 'finalising',
                fieldIndex: fieldsTotal,
                fieldsTotal,
                totalScanned,
                totalRewritten,
                totalSkipped,
                totalErrors,
            });

            // Final clear — only when the sweep is clean. A partial
            // sweep (errors > 0) leaves previousEncryptedDek
            // populated so the middleware's fallback keeps reads
            // working; the operator re-enqueues after investigation.
            let previousEncryptedDekCleared = false;
            if (totalErrors === 0) {
                await prisma.tenant.update({
                    where: { id: tenantId },
                    data: { previousEncryptedDek: null },
                });
                clearTenantPreviousDekCache(tenantId);
                // Every row either was rewritten under the new DEK or
                // was verified to read under it, so the previous DEK is
                // no longer needed by any row this sweep saw.
                previousEncryptedDekCleared = true;
            } else {
                // Drop the in-process previous-DEK cache anyway so a
                // re-run in this process picks up whatever fresh
                // state the operator's investigation left behind.
                clearTenantPreviousDekCache(tenantId);
                clearTenantDekCache(tenantId);
            }

            const durationMs = Date.now() - started;

            await appendAuditEntry({
                tenantId,
                userId: options.initiatedByUserId,
                actorType: 'SYSTEM',
                entity: 'TenantKey',
                entityId: tenantId,
                action: 'TENANT_DEK_ROTATION_COMPLETED',
                details: null,
                metadataJson: {
                    jobRunId,
                    previousEncryptedDekCleared,
                    totalScanned,
                    totalRewritten,
                    totalSkipped,
                    totalErrors,
                    durationMs,
                },
                requestId: options.requestId ?? null,
            });

            (totalErrors > 0 ? logger.error : logger.info)('tenant-dek-rotation.complete', {
                component: 'tenant-dek-rotation',
                tenantId,
                jobRunId,
                previousEncryptedDekCleared,
                totalScanned,
                totalRewritten,
                totalSkipped,
                totalErrors,
                durationMs,
            });

            await reportProgress({
                phase: 'complete',
                fieldIndex: fieldsTotal,
                fieldsTotal,
                totalScanned,
                totalRewritten,
                totalSkipped,
                totalErrors,
            });

            return {
                tenantId,
                previousEncryptedDekCleared,
                perField,
                totalScanned,
                totalRewritten,
                totalSkipped,
                totalErrors,
                durationMs,
                jobRunId,
            };
        },
        { tenantId: options.tenantId },
    );
}

/** @internal — expose for tests that need to reset cross-run state. */
export function _resetTenantDekRotationForTests(): void {
    _modelHasTenantIdCache.clear();
}
