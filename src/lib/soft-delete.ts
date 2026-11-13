/**
 * Soft-Delete Middleware for Prisma
 *
 * Transforms hard deletes into soft deletes (setting deletedAt) and
 * automatically filters out soft-deleted records from reads.
 *
 * ALLOWLIST: Only models listed in SOFT_DELETE_MODELS are affected.
 * All other models retain hard-delete semantics.
 */
import { getAuditContext } from './audit-context';

// ─── Models that support soft delete ───
// Must match SOFT_DELETE_TARGETS in src/lib/security/classification.ts
export const SOFT_DELETE_MODELS = new Set([
    // P0 — already had deletedAt
    'Asset',
    'Risk',
    'Control',
    'Evidence',
    'Policy',
    // P1 — added in soft-delete rollout migration
    'Vendor',
    'FileRecord',
    // P2
    'Task',
    'Finding',
    // P3
    'Audit',
    'AuditCycle',
    'AuditPack',
    // Bulk-delete support (row-select action bar) — deletedAt added in
    // 20260628120000_control_test_plan_soft_delete.
    'ControlTestPlan',
]);

// ─── Read actions that should filter out deleted records ───

// ─── Delete actions to intercept ───

// ─── Internal flag for opt-out ───
const INCLUDE_DELETED_KEY = '__includeDeleted';

/**
 * Helper to opt out of soft-delete read filtering.
 * Usage: db.asset.findMany(withDeleted({ where: { tenantId } }))
 *
 * Sets a magic key that the middleware strips before passing to Prisma.
 */
export function withDeleted<T extends Record<string, unknown>>(args: T): T {
    return { ...args, [INCLUDE_DELETED_KEY]: true };
}

/**
 * @deprecated v5 mutating shape — Prisma 7 removed `$use`. Use
 * `withSoftDeleteExtension(client)` instead, which returns a new
 * extended client. This stub remains so existing test files that
 * import the legacy name continue to compile; on the production
 * singleton in `src/lib/prisma.ts` the extension is already wired
 * via `withSoftDeleteExtension`, so this call is a no-op there.
 *
 * FIXME — remove once all callers have migrated to the extension.
 */
export function registerSoftDeleteMiddleware(_client: unknown): void {
    /* no-op — see docstring */
}

/**
 * Wire the soft-delete extension onto a Prisma 7 client.
 *
 * Migrated from `client.$use(...)` (removed in Prisma 7) to
 * `client.$extends({ query: { $allModels: ... } })`. The semantics
 * are identical:
 *
 *   - `delete` / `deleteMany` on allowlisted models → transformed
 *     to `update` / `updateMany` setting `deletedAt`.
 *   - Read actions (`findUnique` / `findFirst` / `findMany` / `count`
 *     / `aggregate` / `groupBy`) → injected `where.deletedAt = null`
 *     unless the caller used `withDeleted(...)` or explicitly set
 *     a `deletedAt` filter.
 *
 * Composition: this extension MUST sit OUTSIDE the audit extension
 * so audit logs the transformed `update` operation, not the original
 * `delete`. The chain in `src/lib/prisma.ts` enforces this.
 *
 * Returns the extended client so callers can chain further extensions.
 */
export function withSoftDeleteExtension<T extends object>(
    client: T,
): T {
    // Internal alias — the extended client carries per-model query
    // methods (`client.asset.update`, `.updateMany`, …) but the
    // generic `T` doesn't expose them statically. Cast through
    // `unknown` to a keyed record once; per-action handlers
    // dispatch into it without restating the cast at every call
    // site, which keeps the file under the explicit-`any` ratchet.
    type ModelOps = {
        update: (a: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => Promise<unknown>;
        updateMany: (a: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => Promise<unknown>;
    };
    const c = client as unknown as Record<string, ModelOps>;
    const modelOps = (model: string): ModelOps =>
        c[model.charAt(0).toLowerCase() + model.slice(1)];

    return (client as { $extends: (cfg: unknown) => unknown }).$extends({
        name: 'soft-delete',
        query: {
            $allModels: {
                async delete({ model, args, query }: { model: string; args: { where?: Record<string, unknown> }; query: (a: unknown) => Promise<unknown> }) {
                    if (!SOFT_DELETE_MODELS.has(model)) return query(args);
                    const ctx = getAuditContext();
                    const deletedByUserId = ctx?.actorUserId || null;
                    const data = { deletedAt: new Date(), deletedByUserId };
                    // ── THE CALLER'S TRANSACTION, WHEN THERE IS ONE (#5287) ──
                    //
                    // `query` is bound to the `delete` operation, so it cannot
                    // carry out the rewritten `update`. That part of the old
                    // comment was right. What it missed is that
                    // `modelOps(model)` is the client this extension was BUILT
                    // on — so the write went out on another pooled connection:
                    // it committed immediately (a later failure in the
                    // caller's transaction rolled back the audit rows and left
                    // the row deleted) and it ran as the OWNING role, where
                    // `superuser_bypass` matches and RLS no longer applies.
                    //
                    // `softDeleteWrite` is the transaction-bound writer
                    // `db-context.ts` threads through the audit context, the
                    // same remedy `readPriorState` uses for the audit
                    // extension's prior-state read and for the same reason.
                    //
                    // Absent means there is NO tenant transaction in scope — a
                    // job on the global client, a seed — and there this
                    // extension's own client IS the caller's client, so
                    // dispatching to it is correct rather than a fallback.
                    // Measured: 14 of the 16 soft-delete call sites are
                    // transactional; `jobs/evidence-import.ts` and
                    // `services/evidence-blob-purge.ts` are not.
                    if (ctx?.softDeleteWrite) {
                        return ctx.softDeleteWrite(model, { where: args.where, data }, false);
                    }
                    return modelOps(model).update({ where: args.where, data });
                },
                async deleteMany({ model, args, query }: { model: string; args: { where?: Record<string, unknown> }; query: (a: unknown) => Promise<unknown> }) {
                    if (!SOFT_DELETE_MODELS.has(model)) return query(args);
                    const ctx = getAuditContext();
                    const deletedByUserId = ctx?.actorUserId || null;
                    const data = { deletedAt: new Date(), deletedByUserId };
                    // Same reasoning as `delete` above (#5287).
                    if (ctx?.softDeleteWrite) {
                        return ctx.softDeleteWrite(model, { where: args.where, data }, true);
                    }
                    return modelOps(model).updateMany({ where: args.where, data });
                },
                async findUnique({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async findFirst({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async findMany({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async count({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async aggregate({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async groupBy({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
            },
        },
    }) as T;
}

/**
 * Shared read-action helper — strips the opt-out flag, respects
 * caller-supplied `deletedAt` filters, otherwise injects
 * `where.deletedAt = null` on allowlisted models.
 */
async function runRead(
    model: string,
    args: Record<string, unknown>,
    query: (a: unknown) => Promise<unknown>,
): Promise<unknown> {
    if (!SOFT_DELETE_MODELS.has(model)) return query(args);

    // Caller used `withDeleted(...)` — strip the magic flag and
    // pass through unchanged. (We mutate a shallow clone so we
    // don't perturb the caller's args object.)
    if ((args as Record<string, unknown>)[INCLUDE_DELETED_KEY]) {
        const next = { ...args } as Record<string, unknown>;
        delete next[INCLUDE_DELETED_KEY];
        return query(next);
    }

    const where = (args as { where?: Record<string, unknown> })?.where;
    if (where?.deletedAt !== undefined) {
        // Caller explicitly controls deletedAt — don't override
        return query(args);
    }

    // Inject deletedAt: null filter
    const next = {
        ...args,
        where: {
            ...((args as Record<string, unknown>).where as Record<string, unknown> | undefined),
            deletedAt: null,
        },
    };
    return query(next);
}
