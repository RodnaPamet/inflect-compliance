/**
 * API permission middleware (Epic C — Defense-in-Depth, layer 1).
 *
 * Server-side enforcement of `PermissionSet` against route handlers, so
 * the API never trusts UI visibility or client-side guards. Composes with
 * `withApiErrorHandling` and the existing `getTenantCtx()` flow.
 *
 *   import { withApiErrorHandling } from '@/lib/errors/api';
 *   import { requirePermission } from '@/lib/security/permission-middleware';
 *
 *   export const POST = withApiErrorHandling(
 *       requirePermission('risks.create', async (req, { params }, ctx) => {
 *           // ctx is the resolved RequestContext; permission has been verified.
 *           return NextResponse.json(await createRisk(ctx, await req.json()));
 *       }),
 *   );
 *
 * Denials throw `forbidden('Permission denied')` which the surrounding
 * error wrapper converts to a 403 JSON response. The reason string is
 * kept generic so the response cannot be used to enumerate the
 * permission key namespace; the structured audit event captures the
 * actual key for security review.
 *
 * The middleware is permission-key driven, not role driven, so the same
 * helper covers built-in roles, custom roles, and (future) API-key
 * scope checks. It is the ONLY admin-authorization guard in the
 * codebase: the legacy role-tier helpers (`requireAdminCtx` and its
 * `requireWriteCtx` / `requireRoleCtx` siblings) were removed once every
 * route had migrated. The ratchet at
 * `tests/guardrails/no-legacy-admin-guard.test.ts` keeps them gone.
 */

import type { NextRequest, NextResponse } from 'next/server';
import type { PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { getTenantCtx } from '@/app-layer/context';
import { forbidden } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';

// ─── Permission key shape ───────────────────────────────────────────

/**
 * Dotted permission key derived from `PermissionSet`. Examples:
 *   - "controls.create"
 *   - "evidence.upload"
 *   - "admin.scim"
 *
 * Compile-time exhaustive — adding a new entry to `PermissionSet`
 * automatically widens this union; misspelled keys fail to compile.
 */
// `PermissionKey` and `hasPermission` now live in ./permission-key, a LEAF
// module with no edge to `@/app-layer/context` → `@/lib/auth` → `@/auth`.
//
// Re-exported here so the ~40 request-side call sites keep their import, but a
// module that runs in the BullMQ WORKER must import from './permission-key'
// directly — importing them from here drags the whole NextAuth provider array
// into a plain Node process, which fails at job EXECUTION rather than at boot.
// See ./permission-key for the full failure and why it does not fail CI.
export { hasPermission, type PermissionKey } from './permission-key';
import { hasPermission } from './permission-key';
import type { PermissionKey } from './permission-key';

// ─── Handler signature plumbing ─────────────────────────────────────

/**
 * Route handler signature consumed by `requirePermission`. Mirrors the
 * App Router `(req, { params })` shape and adds the resolved
 * `RequestContext` as a third argument so the handler doesn't need to
 * re-resolve it (saves a round-trip through `getTenantCtx`).
 */
export type PermissionedHandler<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
> = (
    req: NextRequest,
    routeArgs: { params: TParams },
    ctx: RequestContext,
) => Promise<TResponse> | TResponse;

/**
 * Plain App Router handler signature returned by the wrapper so the
 * outer `withApiErrorHandling` (which doesn't know about ctx) keeps
 * type-checking cleanly.
 */
export type RouteHandler<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
> = (
    req: NextRequest,
    routeArgs: { params: TParams },
) => Promise<TResponse>;

// ─── Audit + logging ────────────────────────────────────────────────

/**
 * Emit a structured AUTHZ_DENIED audit entry. Failures here are
 * logged but never propagate to the caller — denial response must
 * always reach the client even if audit storage is unavailable.
 */
async function auditPermissionDenied(
    ctx: RequestContext,
    keys: readonly PermissionKey[],
    reqMeta: { method: string; path: string },
): Promise<void> {
    try {
        await appendAuditEntry({
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
    } catch (err) {
        logger.warn('audit: failed to record AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
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

function safePath(req: NextRequest): string {
    try {
        return req.nextUrl.pathname;
    } catch {
        return '<unknown>';
    }
}

// ─── Public middleware ──────────────────────────────────────────────

/**
 * Strategy when more than one permission is supplied.
 *   - `'all'` (default): every key must be granted.
 *   - `'any'`: at least one key must be granted.
 */
export type PermissionMode = 'all' | 'any';

/**
 * Wrap a route handler with permission enforcement. The wrapped
 * function fits the standard App Router signature so it can be passed
 * straight to `withApiErrorHandling`.
 *
 * On denial:
 *   1. Records an AUTHZ_DENIED audit entry (best-effort).
 *   2. Throws `forbidden('Permission denied')` — surfaces as a 403
 *      with a generic message via `withApiErrorHandling`.
 *
 * @param required - One key, an array of keys, or `{ keys, mode }` for
 *                   explicit AND/OR semantics.
 * @param handler  - Route handler. Receives the resolved `RequestContext`
 *                   as its third argument so it doesn't re-fetch it.
 */
export function requirePermission<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
>(
    required:
        | PermissionKey
        | readonly PermissionKey[]
        | { keys: readonly PermissionKey[]; mode?: PermissionMode },
    handler: PermissionedHandler<TParams, TResponse>,
): RouteHandler<TParams, TResponse> {
    const { keys, mode } = normaliseRequirement(required);

    return async function permissionedRoute(req, routeArgs) {
        // `getTenantCtx` handles auth (session or API key), tenant
        // resolution, membership check, and custom-role-aware
        // appPermissions hydration. Throws AppError on auth failure.
        //
        // `routeArgs.params` must be awaited: under the Next 15+ runtime
        // the route export receives `params` as a Promise, and the
        // transparent-await shim in `withApiErrorHandling` was retired
        // by the async-params migration (#636) — the wrapper now
        // forwards `ctx` untouched. Without the await, `getTenantCtx`
        // (and `resolveTenantContext` under it) sees `params.tenantSlug`
        // as `undefined` on a Promise and throws "Tenant identifier
        // required", 404-ing every privileged route. `await` on a plain
        // sync object (the unit-test call shape) resolves to itself, so
        // both call shapes stay correct.
        //
        // Resolve ONCE and forward the RESOLVED params to the handler too —
        // otherwise a handler reading a dynamic segment other than
        // `tenantSlug` (e.g. `params.id` on `/gap-assessments/[id]/…`) reads
        // it off the still-unawaited Promise and gets `undefined` (silent for
        // a tolerant `findMany`, a 500 for a required composite-key lookup).
        const resolvedParams = await routeArgs.params;
        const ctx = await getTenantCtx(resolvedParams, req);

        // The decision itself lives in `assertPermission` so the MCP tool
        // funnel can make the SAME one. Do not inline it back — a second
        // caller re-implementing this check is exactly the drift the
        // extraction prevents.
        await assertPermission(ctx, { keys, mode }, {
            method: req.method,
            path: safePath(req),
        });

        return handler(req, { ...routeArgs, params: resolvedParams }, ctx) as Promise<TResponse>;
    };
}

/**
 * Convenience wrapper — accept callers holding **at least one** of the
 * listed permission keys.
 * Equivalent to `requirePermission({ keys, mode: 'any' }, handler)`.
 */
export function requireAnyPermission<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
>(
    keys: readonly PermissionKey[],
    handler: PermissionedHandler<TParams, TResponse>,
): RouteHandler<TParams, TResponse> {
    return requirePermission({ keys, mode: 'any' }, handler);
}

/**
 * Convenience wrapper: all-of semantics over a list of permission keys.
 * Equivalent to `requirePermission({ keys, mode: 'all' }, handler)`.
 */
export function requireAllPermissions<
    TParams extends { tenantSlug: string } = { tenantSlug: string },
    TResponse = Response | NextResponse,
>(
    keys: readonly PermissionKey[],
    handler: PermissionedHandler<TParams, TResponse>,
): RouteHandler<TParams, TResponse> {
    return requirePermission({ keys, mode: 'all' }, handler);
}

// ─── Internals ──────────────────────────────────────────────────────

function normaliseRequirement(
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
