import type { Role, OrgRole } from '@prisma/client';
import type { PermissionSet, OrgPermissionSet } from '@/lib/permissions';
import type { ActorType } from '@/lib/audit/types';

export interface RequestContext {
    /** Unique request identifier for log correlation */
    requestId: string;

    /** The authenticated user ID */
    userId: string;

    /**
     * What KIND of actor this context represents. Absent means `'USER'`,
     * which is what every HTTP-borne context is.
     *
     * Background jobs and platform sweeps have no signed-in user. They
     * used to satisfy `userId: string` with the literal `'system'` and
     * their audit rows were then written as `actorType: 'USER'` — so the
     * trail claimed a person did something no person did, and there was
     * no way to filter machine activity out of a review.
     *
     * `logEvent` forwards this to `appendAuditEntry`, which already
     * accepts the three-value `ActorType` and defaults to `'USER'`. Set
     * `'JOB'` for scheduled work and `'SYSTEM'` for middleware-driven
     * writes; leave it unset for anything a user asked for.
     */
    actorType?: ActorType;

    /** The resolved tenant ID */
    tenantId: string;

    /** The resolved tenant slug (if available from route) */
    tenantSlug?: string;

    /** The effective role of the user within this tenant */
    role: Role;

    /** Effective permissions derived from the role */
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };

    /** Granular UI permission set — custom role–aware when customRoleId is present */
    appPermissions: PermissionSet;

    /** Present when the request was authenticated via API key (M2M) */
    apiKeyId?: string;

    /** Scopes granted to the API key (e.g. ["controls:read", "evidence:write"]) */
    apiKeyScopes?: string[];
}

export interface PaginatedResult<T> {
    data: T[];
    metadata: {
        total: number;
        page: number;
        limit: number;
        hasMore: boolean;
    };
}

/**
 * Hub-and-spoke organization request context (Epic O-2).
 *
 * Resolved by `getOrgCtx({ orgSlug }, req)` for routes under
 * `/api/org/[orgSlug]/*`. Distinct from `RequestContext` (which is
 * tenant-scoped) — a single request resolves to ONE of the two,
 * never both. Drill-down from portfolio → tenant detail re-resolves
 * as `RequestContext` via the auto-provisioned AUDITOR membership,
 * where the existing per-tenant permission system takes over.
 *
 * `permissions` is derived from `orgRole` via `getOrgPermissions(...)`
 * at resolution time so callers can read flags directly without an
 * extra helper call. This mirrors how `RequestContext.permissions` /
 * `appPermissions` are pre-derived.
 */
export interface OrgContext {
    /** Unique request identifier for log correlation */
    requestId: string;

    /** The authenticated user ID */
    userId: string;

    /** The resolved organization ID */
    organizationId: string;

    /** The resolved organization slug (from the route) */
    orgSlug: string;

    /** The user's role within this organization */
    orgRole: OrgRole;

    /** Pre-derived org permission flags */
    permissions: OrgPermissionSet;
}
