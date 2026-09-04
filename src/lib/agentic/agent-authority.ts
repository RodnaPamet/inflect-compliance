/**
 * Agent authority — the credential's authority is its PRINCIPAL's, intersected
 * with its own scopes. Never more than either.
 *
 * ## The gap this closes
 *
 * `verifyApiKey` builds a `RequestContext` whose `role` and `appPermissions`
 * come from the KEY'S SCOPES ALONE:
 *
 *     const appPermissions = scopesToPermissions(scopes);
 *     const role = hasAdminScope ? 'ADMIN' : hasWriteScope ? 'EDITOR' : 'READER';
 *
 * `apiKey.createdById` names the human the credential speaks for, and nothing
 * consults their membership. So a key minted with `risks:write` by a READER
 * resolves to `role: 'EDITOR'` and `risks.create: true` — authority its
 * principal does not hold and never held. That is the confused deputy in its
 * documented form: broad ambient scope, no per-action check against the
 * requesting identity. A key whose creator was later DEACTIVATED, REMOVED, or
 * whose membership was narrowed to a custom role keeps its full original reach
 * for the same reason.
 *
 * ## What this module does about it
 *
 * `resolveAgentAuthority` resolves the principal through
 * `resolveTenantContext` — the SAME resolver `getTenantCtx` runs for a signed-in
 * human, so the membership check, the DEACTIVATED / REMOVED refusals, the
 * soft-deleted-tenant refusal and the custom-role permission hydration are the
 * ones the product already ships, not a second copy. It then returns TWO
 * permission views, because the credential's authority is genuinely two things:
 *
 *   • `ctx` — the EFFECTIVE context. Its `appPermissions` and `permissions` are
 *     the INTERSECTION of the principal's and the key's, and its `role` is the
 *     lower of the two on the role ladder. Intersection can only ever narrow,
 *     so nothing downstream gains reach; a usecase that reads
 *     `ctx.appPermissions` (`assertCanViewFrameworks`, and every policy like it)
 *     now sees a set neither party could exceed alone.
 *
 *   • `principal` — the human's own permissions, unintersected. Used by exactly
 *     one class of check, and the reason is structural: the credential's scope
 *     vocabulary has no verb for "may propose". A propose key carries
 *     `mcp:propose` plus a domain READ scope and deliberately no
 *     `<domain>:write`, because propose-not-commit means the credential must not
 *     be able to write the entity directly. Checking `risks.create` against the
 *     intersection would therefore deny every propose call ever made. The
 *     credential's authority to propose is the `mcp:propose` capability
 *     (enforced by `enforceMcpCapability`) plus the domain read scope (enforced
 *     by `enforceApiKeyScope`); the PRINCIPAL's authority to propose is
 *     `risks.create`, and that is what this view is for.
 *
 * ## Fail direction
 *
 * A principal that no longer resolves is a DENIAL, not a fallback to the key's
 * own scopes. An agent acting for someone who left the tenant is acting for
 * nobody, and "nobody" has no permissions. This is a real behaviour change for
 * an existing key whose creator has been offboarded: it stops working, loudly,
 * with a `principal_*` reason in the audit row naming the credential to rebind.
 * The alternative — keep serving it — is the whole defect.
 *
 * ## Seam for 3/10
 *
 * The agent's `riskTier` will CAP the autonomy level it may be granted (3/10).
 * That cap belongs here, beside the intersection, as a third narrowing term:
 * `effective = principal ∧ credential ∧ tierCap`. Nothing in this module needs
 * to move for it — add the term to `resolveAgentAuthority` and it applies to
 * every tool at once, which is the property the whole design is buying.
 */
import type { Role } from '@prisma/client';

import prisma from '@/lib/prisma';
import { resolveTenantContext, type Permissions } from '@/lib/tenant-context';
import { PERMISSION_SCHEMA, type PermissionSet } from '@/lib/permissions';
import { isAppError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

/**
 * Why a credential's principal could not be resolved. Carried into the audit
 * row so an operator can tell "the human left" from "an admin switched them
 * off" — the first needs the key rebound to a live owner, the second needs a
 * decision about the person.
 */
export type PrincipalDenialReason =
    | 'principal_not_a_member'
    | 'principal_deactivated'
    | 'principal_removed'
    | 'principal_tenant_unavailable';

export interface AgentPrincipal {
    /** The human the credential speaks for — `TenantApiKey.createdById`. */
    userId: string;
    /** Their live effective role, custom-role aware. */
    role: Role;
    /** Their own permissions, NOT intersected with the credential's scopes. */
    appPermissions: PermissionSet;
    permissions: Permissions;
}

export interface AgentAuthority {
    /** The context every tool runs on: principal ∧ credential. */
    ctx: RequestContext;
    /** The principal's own authority — see the header for its one use. */
    principal: AgentPrincipal;
}

export class PrincipalUnresolvedError extends Error {
    constructor(readonly reason: PrincipalDenialReason) {
        super(`Agent principal could not be resolved: ${reason}`);
        this.name = 'PrincipalUnresolvedError';
    }
}

/** Role ladder, lowest first. Mirrors `ROLE_ORDER` in tenant-context. */
const ROLE_RANK: Record<Role, number> = {
    READER: 1,
    AUDITOR: 2,
    EDITOR: 3,
    ADMIN: 4,
    OWNER: 5,
};

/** The lower of two roles. A label, not the decision — the sets below are. */
export function lowerRole(a: Role, b: Role): Role {
    return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/**
 * Field-by-field AND over two `PermissionSet`s.
 *
 * Built from `PERMISSION_SCHEMA` rather than by walking one input's keys: a set
 * that is missing a domain (a hand-built or older-shaped object) must contribute
 * DENY for it, and walking `a`'s keys would silently drop the whole domain
 * instead — an absent key reads as "not restricted" to every consumer that
 * checks `?.[action] === true`.
 */
export function intersectPermissionSets(a: PermissionSet, b: PermissionSet): PermissionSet {
    const out: Record<string, Record<string, boolean>> = {};
    for (const [domain, actions] of Object.entries(PERMISSION_SCHEMA)) {
        const av = (a as unknown as Record<string, Record<string, boolean> | undefined>)[domain];
        const bv = (b as unknown as Record<string, Record<string, boolean> | undefined>)[domain];
        out[domain] = {};
        for (const action of actions) {
            out[domain][action] = av?.[action] === true && bv?.[action] === true;
        }
    }
    return out as unknown as PermissionSet;
}

/**
 * Field-by-field AND over the coarse `Permissions` flags.
 *
 * NOT `computePermissions(lowerRole(a, b))`, which is not the same function:
 * `canAudit` is `role === 'AUDITOR' || level >= 4`, so the lower of AUDITOR and
 * EDITOR is AUDITOR, which grants `canAudit` — a flag EDITOR does not hold. The
 * conjunction cannot grant what neither side had; the role-ladder shortcut can.
 */
export function intersectPermissions(a: Permissions, b: Permissions): Permissions {
    return {
        canRead: a.canRead && b.canRead,
        canWrite: a.canWrite && b.canWrite,
        canAdmin: a.canAdmin && b.canAdmin,
        canAudit: a.canAudit && b.canAudit,
        canExport: a.canExport && b.canExport,
    };
}

/**
 * Classify a resolution failure for the audit row.
 *
 * Runs ONLY on the denial path, and only after the shared resolver has already
 * refused — it is a diagnostic read, never the decision. Matching on the
 * resolver's message strings would be the alternative and is brittle; reading
 * the membership status back says the same thing in the vocabulary the operator
 * will act on.
 */
async function classifyPrincipalFailure(
    tenantId: string,
    userId: string,
): Promise<PrincipalDenialReason> {
    try {
        const membership = await prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId, userId } },
            select: { status: true },
        });
        if (!membership) return 'principal_not_a_member';
        if (membership.status === 'DEACTIVATED') return 'principal_deactivated';
        if (membership.status === 'REMOVED') return 'principal_removed';
        // A live membership that the resolver still refused means the TENANT
        // was the problem (soft-deleted), not the person.
        return 'principal_tenant_unavailable';
    } catch {
        return 'principal_tenant_unavailable';
    }
}

/**
 * Resolve the authority a credential-borne context may actually exercise.
 *
 * Throws `PrincipalUnresolvedError` when the principal no longer resolves; the
 * caller owns the audit row and the 403, so that both are written in one place
 * and exactly once.
 */
export async function resolveAgentAuthority(keyCtx: RequestContext): Promise<AgentAuthority> {
    let resolved;
    try {
        resolved = await resolveTenantContext({ tenantId: keyCtx.tenantId }, keyCtx.userId);
    } catch (err) {
        if (!isAppError(err)) throw err;
        throw new PrincipalUnresolvedError(
            await classifyPrincipalFailure(keyCtx.tenantId, keyCtx.userId),
        );
    }

    const principal: AgentPrincipal = {
        userId: keyCtx.userId,
        role: resolved.role,
        appPermissions: resolved.appPermissions,
        permissions: resolved.permissions,
    };

    const ctx: RequestContext = {
        ...keyCtx,
        role: lowerRole(resolved.role, keyCtx.role),
        permissions: intersectPermissions(resolved.permissions, keyCtx.permissions),
        appPermissions: intersectPermissionSets(resolved.appPermissions, keyCtx.appPermissions),
    };

    return { ctx, principal };
}

/**
 * Record the one AUTHZ_DENIED row for a credential whose principal no longer
 * resolves.
 *
 * Lives here rather than in either door because BOTH refuse for this reason and
 * the row must be written exactly once. It was originally emitted only from the
 * MCP funnel; once the narrowing moved to the point where the credential's
 * context is minted, the MCP funnel stopped being reached for this case and the
 * row silently stopped being written — an agent denial going unaudited, which
 * is the ASI10 signal this subsystem exists to surface.
 *
 * `surface` is optional because the auth layer legitimately does not know which
 * route is calling. An absent surface is recorded as such rather than guessed.
 */
export async function auditPrincipalUnresolved(
    ctx: RequestContext,
    reason: PrincipalDenialReason,
    surface?: { method: string; path: string },
): Promise<void> {
    const where = surface ? `${surface.method} ${surface.path}` : 'credential verification';
    try {
        const { appendAuditEntry } = await import('@/lib/audit');
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'TenantApiKey',
            entityId: ctx.apiKeyId ?? 'unknown-api-key',
            action: 'AUTHZ_DENIED',
            details: `Agent principal unresolved for ${where}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'agent_principal',
                reason,
                apiKeyId: ctx.apiKeyId ?? null,
                agentId: ctx.agentId ?? null,
                method: surface?.method ?? null,
                path: surface?.path ?? null,
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId ?? null, reason },
        });
    } catch (err) {
        const { logger } = await import('@/lib/observability/logger');
        logger.warn('audit: failed to record agent-principal AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
