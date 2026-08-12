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
import { badRequest, notFound, unauthorized } from '@/lib/errors/types';
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
        if (apiKeyCtx) return apiKeyCtx;
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
 * The `userId` written on rows a background job creates.
 *
 * Every job previously spelled this inline as the literal `'system'`,
 * which is not a real `User.id` — so an audit row naming it resolves to
 * nobody, and a reviewer reading the trail cannot tell a platform sweep
 * from a person. The value is unchanged (rows already carry it, and
 * rewriting history is not on the table); what changes is that it now
 * travels with `actorType: 'JOB'`, which makes the row self-describing.
 */
export const SYSTEM_PRINCIPAL = 'system';

/**
 * Build the RequestContext a background job runs under.
 *
 * The thirteen jobs and sweeps that needed one each hand-rolled it, and
 * every copy was identical except for the `requestId` prefix. Identical
 * copies drift: the point of one builder is that a future change to how
 * machine activity is represented — a narrower permission set, a real
 * service principal, a different actor type — happens once.
 *
 * **On the ADMIN role.** These are platform operations, not user
 * requests: an evidence-expiry sweep must see every tenant row whoever
 * owns it, and there is no signed-in person whose authority could stand
 * in. So the role stays ADMIN, exactly as before — this function changes
 * NO authority. What it changes is honesty: the audit row now says `JOB`,
 * so machine writes are filterable and a reviewer is not misled into
 * reading a sweep as a human decision.
 *
 * This is deliberately NOT the right tool when a real person is on the
 * hook for the work. If a job acts because a named user owns the policy,
 * the task, or the report, that user's OWN membership should be resolved
 * and their real role used — see `resolveMemberContext`. Reaching for a
 * system context there would launder a READER's request into an ADMIN
 * one, which is the escalation this pair of helpers exists to separate.
 */
export function buildSystemContext(input: {
    tenantId: string;
    /** Stable, greppable job identity — e.g. `sla-monitor`. */
    job: string;
    /** Optional discriminator (a run id, a cloud name) appended to requestId. */
    discriminator?: string;
    tenantSlug?: string;
    /**
     * Override the whole request id. Only for a job that already has a
     * durable run identifier worth keeping in the trail (the control-test
     * runner's `jobRunId`) — otherwise let it be derived, so every job's
     * id has the same greppable shape.
     */
    requestId?: string;
    /**
     * Override the principal. `report-delivery` predates this builder
     * with its own `system:report-delivery` id, which is already written
     * on existing rows; changing it would orphan them.
     */
    principal?: string;
    /**
     * The COARSE permission flags. Defaults to full write/admin/audit —
     * what six of the callers had. Pass explicitly for the two that had
     * something narrower: `snapshot` reads only, and the control-test
     * runner writes but is neither admin nor auditor. Defaulting those
     * two into the full set would silently WIDEN a job's authority,
     * which is the opposite of the point.
     */
    permissions?: RequestContext['permissions'];
}): RequestContext {
    const suffix = input.discriminator ? `-${input.discriminator}` : '';
    return {
        requestId: input.requestId ?? `${input.job}-${input.tenantId}${suffix}`,
        userId: input.principal ?? SYSTEM_PRINCIPAL,
        actorType: 'JOB',
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        role: 'ADMIN',
        permissions: input.permissions ?? {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: false,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Context for a job that must write a row the SCHEMA requires a real user
 * on, while still recording that a job did the writing.
 *
 * `Task.createdByUserId` is `String` — NOT NULL — with a foreign key to
 * `User`. So a task simply cannot be created by `SYSTEM_PRINCIPAL`: the
 * insert dies on `Task_createdByUserId_fkey`. That constraint is the
 * reason these two jobs borrowed a real member's id in the first place,
 * and it is not something a context helper can wish away.
 *
 * What this fixes is the half that IS fixable today: the row now carries
 * `actorType: 'JOB'`, so the trail reads "a job did this, attributed to
 * <user>" instead of "<user> did this". A reviewer can filter machine
 * activity out; nobody is misled into treating a nightly sweep as a
 * deliberate act by the person named.
 *
 * **The ADMIN role stays, and that is a known remaining gap.** Resolving
 * the owner's real role instead (see `resolveMemberContext`) would mean a
 * READER-owned policy silently gets no review reminder — compliance work
 * disappearing quietly, which is worse than the escalation. Closing it
 * properly needs a real per-tenant SYSTEM `User` row so the FK can be
 * satisfied without borrowing anyone; that is a migration and belongs in
 * its own change. Until then this is the honest halfway point, and it is
 * documented rather than disguised.
 */
export function buildDelegatedJobContext(input: {
    tenantId: string;
    job: string;
    /** A REAL `User.id` — required by the foreign key on the row being written. */
    onBehalfOf: string;
    tenantSlug?: string;
    /** Override the derived request id (the control-test runner keeps its jobRunId). */
    requestId?: string;
    /** Coarse flags; defaults to full. Pass explicitly to keep a narrower set. */
    permissions?: RequestContext['permissions'];
}): RequestContext {
    return {
        requestId: input.requestId ?? `${input.job}-${input.tenantId}`,
        userId: input.onBehalfOf,
        actorType: 'JOB',
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        role: 'ADMIN',
        permissions: input.permissions ?? {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: false,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Resolve the RequestContext for a job acting ON BEHALF OF a named user.
 *
 * Some background work has a real accountable person: the policy owner a
 * review reminder is raised for, the author of a control-test plan, the
 * requester of a scheduled report. Those jobs used to keep that user's
 * `userId` — good, the audit row names the right person — while pinning
 * `role: 'ADMIN'`, which is not. One of them said so outright: *"ADMIN
 * permissions clear `assertCanWriteTasks`"*. A READER who owns a policy
 * therefore had an ADMIN-authority write committed under their name.
 *
 * This resolves the membership instead, so:
 *   • a demoted or removed principal loses the authority they had;
 *   • a custom role that withholds a flag keeps withholding it here;
 *   • an INVITED / DEACTIVATED / REMOVED membership resolves to `null`.
 *
 * Returning `null` is a REFUSAL, and the caller must treat it as one.
 * Falling back to a system context on `null` would re-open the same door
 * from the other side — the write would still happen, just anonymously.
 * The right response is to skip that principal's item and say so.
 *
 * Mirrors `resolveActorCtx` in `automation/action-executor.ts`, which
 * closed the identical hole for automation rules, and reuses the same
 * `computePermissions` so the two cannot drift.
 */
export async function resolveMemberContext(input: {
    tenantId: string;
    userId: string;
    job: string;
    discriminator?: string;
}): Promise<RequestContext | null> {
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
        include: { customRole: true, tenant: { select: { slug: true } } },
    });
    if (!membership || membership.status !== 'ACTIVE') return null;

    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    const suffix = input.discriminator ? `-${input.discriminator}` : '';
    return {
        requestId: `${input.job}-${input.tenantId}${suffix}`,
        userId: input.userId,
        tenantId: input.tenantId,
        tenantSlug: membership.tenant?.slug,
        role: effectiveRole,
        permissions: computePermissions(effectiveRole),
        appPermissions: membership.customRole
            ? parsePermissionsJson(
                  membership.customRole.permissionsJson,
                  membership.customRole.baseRole,
              )
            : getPermissionsForRole(membership.role),
    };
}
