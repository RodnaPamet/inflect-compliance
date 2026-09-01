/**
 * Custom Role CRUD Usecases
 *
 * Admin-only operations for managing tenant-defined custom roles
 * and assigning them to memberships.
 *
 * All mutations:
 *   - Require ADMIN via assertCanManageMembers
 *   - Validate permissionsJson via validatePermissionsJson
 *   - Emit audit events via logEvent
 *
 * @module usecases/custom-roles
 */
import { RequestContext } from '../types';
import { assertCanManageMembers } from '../policies/admin.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import {
    validatePermissionsJson,
    parsePermissionsJson,
    permissionsExceeding,
} from '@/lib/permissions';
import type { Role } from '@prisma/client';

const VALID_BASE_ROLES: Role[] = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'];

// ─── List Custom Roles ───

/**
 * List every custom role in the tenant, with `permissionsJson`
 * NORMALISED through `parsePermissionsJson`.
 *
 * The normalisation is load-bearing, not cosmetic. `permissionsJson`
 * is a `Json` column: whatever was valid when the row was written is
 * what comes back, and `PermissionSet` grows over time. A row stored
 * before `assets` / `personnel` / `incidents` existed simply has no
 * key for them.
 *
 * The admin roles page consumes this response directly — it counts
 * granted flags per row (`countGranted`) and seeds the permission-grid
 * editor from it. Both read `permissions[domain][action]`, and the
 * `?? false` at the grid's read site guards a missing ACTION, not a
 * missing DOMAIN: `undefined[action]` is a TypeError, so one stale row
 * takes the whole page down rather than rendering a blank cell.
 *
 * `parsePermissionsJson` merges the stored blob over the row's own
 * `baseRole` defaults, so every domain is present and an absent one
 * reads as "whatever the base role grants" — which is exactly what
 * the runtime authorization path (`computePermissions`) already does
 * for the same row. Normalising here makes the list endpoint agree
 * with enforcement instead of exposing the raw column.
 *
 * Production has zero custom roles today, so this needs no migration;
 * it is what makes ADDING a domain to `PermissionSet` a safe change.
 */
export async function listCustomRoles(ctx: RequestContext) {
    assertCanManageMembers(ctx);

    const rows = await runInTenantContext(ctx, (db) =>
        db.tenantCustomRole.findMany({
            where: { tenantId: ctx.tenantId },
            include: {
                _count: { select: { memberships: true } },
            },
            orderBy: { createdAt: 'asc' },
        })
    );

    return rows.map((row) => ({
        ...row,
        permissionsJson: parsePermissionsJson(row.permissionsJson, row.baseRole),
    }));
}

// ─── Create Custom Role ───

export interface CreateCustomRoleInput {
    name: string;
    description?: string | null;
    baseRole: Role;
    permissionsJson: unknown;
}

export async function createCustomRole(ctx: RequestContext, input: CreateCustomRoleInput) {
    assertCanManageMembers(ctx);

    // Validate inputs
    const name = input.name.trim();
    if (!name || name.length > 100) {
        throw badRequest('Role name is required and must be 100 characters or fewer.');
    }

    if (!VALID_BASE_ROLES.includes(input.baseRole)) {
        throw badRequest(`Invalid base role: ${input.baseRole}`);
    }

    // Validate permissions JSON
    const errors = validatePermissionsJson(input.permissionsJson);
    if (errors.length > 0) {
        throw badRequest(`Invalid permissions: ${errors.join('; ')}`);
    }

    // A role may not contain more authority than its author holds.
    assertGrantWithinOwnAuthority(ctx, input.permissionsJson, input.baseRole);

    return runInTenantContext(ctx, async (db) => {
        // Check for duplicate name within tenant
        const existing = await db.tenantCustomRole.findFirst({
            where: { tenantId: ctx.tenantId, name },
        });
        if (existing) {
            throw badRequest(`A custom role named "${name}" already exists in this tenant.`);
        }

        const role = await db.tenantCustomRole.create({
            data: {
                tenantId: ctx.tenantId,
                name,
                description: input.description?.trim() || null,
                baseRole: input.baseRole,
                permissionsJson: input.permissionsJson as object,
                isActive: true,
            },
        });

        await logEvent(db, ctx, {
            action: 'CUSTOM_ROLE_CREATED',
            entityType: 'TenantCustomRole',
            entityId: role.id,
            details: `Created custom role: ${name} (base: ${input.baseRole})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantCustomRole',
                operation: 'created',
                after: { name, baseRole: input.baseRole },
                summary: `Created custom role: ${name}`,
            },
        });

        return role;
    });
}

// ─── Update Custom Role ───

export interface UpdateCustomRoleInput {
    name?: string;
    description?: string | null;
    baseRole?: Role;
    permissionsJson?: unknown;
}

export async function updateCustomRole(
    ctx: RequestContext,
    roleId: string,
    input: UpdateCustomRoleInput,
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantCustomRole.findFirst({
            where: { id: roleId, tenantId: ctx.tenantId },
        });
        if (!existing) {
            throw notFound('Custom role not found.');
        }

        // Build update data
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: Record<string, any> = {};

        if (input.name !== undefined) {
            const name = input.name.trim();
            if (!name || name.length > 100) {
                throw badRequest('Role name is required and must be 100 characters or fewer.');
            }
            // Check for duplicate name
            if (name !== existing.name) {
                const dup = await db.tenantCustomRole.findFirst({
                    where: { tenantId: ctx.tenantId, name, id: { not: roleId } },
                });
                if (dup) {
                    throw badRequest(`A custom role named "${name}" already exists.`);
                }
            }
            data.name = name;
        }

        if (input.description !== undefined) {
            data.description = input.description?.trim() || null;
        }

        if (input.baseRole !== undefined) {
            if (!VALID_BASE_ROLES.includes(input.baseRole)) {
                throw badRequest(`Invalid base role: ${input.baseRole}`);
            }
            data.baseRole = input.baseRole;
        }

        if (input.permissionsJson !== undefined) {
            const errors = validatePermissionsJson(input.permissionsJson);
            if (errors.length > 0) {
                throw badRequest(`Invalid permissions: ${errors.join('; ')}`);
            }
            data.permissionsJson = input.permissionsJson as object;
        }

        if (Object.keys(data).length === 0) {
            throw badRequest('No fields to update.');
        }

        // Guard the RESULTING role, not just the submitted field: a
        // partial update can raise authority through either half —
        // new permissionsJson over the old baseRole, or a higher
        // baseRole under the old permissionsJson.
        assertGrantWithinOwnAuthority(
            ctx,
            input.permissionsJson !== undefined
                ? input.permissionsJson
                : existing.permissionsJson,
            input.baseRole !== undefined ? input.baseRole : existing.baseRole,
        );

        const updated = await db.tenantCustomRole.update({
            where: { id: roleId },
            data,
        });

        await logEvent(db, ctx, {
            action: 'CUSTOM_ROLE_UPDATED',
            entityType: 'TenantCustomRole',
            entityId: updated.id,
            details: `Updated custom role: ${updated.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantCustomRole',
                operation: 'updated',
                changedFields: Object.keys(data),
                summary: `Updated custom role: ${updated.name}`,
            },
        });

        return updated;
    });
}

// ─── Delete (Soft-Delete) Custom Role ───

export async function deleteCustomRole(ctx: RequestContext, roleId: string) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantCustomRole.findFirst({
            where: { id: roleId, tenantId: ctx.tenantId },
        });
        if (!existing) {
            throw notFound('Custom role not found.');
        }

        // Soft-delete: deactivate the role
        const deleted = await db.tenantCustomRole.update({
            where: { id: roleId },
            data: { isActive: false },
        });

        // Clear customRoleId on all affected memberships
        // so they safely fall back to their enum role
        const cleared = await db.tenantMembership.updateMany({
            where: { tenantId: ctx.tenantId, customRoleId: roleId },
            data: { customRoleId: null },
        });

        await logEvent(db, ctx, {
            action: 'CUSTOM_ROLE_DELETED',
            entityType: 'TenantCustomRole',
            entityId: deleted.id,
            details: `Deleted custom role: ${existing.name} (${cleared.count} members reassigned to fallback)`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantCustomRole',
                operation: 'deleted',
                summary: `Deleted custom role: ${existing.name}`,
                metadata: { membersCleared: cleared.count },
            },
        });

        return { deleted, membersCleared: cleared.count };
    });
}

/**
 * "You cannot grant what you do not hold."
 *
 * Custom roles are the one path where a permission set is authored by
 * hand rather than derived from the Role enum, so it is the one path that
 * can hand out MORE than the author has. Every entrypoint here is gated
 * on `assertCanAdmin`, which an ADMIN satisfies — but ADMIN deliberately
 * lacks `admin.tenant_lifecycle` and `admin.owner_management` (OWNER
 * only: delete tenant, rotate the tenant DEK, manage OWNERs). Without
 * this check an ADMIN could author a role holding those, assign it to
 * themselves, and escalate to OWNER on the next request.
 *
 * Applied on create, update AND assign: create/update decide what a role
 * CONTAINS, assign decides who RECEIVES it, and leaving any one unchecked
 * leaves the escalation reachable.
 */
function assertGrantWithinOwnAuthority(
    ctx: RequestContext,
    permissionsJson: unknown,
    baseRole: Role,
): void {
    const granted = parsePermissionsJson(permissionsJson, baseRole);
    const exceeded = permissionsExceeding(granted, ctx.appPermissions);
    if (exceeded.length > 0) {
        throw forbidden(
            `Cannot grant permissions you do not hold: ${exceeded.join(', ')}.`,
        );
    }
}

// ─── Assign Custom Role to Member ───

export async function assignCustomRole(
    ctx: RequestContext,
    membershipId: string,
    customRoleId: string | null,
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        // Verify membership exists in this tenant
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: membershipId,
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            throw notFound('Membership not found or not active.');
        }

        // If assigning, verify the custom role exists and belongs to this tenant
        if (customRoleId) {
            const customRole = await db.tenantCustomRole.findFirst({
                where: {
                    id: customRoleId,
                    tenantId: ctx.tenantId,
                    isActive: true,
                },
            });
            if (!customRole) {
                throw notFound('Custom role not found or inactive.');
            }
            // Handing an existing role to someone is a grant too. Without
            // this, an ADMIN blocked from AUTHORING an over-privileged
            // role could still assign one that already exists (seeded,
            // or created by an OWNER) — including to themselves.
            assertGrantWithinOwnAuthority(
                ctx,
                customRole.permissionsJson,
                customRole.baseRole,
            );
        }

        const oldCustomRoleId = membership.customRoleId;

        const updated = await db.tenantMembership.update({
            where: { id: membershipId },
            data: { customRoleId },
            include: {
                user: { select: { id: true, name: true, email: true } },
                customRole: { select: { id: true, name: true } },
            },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_CUSTOM_ROLE_CHANGED',
            entityType: 'TenantMembership',
            entityId: updated.id,
            details: customRoleId
                ? `Assigned custom role "${updated.customRole?.name}" to ${membership.user.email}`
                : `Removed custom role from ${membership.user.email} (fallback to ${membership.role})`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: oldCustomRoleId ?? 'none',
                toStatus: customRoleId ?? 'none',
            },
        });

        return updated;
    });
}
