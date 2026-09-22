/**
 * `assertPermission` and the pure helpers it needs — extracted so that code
 * the BullMQ WORKER can reach never imports the HTTP middleware.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `permission-middleware.ts` imports `getTenantCtx` from `@/app-layer/context`
 * for its route wrappers, and that module reaches `@/lib/auth` then `@/auth`,
 * which builds the NextAuth provider array at module scope and pulls
 * `next/headers`. Neither survives the worker's plain-Node runtime:
 *
 *     ERR_MODULE_NOT_FOUND  next/headers          (at boot)
 *     TypeError: Google is not a function         (at job execution)
 *
 * `src/lib/mcp/authorize.ts` needs only `assertPermission`, and every driver
 * reaches `authorize.ts`. So the moment a JOB executed a run, that single
 * import dragged the whole NextAuth tree into the worker —
 * `tests/guards/worker-import-graph.test.ts` exists for exactly that chain,
 * and it caught this one before it shipped.
 *
 * Nothing here imports a context builder. The split mirrors
 * `app-layer/context-system.ts`, carved out of `context.ts` for the same
 * reason and the same runtime.
 *
 * `permission-middleware.ts` re-exports these, so request-side imports are
 * unchanged. NEW worker-reachable code should import from HERE.
 */
import type { PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { forbidden } from '@/lib/errors/types';
import { appendAuditEntryOrQueue } from '@/lib/audit';

import { hasPermission } from './permission-key';
import type { PermissionKey } from './permission-key';

/**
 * Strategy when more than one permission is supplied.
 *   - `'all'` (default): every key must be granted.
 *   - `'any'`: at least one key must be granted.
 */
export type PermissionMode = 'all' | 'any';

/**
 * Emit a structured AUTHZ_DENIED audit entry, or fail closed (#2657).
 *
 * THIS USED TO SWALLOW. The catch here logged a warning and let the
 * request proceed, so a denial could happen with no audit row and the
 * only trace was a log line. The denial still happened, the user was
 * still refused, and the evidence that we refused them was gone.
 *
 * `appendAuditEntryOrQueue` replaces that with three outcomes the
 * caller can distinguish: the entry reaches the hash chain, or a
 * durable `AuditOutbox` row exists instead and is drained out-of-band,
 * or it throws. There is no outcome where the entry is gone and nobody
 * knows.
 *
 * WHY THROWING IS NOW CORRECT HERE, HAVING BEEN WRONG BEFORE. The old
 * comment's reasoning — "the denial response must always reach the
 * client even if audit storage is unavailable" — was sound against the
 * alternative it faced, which was propagating EVERY append failure. It
 * is not sound against this one. The throw now happens only when the
 * chain write AND the outbox insert both fail, and those have different
 * failure modes: the append serialises on a per-tenant advisory lock
 * (#2653), the outbox insert takes no lock at all. Both failing means
 * the database is unreachable, and a request whose authorization
 * decision cannot be recorded should not quietly succeed in being
 * refused — it should surface as an error, which is visible, rather
 * than as a gap in the trail, which is not.
 */
async function auditPermissionDenied(
    ctx: RequestContext,
    keys: readonly PermissionKey[],
    reqMeta: { method: string; path: string },
): Promise<void> {
    await appendAuditEntryOrQueue({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'Permission',
        entityId: keys.join(','),
        action: 'AUTHZ_DENIED',
        details: `Permission denied for ${reqMeta.method} ${reqMeta.path}`,
        detailsJson: {
            // `access` is the canonical category for authz events
            // per the audit details schema.
            category: 'access',
            event: 'authz_denied',
            permissionKeys: keys,
            role: ctx.role,
            apiKeyId: ctx.apiKeyId ?? null,
            method: reqMeta.method,
            path: reqMeta.path,
        },
        requestId: ctx.requestId,
        metadataJson: {
            role: ctx.role,
            apiKeyId: ctx.apiKeyId ?? null,
        },
    });
}

export function normaliseRequirement(
    required:
        | PermissionKey
        | readonly PermissionKey[]
        | { keys: readonly PermissionKey[]; mode?: PermissionMode },
): { keys: readonly PermissionKey[]; mode: PermissionMode } {
    if (typeof required === 'string') {
        return { keys: [required], mode: 'all' };
    }
    if (Array.isArray(required)) {
        if (required.length === 0) {
            // An empty list would silently grant access — fail loud at
            // boot so a misconfigured route never ships.
            throw new Error(
                'requirePermission: at least one permission key is required',
            );
        }
        return { keys: required, mode: 'all' };
    }
    const obj = required as {
        keys: readonly PermissionKey[];
        mode?: PermissionMode;
    };
    if (!obj.keys || obj.keys.length === 0) {
        throw new Error(
            'requirePermission: at least one permission key is required',
        );
    }
    return { keys: obj.keys, mode: obj.mode ?? 'all' };
}

function checkPermissions(
    appPermissions: PermissionSet,
    keys: readonly PermissionKey[],
    mode: PermissionMode,
): boolean {
    if (mode === 'any') {
        return keys.some((k) => hasPermission(appPermissions, k));
    }
    return keys.every((k) => hasPermission(appPermissions, k));
}

/**
 * The permission decision itself — check, audit the denial, throw.
 *
 * EXTRACTED FROM `requirePermission` so a caller that is not an HTTP route can
 * reach the SAME gate. `requirePermission` is a route wrapper: it resolves a
 * context from `params` + `req` and then makes this decision. The MCP tool
 * funnel already holds a resolved context and has no `params`, so before this
 * existed the only way to gate a tool was to re-implement the decision — a
 * second authorization path over the same `PermissionSet`, free to drift from
 * the one the equivalent human route uses. There is now one.
 *
 * Denials write exactly ONE hash-chained `AUTHZ_DENIED` row and throw the
 * generic `forbidden('Permission denied')`; the key never reaches the caller.
 */
export async function assertPermission(
    ctx: RequestContext,
    required:
        | PermissionKey
        | readonly PermissionKey[]
        | { keys: readonly PermissionKey[]; mode?: PermissionMode },
    reqMeta: { method: string; path: string },
): Promise<void> {
    const { keys, mode } = normaliseRequirement(required);
    if (checkPermissions(ctx.appPermissions, keys, mode)) return;
    await auditPermissionDenied(ctx, keys, reqMeta);
    throw forbidden('Permission denied');
}
