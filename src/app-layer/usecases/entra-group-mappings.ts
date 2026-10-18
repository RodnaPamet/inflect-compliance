/**
 * EI-2 — CRUD for `TenantEntraGroupMapping` (Entra security-group → IC role).
 *
 * Admin-gated, tenant-scoped (runs under RLS via `runInTenantContext`), and
 * audit-logged. EI-3 consumes these rows at sign-in via `resolveRoleFromGroups`
 * to sync a member's role. Mirrors the sibling `entra-provider` usecase.
 *
 * A mapping is a standing role assignment, so it is held to the members page's
 * rule (#3699 deploy 2): creating, changing or deleting a mapping whose role is
 * or becomes an OWNER-managed one (`AI_ADMIN`) needs `admin.owner_management`.
 * An ADMIN, who runs every other mapping, can neither assign nor remove
 * AI_ADMIN this way. What an ADMIN can still do is re-prioritise ANOTHER
 * mapping so it outranks an AI_ADMIN one — a mapping's effect on a user who is
 * in several groups is not attributable to one row, so that is not gated.
 */
import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { conflict, forbidden, notFound } from '@/lib/errors/types';
import { isOwnerManagedRole, ownerManagedRoleMessage } from '@/lib/roles';
import {
    EntraGroupMappingCreateSchema,
    EntraGroupMappingUpdateSchema,
} from '../schemas/entra-group-mapping.schemas';

/** Refuses a mapping change that would assign or remove an OWNER-managed role without the key. */
function assertMayWriteMappingRole(ctx: RequestContext, ...roles: (string | undefined)[]): void {
    const managed = roles.find((r): r is string => r !== undefined && isOwnerManagedRole(r));
    if (managed && !ctx.appPermissions.admin.owner_management) {
        throw forbidden(ownerManagedRoleMessage(managed));
    }
}

export async function listEntraGroupMappings(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.tenantEntraGroupMapping.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
            take: 500,
        }),
    );
}

export async function createEntraGroupMapping(ctx: RequestContext, raw: unknown) {
    assertCanAdmin(ctx);
    const input = EntraGroupMappingCreateSchema.parse(raw);
    assertMayWriteMappingRole(ctx, input.role);

    return runInTenantContext(ctx, async (db) => {
        let row;
        try {
            row = await db.tenantEntraGroupMapping.create({
                data: {
                    tenantId: ctx.tenantId,
                    aadGroupId: input.aadGroupId,
                    aadGroupName: input.aadGroupName,
                    role: input.role,
                    priority: input.priority,
                    createdByUserId: ctx.userId,
                },
            });
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw conflict('A mapping for this Entra group already exists');
            }
            throw e;
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'TenantEntraGroupMapping',
            entityId: row.id,
            details: `Mapped Entra group ${input.aadGroupId} → ${input.role}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantEntraGroupMapping',
                operation: 'created',
                after: { aadGroupId: input.aadGroupId, role: input.role, priority: input.priority },
                summary: `Entra group mapping created (${input.role})`,
            },
        });

        return row;
    });
}

export async function updateEntraGroupMapping(
    ctx: RequestContext,
    mappingId: string,
    raw: unknown,
) {
    assertCanAdmin(ctx);
    const input = EntraGroupMappingUpdateSchema.parse(raw);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantEntraGroupMapping.findFirst({
            where: { id: mappingId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Group mapping not found');
        assertMayWriteMappingRole(ctx, existing.role, input.role);

        const row = await db.tenantEntraGroupMapping.update({
            where: { id: existing.id },
            data: {
                ...(input.aadGroupName !== undefined ? { aadGroupName: input.aadGroupName } : {}),
                ...(input.role !== undefined ? { role: input.role } : {}),
                ...(input.priority !== undefined ? { priority: input.priority } : {}),
            },
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'TenantEntraGroupMapping',
            entityId: row.id,
            details: `Updated Entra group mapping ${row.aadGroupId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantEntraGroupMapping',
                operation: 'updated',
                before: {
                    role: existing.role,
                    priority: existing.priority,
                    aadGroupName: existing.aadGroupName,
                },
                after: { role: row.role, priority: row.priority, aadGroupName: row.aadGroupName },
                summary: 'Entra group mapping updated',
            },
        });

        return row;
    });
}

export async function deleteEntraGroupMapping(ctx: RequestContext, mappingId: string) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantEntraGroupMapping.findFirst({
            where: { id: mappingId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Group mapping not found');
        assertMayWriteMappingRole(ctx, existing.role);

        await db.tenantEntraGroupMapping.delete({ where: { id: existing.id } });

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'TenantEntraGroupMapping',
            entityId: existing.id,
            details: `Deleted Entra group mapping ${existing.aadGroupId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantEntraGroupMapping',
                operation: 'deleted',
                before: { aadGroupId: existing.aadGroupId, role: existing.role },
                summary: 'Entra group mapping deleted',
            },
        });

        return { id: existing.id };
    });
}
