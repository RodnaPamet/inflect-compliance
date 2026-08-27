import type { NextRequest, NextResponse } from 'next/server';

import { getOrgCtx } from '@/app-layer/context';
import type { OrgContext } from '@/app-layer/types';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability';
import type { OrgPermissionSet } from '@/lib/permissions';

/**
 * The org-surface counterpart to `requirePermission`.
 *
 * WHY IT EXISTS. On the tenant surface, `requirePermission` writes a
 * hash-chained `AUTHZ_DENIED` row when it refuses, so a blocked destructive
 * action leaves evidence. The org surface had no equivalent: its routes
 * resolved `getOrgCtx` and checked a flag inline, throwing `forbidden(...)`
 * and recording NOTHING. A refused attempt to remove an org member, revoke an
 * invite or detach a tenant was invisible (#2147).
 *
 * WHY IT CANNOT REUSE THE TENANT PATH. `AuditLog.tenantId` is NOT NULL with an
 * FK to `Tenant` (`prisma/schema/audit-trail.prisma:28`), and `OrgContext`
 * carries an `organizationId` and no tenant at all. The insert is impossible,
 * not merely unwired — which is why this writes to `OrgAuditLog` through
 * `appendOrgAuditEntry`, under the per-org advisory lock (`'org:' + id`) that
 * namespaces it against the per-tenant locks.
 *
 * The denial is recorded as `ORG_AUTHZ_DENIED`. Every other `OrgAuditAction`
 * member records something that HAPPENED; this one records something that was
 * PREVENTED, the same distinction `AuditLog` draws.
 */

/** A flag on `OrgPermissionSet` — typed, so a typo is a compile error. */
export type OrgPermissionKey = {
    [K in keyof OrgPermissionSet]: OrgPermissionSet[K] extends boolean ? K : never;
}[keyof OrgPermissionSet];

type OrgRouteArgs<TParams> = { params: Promise<TParams> | TParams };

type OrgPermissionedHandler<TParams, TResponse> = (
    req: NextRequest,
    routeArgs: { params: TParams },
    ctx: OrgContext,
) => Promise<TResponse> | TResponse;

type OrgRouteHandler<TParams, TResponse> = (
    req: NextRequest,
    routeArgs: OrgRouteArgs<TParams>,
) => Promise<TResponse>;

/**
 * Record the refusal. Best-effort, exactly as the tenant gate is: the caller is
 * being denied either way, and failing the request because the audit write
 * failed would turn a correct 403 into a 500.
 */
async function auditOrgPermissionDenied(
    ctx: OrgContext,
    keys: readonly OrgPermissionKey[],
    reqMeta: { method: string; path: string },
): Promise<void> {
    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: 'ORG_AUTHZ_DENIED',
            detailsJson: {
                permissionKeys: keys,
                orgRole: ctx.orgRole,
                method: reqMeta.method,
                path: reqMeta.path,
            },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('audit: failed to record ORG_AUTHZ_DENIED', {
            requestId: ctx.requestId,
            organizationId: ctx.organizationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function safePath(req: NextRequest): string {
    try {
        return req.nextUrl.pathname;
    } catch {
        return '<unknown>';
    }
}

/**
 * Wrap an org route handler with permission enforcement.
 *
 * On denial it records the refusal, then throws `forbidden('Permission
 * denied')` — a generic 403. The flag name is deliberately NOT echoed to the
 * client, matching the tenant gate: which permission you lack is information
 * about the authorization model, and the audit row is where it belongs.
 *
 * `params` is awaited once and the RESOLVED object forwarded to the handler,
 * for the same reason the tenant gate does it: under Next 15+ the route export
 * receives a Promise, and a handler reading a dynamic segment off the
 * unawaited value silently gets `undefined`.
 */
export function requireOrgPermission<
    TParams extends { orgSlug: string } = { orgSlug: string },
    TResponse = Response | NextResponse,
>(
    required: OrgPermissionKey | readonly OrgPermissionKey[],
    handler: OrgPermissionedHandler<TParams, TResponse>,
): OrgRouteHandler<TParams, TResponse> {
    const keys: readonly OrgPermissionKey[] = Array.isArray(required)
        ? (required as readonly OrgPermissionKey[])
        : [required as OrgPermissionKey];

    return async function orgPermissionedRoute(req, routeArgs) {
        const resolvedParams = (await routeArgs.params) as TParams;
        const ctx = await getOrgCtx(resolvedParams, req);

        // All-of semantics. There is no 'any' mode yet because no org route
        // needs one; add it when one does, rather than carrying an untested
        // branch.
        const granted = keys.every((k) => ctx.permissions[k] === true);
        if (!granted) {
            await auditOrgPermissionDenied(ctx, keys, {
                method: req.method,
                path: safePath(req),
            });
            throw forbidden('Permission denied');
        }

        return handler(req, { ...routeArgs, params: resolvedParams }, ctx) as Promise<TResponse>;
    };
}
