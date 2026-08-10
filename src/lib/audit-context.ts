/**
 * Audit Context — request-scoped context store for the Prisma extensions.
 *
 * This carries the tenant identity that the encryption extension uses to pick
 * a DEK and the audit writer uses to stamp rows. Getting it wrong is not a
 * logging inconvenience: it seals one tenant's data with another tenant's key.
 *
 * ─── WHY AsyncLocalStorage, AND WHY IT DIDN'T USE TO ────────────────
 *
 * Until 2026-08-10 this was a module-level LIFO stack, with a design note
 * arguing it was safe because "Node.js is single-threaded — no race conditions
 * between set/get" and the context is "read synchronously within the $use
 * middleware on the same tick".
 *
 * Both halves have since become false, and the first was never true.
 *
 * Single-threaded rules out PARALLELISM, not CONCURRENCY. A module-level stack
 * is shared by every in-flight request, and `fn()` here is async — it awaits.
 * Everything another request does during that await interleaves:
 *
 *     request A: push(ctxA)            stack: [A]
 *     request A: await db…             (yields)
 *     request B: push(ctxB)            stack: [A, B]
 *     request B: await db…             (yields)
 *     request A: extension reads top   → ctxB          ← A encrypts with B's key
 *     request A: finishes, pop()       → removes B     ← and corrupts B's frame
 *
 * `pop()` removes whatever is on top, not the entry this call pushed, so a
 * request finishing out of order tears down someone else's context as well.
 *
 * The second half — "$use loses ALS state" — was a real Prisma limitation and
 * is why the stack was chosen. The codebase has since moved entirely to client
 * extensions (`$extends` / `$allOperations`); there is no `$use` middleware
 * left. Extensions run in the caller's async context, so ALS propagates
 * normally and the reason to hand-roll a stack is gone.
 *
 * ─── WHAT THIS COST ─────────────────────────────────────────────────
 *
 * One CI run, with the write-side detector from #1844 in place, recorded 613
 * writes whose row `tenantId` disagreed with the ambient context — 15 distinct
 * ambient tenants against 16 row tenants, single ambient ids paired with as
 * many as 265 rows belonging to other tenants. It concentrated on the slowest
 * multi-write routes (onboarding step, framework install), which is exactly
 * where a request holds its frame open longest and is most likely to be
 * interleaved. Downstream it surfaced as `DecryptIntegrityError` 500s on
 * unrelated reads, ~6-9 per run, present on green runs too.
 *
 * AsyncLocalStorage gives each async execution its own view: a store entered
 * by one request is invisible to another, and nesting is real nesting rather
 * than a shared stack that anyone can pop.
 *
 * Usage:
 *   await runWithAuditContext({ tenantId, actorUserId: userId, requestId }, async () => {
 *       await prisma.risk.create({ data: { ... } });
 *   });
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuditContextData {
    /** Tenant ID for the current request */
    tenantId?: string;
    /** Authenticated user ID performing the operation */
    actorUserId?: string;
    /** Request correlation ID */
    requestId?: string;
    /** Source of the operation: "api" | "job" | "seed" | "system" */
    source?: string;
}

/**
 * One store per async execution.
 *
 * A module-level singleton is correct here and is not the shared-mutable-state
 * the old stack was: ALS keys its value to the async resource tree, so two
 * concurrent requests reading this same object see different stores.
 */
const auditContextStore = new AsyncLocalStorage<AuditContextData>();

/**
 * Thenable rather than `instanceof Promise`: Prisma returns PrismaPromise
 * objects, which are thenable but not Promises.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
    return value != null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Execute a function within an audit context.
 *
 * All Prisma operations within `fn` — including anything it awaits — read this
 * context via `getAuditContext()`. Nesting works: an inner call shadows the
 * outer one for its own subtree only, and the outer context is intact
 * afterwards without anyone having to pop it.
 *
 * Sync and async callers are both supported. `als.run` returns whatever `fn`
 * returns; when that is a promise the context stays alive for its whole
 * continuation chain, which is the property the old implementation tried to
 * emulate with a thenable wrapper and got wrong under concurrency.
 */
export function runWithAuditContext<T>(
    ctx: AuditContextData,
    fn: () => T | Promise<T>,
): T | Promise<T> {
    // A fresh object per entry. Sharing the caller's would let
    // `mergeAuditContext` inside the callee mutate an object the caller still
    // holds — the same aliasing class this file exists to eliminate.
    return auditContextStore.run({ ...ctx }, () => {
        const result = fn();

        // A PrismaPromise is LAZY: building it runs no query. The query fires
        // when something calls `.then` on it, and `als.run` has already
        // returned by then — so a caller written as
        // `runWithAuditContext(ctx, () => prisma.x.findFirst(…))` would execute
        // its query with NO context and silently fall back to the global KEK.
        //
        // Awaiting here keeps the trigger inside the store's scope, so the
        // extension sees the context. The old stack got this right by
        // accident (it stayed pushed until the thenable settled) and got
        // concurrency wrong; this keeps the laziness handling and drops the
        // shared-stack part.
        //
        // Sync callbacks are returned untouched — the signature promises `T`,
        // not `Promise<T>`, and wrapping them would change every sync caller.
        if (isThenable(result)) {
            return (async () => await result)() as T | Promise<T>;
        }
        return result;
    });
}

/**
 * Get the current audit context, or undefined if not within a
 * `runWithAuditContext` call.
 */
export function getAuditContext(): AuditContextData | undefined {
    return auditContextStore.getStore();
}

/**
 * Set/override individual fields on the current audit context.
 * Only works if already inside a `runWithAuditContext` call.
 * Returns false if no context is active.
 *
 * Mutates the store in place, so the change is visible to everything already
 * running inside this context — and, because the store belongs to this async
 * subtree, invisible to every other request.
 */
export function mergeAuditContext(partial: Partial<AuditContextData>): boolean {
    const store = auditContextStore.getStore();
    if (!store) return false;
    Object.assign(store, partial);
    return true;
}
