/**
 * Tenant context resolvers.
 *
 * These functions resolve the current tenant context for a request,
 * using TenantMembership as the authoritative source of truth.
 *
 * Design decisions:
 *   - Permissions are computed from the tenant membership role
 */
import prisma from './prisma';
import { notFound, forbidden } from '@/lib/errors/types';
import type { Role, Tenant, TenantMembership, TenantCustomRole } from '@prisma/client';
import { permissionsForMembership, type PermissionSet } from '@/lib/permissions';

// ─── Permission shape ───

export interface Permissions {
    canRead: boolean;
    canWrite: boolean;
    canAdmin: boolean;
    canAudit: boolean;
    canExport: boolean;
}

export interface TenantContext {
    tenant: Tenant;
    membership: TenantMembership & { customRole: TenantCustomRole | null };
    role: Role;
    customRole: TenantCustomRole | null;
    permissions: Permissions;
    appPermissions: PermissionSet;
}

// ─── Permission calculator ───

const ROLE_ORDER: Record<Role, number> = {
    OWNER: 5,
    ADMIN: 4,
    EDITOR: 3,
    AUDITOR: 2,
    READER: 1,
    // #3699 — READER's coarse tier, so `canWrite`, `canAdmin`, `canAudit` and
    // `canExport` are all false. AI_ADMIN's authority is the agent keys in its
    // `PermissionSet`, never this ladder: a level above 1 would admit it to
    // every usecase that gates on the coarse tier alone, which is most of the
    // product's writes.
    AI_ADMIN: 1,
};

export function computePermissions(role: Role): Permissions {
    const level = ROLE_ORDER[role] ?? 0;
    return {
        canRead: level >= 1,
        canWrite: level >= 3,
        canAdmin: level >= 4,
        canAudit: role === 'AUDITOR' || level >= 4,
        canExport: level >= 2,
    };
}

/**
 * The authority a membership resolves to: the role, the coarse flags and the
 * granular set a request carries.
 *
 * A custom role overrides the built-in one when the membership has one: the
 * role is its base, and the granular set is its JSON parsed over that base.
 * The link is all that is read. Deleting a custom role clears every
 * membership's link to it in the same write, and a link that survives anyway
 * is applied like any other.
 *
 * `resolveTenantContext` builds every request's authority from this, and a
 * job acting for the member who started it (`resolveInitiatorContext` in
 * `src/app-layer/context-system.ts`) reads the same function, so the two
 * cannot drift (#4362).
 */
export function resolveMembershipAuthority(membership: {
    role: Role;
    customRole: { baseRole: Role; permissionsJson: unknown } | null;
}): { role: Role; permissions: Permissions; appPermissions: PermissionSet } {
    const role = membership.customRole?.baseRole ?? membership.role;
    return {
        role,
        permissions: computePermissions(role),
        appPermissions: permissionsForMembership(membership),
    };
}

// ─── Tenant context resolver ───

export async function resolveTenantContext(
    params: { tenantSlug?: string; tenantId?: string },
    userId: string
): Promise<TenantContext> {
    let tenant: Tenant | null = null;

    if (params.tenantSlug) {
        tenant = await prisma.tenant.findUnique({
            where: { slug: params.tenantSlug },
        });
    } else if (params.tenantId) {
        tenant = await prisma.tenant.findUnique({
            where: { id: params.tenantId },
        });
    } else {
        throw notFound('Tenant identifier required');
    }

    if (!tenant) {
        throw notFound('Tenant not found');
    }

    // Soft-deleted (removed from the org admin panel) tenants are
    // inaccessible. This is the single authoritative gate — every /t and
    // /api/t request resolves through here — so denying it once makes a
    // removed tenant unreachable everywhere, regardless of stale JWT
    // claims or cached listings. Same anti-enumeration shape as
    // "not found".
    if (tenant.deletedAt) {
        throw notFound('Tenant not found');
    }

    const membership = await prisma.tenantMembership.findUnique({
        where: {
            tenantId_userId: {
                tenantId: tenant.id,
                userId,
            },
        },
        include: {
            customRole: true,
        },
    });

    if (!membership) {
        throw forbidden('Not a member of this tenant');
    }

    // Block deactivated or removed members from accessing tenant resources
    const memberStatus = membership.status;
    if (memberStatus === 'DEACTIVATED') {
        throw forbidden('Your account has been deactivated by a tenant administrator. Contact your admin for access.');
    }
    if (memberStatus === 'REMOVED') {
        throw forbidden('You are no longer a member of this tenant.');
    }

    // Resolve permissions: custom role overrides enum-based defaults when present
    const { role, permissions, appPermissions } = resolveMembershipAuthority(membership);

    return {
        tenant,
        membership,
        role,
        customRole: membership.customRole,
        permissions,
        appPermissions,
    };
}

// ─── Default tenant helper ───

/**
 * Get the default tenant for a user (first membership by creation date).
 *
 * @param userId - The user's ID
 * @returns TenantMembership with tenant, or null if user has no memberships
 */
export async function getDefaultTenantForUser(
    userId: string
): Promise<(TenantMembership & { tenant: Tenant }) | null> {
    return prisma.tenantMembership.findFirst({
        // Skip memberships whose tenant was soft-deleted — never default
        // a user into a removed tenant.
        where: { userId, tenant: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        include: { tenant: true },
    });
}
