import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/env';
import { getAuditContext } from './audit-context';
import { redactSensitiveFields, extractChangedFields } from './audit-redact';
import { withSoftDeleteExtension } from './soft-delete';
import { withPiiEncryptionExtension } from './security/pii-middleware';
import { withEncryptionExtension } from './db/encryption-middleware';
import { withRlsTripwireExtension } from './db/rls-middleware';
import { DB_POOL_MAX, DB_POOL_CONNECTION_TIMEOUT_MS } from './db/concurrency-limits';
import { logger as auditMiddlewareLogger } from '@/lib/observability/logger';
import { recordSlowQuery } from '@/lib/observability/metrics';

// Slow-query threshold. Typical Prisma p99 sits at 5-20ms; 50ms is the
// "this query is suspicious / worth a look" line, not a per-request SLO.
// Tune in one place. See docs/implementation-notes/2026-06-26-perf-baseline.md.
const SLOW_QUERY_THRESHOLD_MS = 50;

/** Best-effort model-name parse from a SQL string, for the metric label. */
function parseModelFromSql(sql: string): string {
    const m = sql.match(/(?:FROM|INTO|UPDATE|JOIN)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
    return m?.[1] ?? 'unknown';
}

// ─── Write actions to intercept ───
const WRITE_ACTIONS = new Set([
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
]);

// Actions that have before/after diff potential
const DIFF_ACTIONS = new Set(['update', 'upsert']);

// ─── Models to exclude from audit logging ───
const EXCLUDED_MODELS = new Set([
    'AuditLog', // Prevent infinite recursion
]);

/**
 * Simple cuid-like ID generator for audit log entries.
 */

/**
 * Build diff JSON for update/upsert operations.
 *
 * Strategy (pragmatic):
 * - Extract changedFields from params.args.data keys
 * - Extract redacted "after" values from the operation result
 * - Optionally include "before" snapshot for single-record updates
 *   (only if we can fetch it cheaply via the where clause)
 *
 * LIMITATION: We do NOT fetch "before" from the DB because:
 * 1. It would add latency to every update
 * 2. The record might already be changed by the time we read it
 * 3. For multi-tenant RLS contexts, a separate query might fail
 * Instead we capture changedFields + after snapshot.
 */
function buildDiffJson(
    action: string,
    data: Record<string, unknown> | null | undefined,
    result: unknown,
): Record<string, unknown> | null {
    if (!DIFF_ACTIONS.has(action) || !data) return null;

    const changedFields = extractChangedFields(data);
    if (changedFields.length === 0) return null;

    // Build redacted "after" snapshot from result, limited to changed fields
    const afterRaw: Record<string, unknown> = {};
    for (const field of changedFields) {
        if (result && typeof result === 'object' && field in result) {
            afterRaw[field] = (result as Record<string, unknown>)[field];
        }
    }

    const after = redactSensitiveFields(afterRaw);

    return {
        changedFields,
        after,
    };
}

/**
 * Audit-trail extension factory.
 *
 * Returns a Prisma 7 client extension that intercepts every WRITE
 * action ($allModels.create/update/upsert/delete/createMany/
 * updateMany/deleteMany) and writes a hash-chained AuditLog row
 * AFTER the operation completes. Best-effort — never breaks the
 * original write if audit logging itself fails.
 *
 * This was a `$use` middleware in Prisma 5; `$use` was removed in
 * Prisma 7. The new shape composes via `client.$extends({ query })`
 * with per-action handlers.
 *
 * Composition order MATTERS: this extension runs INSIDE soft-delete
 * + PII encryption + field-level encryption. Audit sees the final
 * transformed args (delete → update from soft-delete; encrypted
 * values from PII / field encryption) and logs them post-write.
 *
 * MUST only be wired in Node.js runtime (not Edge) — `appendAuditEntry`
 * pulls in heavy server deps. The wiring at module bottom guards
 * with `typeof EdgeRuntime === 'undefined'`.
 */
function buildAuditExtension() {
    // Per-action wrapper — same shape for create/update/upsert/delete/etc.
    // The Prisma 7 query extension API has separate handlers for each
    // operation; we factor the common audit logic into one function.
    const handle = async ({
        model,
        operation,
        args,
        query,
    }: {
        model: string;
        operation: string;
        args: Record<string, unknown>;
        query: (a: typeof args) => Promise<unknown>;
    }) => {
        // Fast-path non-write operations and excluded models. Reads
        // don't need audit; AuditLog itself must skip to avoid an
        // infinite write loop.
        if (!WRITE_ACTIONS.has(operation)) {
            return query(args);
        }
        if (EXCLUDED_MODELS.has(model)) {
            return query(args);
        }

        // ⚠️ Capture audit context BEFORE running the query —
        // Prisma's underlying execution may detach from the AsyncLocalStorage
        // chain.
        const ctx = getAuditContext();
        const tenantId = ctx?.tenantId;
        if (!tenantId) {
            return query(args);
        }

        const actorUserId = ctx?.actorUserId || null;
        const requestId = ctx?.requestId || null;
        const source = ctx?.source || 'api';

        // For upsert, the update payload is in args.update, not args.data.
        // `args` is typed as `object` by the Prisma query-extension API —
        // casting to a narrowed record shape is the correct probe pattern.
        const argsRecord = args as Record<string, unknown>;
        const updateData =
            operation === 'upsert'
                ? (argsRecord.update as Record<string, unknown> | null | undefined) ?? null
                : (argsRecord.data as Record<string, unknown> | null | undefined) ?? null;

        // Execute the original operation first — never block it
        const result = await query(args);

        // Best-effort audit logging — never throw
        try {
            const action = operation.toUpperCase();

            // Extract record ID(s) from the result
            let entityId = 'unknown';
            let recordIds: { count: number } | null = null;

            if (
                operation === 'create' ||
                operation === 'update' ||
                operation === 'upsert' ||
                operation === 'delete'
            ) {
                entityId = (result as { id?: string } | null)?.id || 'unknown';
            } else if (operation === 'createMany') {
                entityId = 'batch';
                recordIds = { count: (result as { count?: number } | null)?.count ?? 0 };
            } else if (operation === 'updateMany' || operation === 'deleteMany') {
                entityId = 'batch';
                recordIds = { count: (result as { count?: number } | null)?.count ?? 0 };
            }

            const metadataJson: Record<string, unknown> = { source };
            const argsWhere = argsRecord.where as Record<string, unknown> | null | undefined;
            if (
                argsWhere &&
                (operation === 'updateMany' || operation === 'deleteMany')
            ) {
                metadataJson.filterKeys = Object.keys(argsWhere);
            }

            const diffJson = buildDiffJson(operation, updateData, result);

            const detailsJson: Record<string, unknown> = {
                category: 'entity_lifecycle',
                entityName: model,
                operation: action.toLowerCase(),
            };
            if (diffJson) {
                detailsJson.changedFields = diffJson.changedFields;
                detailsJson.after = diffJson.after;
            }
            detailsJson.summary = `${action} ${model}${entityId !== 'unknown' ? ` ${entityId}` : ''}`;

            const { appendAuditEntry } = require('./audit/audit-writer');
            await appendAuditEntry({
                tenantId,
                userId: actorUserId,
                actorType: 'SYSTEM',
                entity: model,
                entityId,
                action,
                details: null,
                requestId,
                recordIds,
                metadataJson,
                diffJson,
                detailsJson,
            });
        } catch (auditError) {
            if (env.NODE_ENV === 'development') {
                auditMiddlewareLogger.warn('Failed to write audit log', {
                    component: 'audit-middleware',
                    error:
                        auditError instanceof Error
                            ? auditError.message
                            : String(auditError),
                });
            }
        }

        return result;
    };

    return {
        name: 'audit-middleware',
        query: {
            $allModels: {
                async create({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async createMany({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async update({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async updateMany({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async upsert({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async delete({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
                async deleteMany({ model, operation, args, query }: { model: string; operation: string; args: Record<string, unknown>; query: (a: typeof args) => Promise<unknown> }) {
                    return handle({ model, operation, args, query });
                },
            },
        },
    } as const;
}

// ─── Singleton ───
//
// Prisma 7 — `PrismaClient` requires an adapter for connections.
// The runtime adapter is `@prisma/adapter-pg` which speaks to
// Postgres directly. CLI tooling (prisma migrate / generate /
// studio) reads the URL via `prisma.config.ts` at the repo root.
//
// Middleware moved from `prisma.$use(...)` (removed in Prisma 7) to
// `client.$extends({ query: { ... } })`. Composition order is
// preserved from the v5 layout — `$extends` chains apply in
// reverse-call order: the LAST `.$extends(...)` is the OUTERMOST
// wrapper (intercepts caller first). To match the v5 order
// (PII outermost → soft-delete → audit innermost), the chain is:
//
//     baseClient
//       .$extends(audit)        // innermost — closest to DB
//       .$extends(softDelete)   // middle — delete → update transform
//       .$extends(piiEncryption) // outermost — first to see args
//
// The Epic A.1 RLS tripwire and Epic B field-level encryption work
// on per-transaction clients inside `runInTenantContext` (in
// `src/lib/db/rls-middleware.ts` + `src/lib/db/encryption-middleware.ts`)
// — they re-extend the inner transactional client, NOT this
// singleton.

type ExtendedClient = ReturnType<typeof buildClient>;

function buildClient(url: string = env.DATABASE_URL ?? ''): PrismaClient {
    // `??  ''` is load-bearing for build-time analysis. Next 16's
    // "Collecting page data" phase imports every route module to
    // discover route metadata, which transitively loads this module.
    // In that environment `SKIP_ENV_VALIDATION=1` is set but
    // `DATABASE_URL` is often unset — passing `undefined` to
    // `PrismaPg`'s `connectionString` throws ("p is not a function"
    // in the minified chunk) and the whole route fails to collect.
    // Falling back to an empty string lets module load succeed; the
    // first real query will surface the missing-URL error at request
    // time, not module-import time.
    //
    // The two pool limits below are DECLARED, not inherited (#2653).
    // `PrismaPg`'s first argument is a full `pg.PoolConfig`, so this is
    // the one call site where the product's connection ceiling is
    // settable. Derivations live in `db/concurrency-limits.ts`; the
    // short form:
    //   • `max`  — was node-postgres's default 10 (measured). 25 is the
    //     design point (k6 smoke, 25 VUs) and also PgBouncer's
    //     `DEFAULT_POOL_SIZE`, so a larger pool would only move the
    //     queue downstream where we cannot see it.
    //   • `connectionTimeoutMillis` — was `undefined`, i.e. wait
    //     forever (measured). Finite so pool exhaustion surfaces as an
    //     error instead of a hung request, and >= the largest per-call
    //     `maxWait` (10_000) so it does not silently preempt it.
    // NOTE: `connectionString` is untouched — the `?? ''` fallback
    // above is still what keeps "Collecting page data" working.
    const adapter = new PrismaPg({
        connectionString: url,
        max: DB_POOL_MAX,
        connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
    });
    const client = new PrismaClient({
        adapter,
        // Emit query events so the slow-query listener below can observe
        // duration. `emit: 'event'` keeps queries OFF stdout (no log spam)
        // — only the >50ms ones are logged, by us.
        log: [{ level: 'query', emit: 'event' }],
    });

    // Slow-query observability. INTERNAL ONLY: `e.query` is raw SQL and
    // `e.params` may contain PII bound values, so this is truncated hard
    // and NEVER shipped to per-tenant SIEMs via the audit-stream — it's a
    // local operational log + a model-labelled counter for Grafana.
    client.$on('query', (e) => {
        if (e.duration > SLOW_QUERY_THRESHOLD_MS) {
            auditMiddlewareLogger.warn('slow query', {
                component: 'prisma',
                query: e.query.slice(0, 500),
                params: e.params.slice(0, 200),
                durationMs: e.duration,
            });
            recordSlowQuery(parseModelFromSql(e.query));
        }
    });

    return client;
}

function buildExtended(url: string = env.DATABASE_URL ?? '') {
    const base = buildClient(url);
    if (typeof EdgeRuntime !== 'undefined') {
        // Edge Runtime — extensions either don't bundle or import
        // server-only deps (audit-writer pulls in node:crypto). Ship
        // the bare client; reads/writes won't have audit/PII logic
        // but Edge code paths don't perform writes that need them.
        return base as unknown as ReturnType<typeof base.$extends>;
    }
    // `withRlsTripwireExtension` is now imported statically at the
    // top of this file. The "circular import" comment that lived
    // here previously was only theoretical — `rls-middleware.ts`
    // only references `@/lib/prisma` from inside a function body
    // (`getPrismaClient()` for `runWithoutRls`), so there is no
    // module-init cycle. Turbopack's production bundle didn't
    // resolve the dynamic `require('./db/rls-middleware')` correctly
    // during Next 16's "Collecting page data" phase ("p is not a
    // function") which made the static form load-bearing.
    //
    // Composition order — the tripwire is observation-only so its
    // position in the chain is irrelevant; placing it outermost
    // makes the logged model/action match the caller's intent
    // before soft-delete / PII rewrite.
    // Composition note: Epic B field-level encryption sits between
    // soft-delete (which rewrites delete → update) and PII (GAP-21,
    // which encrypts User/AuditorAccount email/name). Inner-to-outer:
    //   audit → soft-delete → field-encryption → PII → RLS-tripwire
    // Field-encryption needs to see the post-soft-delete write args
    // (so encrypt happens on the rewritten update payload) but BEFORE
    // PII rewrites where-clauses, since the two cover disjoint
    // models. The Prisma 7 migration introduced field-encryption as a
    // separate `withEncryptionExtension` but never wired it back into
    // the chain — restoring it here restores Epic B's at-rest
    // contract.
    return withRlsTripwireExtension(
        withPiiEncryptionExtension(
            withEncryptionExtension(
                withSoftDeleteExtension(
                    base.$extends(buildAuditExtension()),
                ),
            ),
        ),
    );
}

const globalForPrisma = globalThis as unknown as {
    prisma?: ExtendedClient;
    prismaRead?: ExtendedClient;
};

export const prisma = (globalForPrisma.prisma ?? buildExtended()) as ExtendedClient;

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// ─── Read-replica client (Epic: read-replica routing) ───
//
// A SECOND extended client pointed at DATABASE_READ_URL (the replica,
// via its own PgBouncer). It carries the SAME extension chain as the
// primary — crucially the field-encryption + PII extensions, so reads
// of encrypted columns DECRYPT correctly, and soft-delete, so
// `deletedAt` filtering still applies. The audit extension only acts on
// writes, so it's inert here.
//
// Reads are NOT auto-routed: callers OPT IN via `runInTenantReadContext`
// (which opens its RLS transaction on this client). Routing is a
// deliberate, reviewable choice at the usecase boundary — NEVER for
// read-after-write or auth/billing paths. See docs/database-routing.md.
//
// When DATABASE_READ_URL is unset, `prismaRead === prisma` — single-DB
// mode, and `runInTenantReadContext` transparently uses the primary.
// This makes unsetting DATABASE_READ_URL the safe rollback for a
// replica incident.
//
// Edge runtime never sees a replica URL (DB access is Node-only), so the
// guard naturally falls back to `prisma`.
export const prismaRead = (
    env.DATABASE_READ_URL && typeof EdgeRuntime === 'undefined'
        ? (globalForPrisma.prismaRead ?? buildExtended(env.DATABASE_READ_URL))
        : prisma
) as ExtendedClient;

if (env.NODE_ENV !== 'production' && env.DATABASE_READ_URL) {
    globalForPrisma.prismaRead = prismaRead;
}

// Diagnostic — log once per process that the extended client is
// constructed. Pairs with the per-invocation logging inside
// pii-middleware.ts to distinguish:
//   • both seen           → extension works
//   • constructed, no inv. → adapter is on a different prisma instance
//   • no constructed log  → Edge Runtime path skipped extension wiring
if (typeof EdgeRuntime === 'undefined') {
    auditMiddlewareLogger.info('pii.middleware_registered', {
        component: 'pii-middleware',
        runtime: 'node',
        nodeEnv: env.NODE_ENV,
    });
}

/**
 * Explicit global export for admin operations / scripts that need
 * to bypass RLS by running without a tenant context.
 */
export function getPrisma() {
    return prisma;
}

export { withTenantDb } from './db-context';

export default prisma;
