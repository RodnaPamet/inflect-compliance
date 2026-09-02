import { NextRequest } from 'next/server';
import { getSessionOrThrow } from '@/lib/auth';
import { resolveTenantContext, computePermissions } from '@/lib/tenant-context';
import { RequestContext, OrgContext } from './types';
import { randomUUID } from 'crypto';
import { mergeRequestContext } from '@/lib/observability/context';
import {
    extractBearerToken,
    isApiKeyToken,
    verifyApiKey,
} from '@/lib/auth/api-key-auth';
import { badRequest, forbidden, notFound, unauthorized } from '@/lib/errors/types';
import prisma from '@/lib/prisma';
import { getOrgPermissions, getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import { logger } from '@/lib/observability/logger';

/**
 * Generates or extracts a request ID.
 * Future enhancement: Read from headers (x-request-id).
 */
function getRequestId(req?: NextRequest): string {
    if (req?.headers.has('x-request-id')) {
        return req.headers.get('x-request-id')!;
    }
    return randomUUID();
}

/**
 * Builds a RequestContext for tenant-level operations.
 * Requires tenantSlug from the route params.
 *
 * Custom role resolution: When the user's membership has a customRoleId,
 * appPermissions comes from the custom role's permissionsJson (parsed
 * with baseRole fallback). Otherwise, standard enum-based permissions.
 */
export async function getTenantCtx(
    params: { tenantSlug: string },
    req?: NextRequest
): Promise<RequestContext> {
    // Try API key auth first if Authorization header is present
    if (req) {
        const apiKeyCtx = await tryApiKeyAuth(req);
        if (apiKeyCtx) {
            // The key carries its own tenant; the URL names one too. They
            // must agree.
            //
            // `docs/api-consumer-guide.md` has always said "the {tenantSlug}
            // in the URL must match the tenant your credential belongs to —
            // a mismatch is a 403", and until #2224 that claim was vacuous:
            // a key-only request never passed the edge, so the only requests
            // that got here carried a session cookie AND a key, and the edge
            // tenant-access gate refused the mismatch on the cookie's
            // memberships before the handler ran.
            //
            // #2224 makes key-bearing requests skip that edge gate — they
            // have no cookie for it to read. This is where the check moves
            // to. Without it, `cookie(tenant A) + key(tenant B)` on
            // `/api/t/A/...` would silently serve B's rows under an A-shaped
            // URL, which is the credential-confusion shape of #2196 with
            // every audit log and metric labelled with the wrong tenant.
            if (apiKeyCtx.tenantSlug !== params.tenantSlug) {
                throw forbidden('API key is not valid for this tenant');
            }
            return apiKeyCtx;
        }
    }

    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    // This checks membership and resolves the tenant UUID & role
    const ctx = await resolveTenantContext(params, session.userId);

    // Enrich the observability context with tenant and user info
    // so that logs/traces emitted downstream automatically include them.
    mergeRequestContext({ tenantId: ctx.tenant.id, userId: session.userId });

    return {
        requestId,
        userId: session.userId,
        tenantId: ctx.tenant.id,
        tenantSlug: ctx.tenant.slug,
        role: ctx.role,
        permissions: ctx.permissions,
        appPermissions: ctx.appPermissions,
    };
}

/**
 * Builds a RequestContext for legacy API routes that don't have tenantSlug in params.
 * Resolves tenant from the session JWT's tenantId field.
 *
 * This also performs a membership check that legacy routes previously skipped.
 */
export async function getLegacyCtx(req?: NextRequest): Promise<RequestContext> {
    // Try API key auth first if Authorization header is present
    if (req) {
        const apiKeyCtx = await tryApiKeyAuth(req);
        if (apiKeyCtx) return apiKeyCtx;
    }

    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    // Resolve tenant context from session's tenantId (verifies membership)
    const ctx = await resolveTenantContext({ tenantId: session.tenantId }, session.userId);

    // Enrich the observability context with tenant and user info
    mergeRequestContext({ tenantId: ctx.tenant.id, userId: session.userId });

    return {
        requestId,
        userId: session.userId,
        tenantId: ctx.tenant.id,
        tenantSlug: ctx.tenant.slug,
        role: ctx.role,
        permissions: ctx.permissions,
        appPermissions: ctx.appPermissions,
    };
}

// ─── Hub-and-spoke organization context (Epic O-2) ──────────────────

/**
 * Builds an `OrgContext` for organization-scoped routes
 * (`/api/org/[orgSlug]/*`).
 *
 * ## Anti-enumeration policy
 *
 * Both "this org slug doesn't exist" AND "you're authenticated but
 * not a member of this org" collapse to the SAME externally-visible
 * response: `notFound` with a generic message that does NOT echo
 * the slug. A non-member can therefore never enumerate which org
 * slugs exist by probing the API and watching for 403 vs 404.
 *
 * Mirrors `getOrgServerContext` (the page-side resolver) — same
 * collapse, same generic message — so the page tree and the API
 * tree expose identical signal to an attacker.
 *
 * Internal observability is preserved via a structured `org-ctx`
 * log line (level=warn) that distinguishes the two states with a
 * `reason` field (`org_not_found` vs `not_a_member`). Operators
 * reading the application logs see the real cause; external callers
 * only see 404.
 *
 * ## Resolution order
 *   1. Authenticate the user via the existing session helper. NOT API
 *      key — org-scoped routes are user-driven (CISO portfolio + admin
 *      operations); machine-to-machine API keys are tenant-scoped and
 *      have no place at the org layer.
 *   2. Look up the Organization row by slug.
 *   3. Look up the OrgMembership for (org, user).
 *   4. Pre-derive `permissions` via `getOrgPermissions(role)` so
 *      callers can read flags directly without an extra helper call.
 *
 * Steps 2 and 3 both throw the same `notFound` on failure. Internal
 * `logger.warn('org-ctx.access_denied', { reason })` distinguishes
 * the cause for operator diagnostics.
 *
 * Side effect: enriches the observability AsyncLocalStorage so logs
 * and traces emitted downstream automatically include `userId`.
 *
 * Failure shape (externally visible):
 *   - `unauthorized` (401) — no session
 *   - `badRequest`   (400) — missing/empty slug (caller-side bug, not
 *                            an enumeration vector — the slug is in
 *                            the URL path, so an empty value here
 *                            means the route never matched)
 *   - `notFound`     (404) — org slug doesn't exist OR user has no
 *                            membership; collapsed for anti-enumeration
 */
export async function getOrgCtx(
    params: { orgSlug: string },
    req?: NextRequest,
): Promise<OrgContext> {
    const session = await getSessionOrThrow();
    const requestId = getRequestId(req);

    const orgSlug = (params.orgSlug ?? '').trim();
    if (!orgSlug) {
        throw badRequest('Missing organization slug');
    }

    // Generic external message — same string for both "no such org"
    // and "not a member". The internal log line below carries the
    // real reason for ops diagnostics.
    const externalNotFound = () =>
        notFound('Organization not found or access not permitted');

    const org = await prisma.organization.findUnique({
        where: { slug: orgSlug },
        select: { id: true, slug: true },
    });
    if (!org) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            reason: 'org_not_found',
            orgSlug,
            userId: session.userId,
            requestId,
        });
        throw externalNotFound();
    }

    const membership = await prisma.orgMembership.findUnique({
        where: {
            organizationId_userId: {
                organizationId: org.id,
                userId: session.userId,
            },
        },
        select: { role: true },
    });
    if (!membership) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            reason: 'not_a_member',
            orgSlug,
            organizationId: org.id,
            userId: session.userId,
            requestId,
        });
        throw externalNotFound();
    }

    mergeRequestContext({ userId: session.userId });

    return {
        requestId,
        userId: session.userId,
        organizationId: org.id,
        orgSlug: org.slug,
        orgRole: membership.role,
        permissions: getOrgPermissions(membership.role),
    };
}

// ─── API Key Auth Helper ───

/**
 * Attempt to authenticate via API key from the Authorization header.
 * Returns a RequestContext if the bearer token is an API key and verification succeeds.
 * Returns null if the token is not an API key (allowing session auth fallback).
 * Throws unauthorized() if the token IS an API key but is invalid.
 */
async function tryApiKeyAuth(req: NextRequest): Promise<RequestContext | null> {
    const authHeader = req.headers.get('authorization');
    const token = extractBearerToken(authHeader);

    // No token or not an API key format → fall through to session auth
    if (!token || !isApiKeyToken(token)) return null;

    // It IS an API key — must validate
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null;

    const result = await verifyApiKey(token, clientIp);

    if (!result.valid) {
        throw unauthorized(`API key authentication failed: ${result.reason}`);
    }

    // Override requestId from the header if available
    const requestId = getRequestId(req);
    result.ctx.requestId = requestId;

    // Enrich observability context
    mergeRequestContext({
        tenantId: result.ctx.tenantId,
        userId: result.ctx.userId,
    });

    return result.ctx;
}


// ─── System / background-job contexts ────────────────────────────────


/**
 * Job / sweep / webhook context builders live in `./context-system`.
 *
 * They were moved OUT of this file because this one imports
 * `getSessionOrThrow` from `@/lib/auth`, which reaches `@/auth` and builds the
 * NextAuth provider array at module scope — a chain that cannot be evaluated in
 * the BullMQ worker's plain-Node runtime. Every usecase imports this module for
 * `getTenantCtx`, so a job touching a context builder used to drag the whole
 * NextAuth tree in and die.
 *
 * Re-exported here so existing imports keep working. NEW job-side code should
 * import from `./context-system` directly — importing them via this module
 * re-creates the edge that broke the worker.
 */
export {
    SYSTEM_PRINCIPAL,
    buildSystemContext,
    buildDelegatedJobContext,
    resolveMemberContext,
} from './context-system';
