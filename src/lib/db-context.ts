import { PrismaClient } from '@prisma/client';
import { prisma, prismaRead } from './prisma';
import type { RequestContext } from '@/app-layer/types';
import { runWithAuditContext } from './audit-context';
import { KEK_BYPASS_SOURCES, isKekBypassSource } from './db/kek-bypass-sources';

export type PrismaTx = Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Runs a function within a Prisma transaction where the Postgres session
 * variable `app.tenant_id` is set to the provided tenantId.
 * 
 * Because RLS policies are FORCED, any query reading/writing to tenant-scoped
 * tables inside this callback will automatically have its results filtered to
 * the specified tenant.
 * 
 * Also binds audit context so the Prisma middleware can correlate writes.
 * 
 * @see runInTenantContext — preferred API for usecases (accepts full RequestContext)
 */
export async function withTenantDb<T>(
    tenantId: string,
    callback: (tx: PrismaTx) => Promise<T>,
    customPrisma?: PrismaClient // used for testing to dependency-inject the client
): Promise<T> {
    const p = customPrisma || prisma;

    // Bind audit context so middleware can access tenantId
    return runWithAuditContext({ tenantId, source: 'api' }, () =>
        p.$transaction(async (tx) => {
            // Drop superuser privileges to ensure RLS policies are enforced
            await tx.$executeRaw`SET LOCAL ROLE app_user`;
            // Use SET LOCAL to scope the variable to the current transaction.
            // It automatically resets when the transaction commits or rolls back.
            // $executeRaw safely parameterizes the value.
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            return callback(tx);
        })
    ) as Promise<T>;
}

/**
 * Preferred usecase-level helper. Accepts a full RequestContext and:
 * 1. Sets `app.tenant_id` for RLS enforcement (via withTenantDb)
 * 2. Sets `app.request_id` for log/audit correlation
 * 3. Binds full audit context (tenantId + userId + requestId) for middleware
 *
 * Usage:
 * ```ts
 * export async function listAssets(ctx: RequestContext) {
 *     return runInTenantContext(ctx, (db) => AssetRepository.list(db, ctx));
 * }
 * ```
 */
export async function runInTenantContext<T>(
    ctx: RequestContext,
    callback: (db: PrismaTx) => Promise<T>,
    options?: { customPrisma?: PrismaClient; timeout?: number; maxWait?: number }
): Promise<T> {
    const p = options?.customPrisma || prisma;
    const txOptions: { timeout?: number; maxWait?: number } = {};
    if (options?.timeout) txOptions.timeout = options.timeout;
    if (options?.maxWait) txOptions.maxWait = options.maxWait;

    // Bind full audit context so middleware can access tenantId, userId, requestId
    return runWithAuditContext(
        {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            requestId: ctx.requestId,
            source: 'api',
        },
        () =>
            p.$transaction(async (tx) => {
                await tx.$executeRaw`SET LOCAL ROLE app_user`;
                // PR3 perf: combine the two GUC writes into ONE round-trip
                // (was two separate `SELECT set_config(...)` calls). RLS
                // isolation is unchanged — same transaction-local
                // `app.tenant_id` (the RLS predicate) + `app.request_id`
                // (audit correlation), same `app_user` role. Cuts per-context
                // RLS setup from 3 round-trips to 2; the executive dashboard
                // alone opens ~6 such contexts, removing ~6 round-trips/load.
                await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.request_id', ${ctx.requestId}, true)`;
                return callback(tx);
            }, txOptions)
    ) as Promise<T>;
}


/**
 * Read-replica variant of {@link runInTenantContext}, for reads where
 * replication lag is acceptable: dashboards, aggregations, reporting.
 *
 * Identical RLS posture (sets `app_user` role + `app.tenant_id` /
 * `app.request_id`) but:
 *   1. Opens the transaction on `prismaRead` — the replica client when
 *      `DATABASE_READ_URL` is set; otherwise `prismaRead === prisma` and
 *      this is transparently identical to `runInTenantContext` (single-DB
 *      mode / the safe rollback when the replica is unset).
 *   2. Marks the transaction `READ ONLY`, so a write accidentally routed
 *      into a read context fails fast — enforcing the "no writes on the
 *      replica path" rule at runtime, not just in review.
 *
 * NEVER use for read-after-write, auth, session, or billing reads — those
 * MUST stay on the primary via `runInTenantContext`. See
 * docs/database-routing.md.
 *
 * ```ts
 * export async function getControlDashboard(ctx: RequestContext) {
 *     return runInTenantReadContext(ctx, (db) => ControlRepository.dashboard(db, ctx));
 * }
 * ```
 */
export async function runInTenantReadContext<T>(
    ctx: RequestContext,
    callback: (db: PrismaTx) => Promise<T>,
    options?: { timeout?: number; maxWait?: number }
): Promise<T> {
    const txOptions: { timeout?: number; maxWait?: number } = {};
    if (options?.timeout) txOptions.timeout = options.timeout;
    if (options?.maxWait) txOptions.maxWait = options.maxWait;

    return runWithAuditContext(
        {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            requestId: ctx.requestId,
            source: 'api',
        },
        () =>
            prismaRead.$transaction(async (tx) => {
                await tx.$executeRaw`SET LOCAL ROLE app_user`;
                // READ ONLY before the first data statement — SET ROLE
                // above doesn't count as one. set_config() is allowed in a
                // read-only tx (it mutates session state, not tables).
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.request_id', ${ctx.requestId}, true)`;
                return callback(tx);
            }, txOptions)
    ) as Promise<T>;
}

/**
 * Tenant context for a background job — the same RLS posture as
 * {@link runInTenantContext}, without a `RequestContext` to build.
 *
 * ## Why a job needs its own door
 *
 * `runJob` binds the OBSERVABILITY request context (`lib/observability/
 * context.ts`) — an AsyncLocalStorage store carrying `requestId`, `route`,
 * and `tenantId` for logs and traces. The Prisma extensions read a DIFFERENT
 * store, the audit context in `lib/audit-context.ts`. Two stores, no bridge
 * between them, and nothing in a job's shape makes that visible: a job with a
 * perfectly good `tenantId` on its payload still leaves `getAuditContext()`
 * undefined for every query it makes.
 *
 * What that costs, in the order an operator notices it:
 *
 *   1. **No RLS.** The connection never becomes `app_user` and
 *      `app.tenant_id` is never set, so `superuser_bypass` matches and the
 *      database enforces nothing. An unattended bulk write is left standing
 *      on its application-layer `where` clause alone — for the one class of
 *      code where "one layer is enough" is least defensible.
 *   2. **No auto-audit.** `lib/prisma.ts`'s audit extension returns early
 *      when the audit context carries no `tenantId`, so a job's writes are
 *      absent from the trail its API-path equivalents land in.
 *   3. **A `missing_tenant_context` warn per write**, which is the tripwire
 *      correctly reporting 1 and 2.
 *
 * ## Why not just label the job
 *
 * The reflex fix is `runWithAuditContext({ tenantId, source: 'job' }, …)`.
 * That silences the tripwire and fixes nothing: `'job'` is a
 * {@link KEK_BYPASS_SOURCES} label, so the encryption middleware stops
 * resolving the tenant DEK. Encrypted reads come back `null`, encrypted
 * writes get sealed under the global KEK, and neither failure is loud. This
 * function REFUSES those labels at the door rather than documenting the
 * hazard and hoping.
 *
 * Pass `source` as the JOB'S OWN NAME (`'av-rescan'`). It reaches the audit
 * trail as `metadataJson.source`, so the row says which unattended writer
 * touched the tenant — the thing `'api'` would actively misreport.
 *
 * ## What it costs, and when NOT to use it
 *
 * This opens a transaction. Hold it around the WRITE, never around an
 * out-of-process round trip — a scanner call or an HTTP fetch inside here
 * pins a Postgres backend, and through PgBouncer a pooled server connection,
 * for its whole duration.
 *
 * It is also the wrong tool for a genuinely cross-tenant sweep. One tenant id
 * is a precondition, not a formality: a sweep that iterates every tenant
 * wants `runWithoutRls({ reason: 'cross-tenant-sweep' })`, which says so.
 */
export async function runInTenantJobContext<T>(
    job: {
        tenantId: string;
        /** The job's own name. Never a {@link KEK_BYPASS_SOURCES} label. */
        source: string;
        /** Operator or system actor to attribute writes to, when there is one. */
        actorUserId?: string | null;
        /** Correlation id — `runJob`'s `jobRunId` unless the trigger had one. */
        requestId?: string | null;
    },
    callback: (db: PrismaTx) => Promise<T>,
    options?: { customPrisma?: PrismaClient; timeout?: number; maxWait?: number }
): Promise<T> {
    if (!job.tenantId) {
        throw new Error(
            'runInTenantJobContext requires a tenantId — a job with no single ' +
                'tenant wants runWithoutRls({ reason: "cross-tenant-sweep" }).'
        );
    }
    if (isKekBypassSource(job.source)) {
        throw new Error(
            `runInTenantJobContext refuses source '${job.source}': it is one of ` +
                `the tenant-less labels (${[...KEK_BYPASS_SOURCES].join(', ')}), which ` +
                `turn the per-tenant DEK OFF — encrypted reads would come back null ` +
                `and encrypted writes would be sealed under the global KEK. Pass the ` +
                `job's own name instead.`
        );
    }

    const p = options?.customPrisma || prisma;
    const txOptions: { timeout?: number; maxWait?: number } = {};
    if (options?.timeout) txOptions.timeout = options.timeout;
    if (options?.maxWait) txOptions.maxWait = options.maxWait;

    const requestId = job.requestId ?? `job:${job.source}`;

    return runWithAuditContext(
        {
            tenantId: job.tenantId,
            actorUserId: job.actorUserId ?? undefined,
            requestId,
            source: job.source,
        },
        () =>
            p.$transaction(async (tx) => {
                await tx.$executeRaw`SET LOCAL ROLE app_user`;
                await tx.$executeRaw`SELECT set_config('app.tenant_id', ${job.tenantId}, true), set_config('app.request_id', ${requestId}, true)`;
                return callback(tx);
            }, txOptions)
    ) as Promise<T>;
}

/**
 * Executes a callback with the global Prisma Client, bypassing RLS.
 * Use this SAFELY and specifically for unauthenticated public routes
 * where tenant context cannot be established (e.g. share links).
 */
export async function runInGlobalContext<T>(
    callback: (db: PrismaTx) => Promise<T>,
    customPrisma?: PrismaClient
): Promise<T> {
    return callback(customPrisma || prisma);
}
