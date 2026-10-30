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
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { notFound, badRequest, forbidden, ConflictError } from '@/lib/errors/types';
import {
    validatePermissionsJson,
    parsePermissionsJson,
    permissionsExceeding,
} from '@/lib/permissions';
import {
    BUILT_IN_SCOPE_REFUSAL,
    OWNER_TIER_CLEAR_REFUSAL,
    builtInScopeRoleMessage,
    clearingCustomRoleIsOwnerTier,
    customRoleCarriageDetails,
    customRoleCarriageMessage,
    customRoleCarriageRefusal,
    mayCarryCustomRole,
    ownerTierClearMessage,
    type CustomRoleCarriageRefusal,
    type CustomRoleForCarriage,
} from '@/lib/roles';
import { CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER } from '@/lib/custom-role-grant-refusal';
import { PERMISSION_NEEDS_ADMIN_BASE, grantsNeedingAdminBase } from '@/lib/custom-role-admin-base-rule';
import type { Role } from '@prisma/client';

/**
 * The roles a custom role may be built on. A custom role's base IS the role a
 * membership resolves to (`effectiveRole` in `resolveTenantContext`), so this is
 * a membership-role writer's list. AI_ADMIN (#3699) and OWNER are absent: the
 * scope of both is always the reviewed built-in set, so no custom role is built
 * on either and none is assigned to a membership holding either
 * (`mayCarryCustomRole`, below; OWNER joined that rule in #3720).
 */
const VALID_BASE_ROLES: Role[] = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'];

/**
 * The LIVE custom role holding `name` in the tenant, other than `exceptId`.
 *
 * Mirrors the partial unique index `TenantCustomRole_tenantId_name_key`
 * (`WHERE "isActive"`, migration
 * 20261029190000_custom_role_name_unique_among_live): exact, case-sensitive,
 * deleted roles excluded. So it refuses exactly what the index would, and
 * nothing it would let through. A deleted role frees its name (#4467; owner
 * decision, 2026-10-29): the check used to match deleted rows too, and a name
 * stayed taken by a role nobody could see.
 */
async function findLiveCustomRoleByName(
    db: PrismaTx,
    tenantId: string,
    name: string,
    exceptId?: string,
) {
    return db.tenantCustomRole.findFirst({
        where: {
            tenantId,
            name,
            isActive: true,
            ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { id: true },
    });
}

/** The partial unique index on a LIVE role's name (20261029190000). */
const LIVE_NAME_INDEX = 'TenantCustomRole_tenantId_name_key';

/**
 * Whether `err` is the partial unique index refusing a second LIVE role of
 * one name — what `findLiveCustomRoleByName` checks for, lost to a race
 * between the check and the write (#4581). Without this the loser of the race
 * got a 500 instead of the sentence the check would have given it.
 */
function isLiveNameTaken(err: unknown): boolean {
    const e = err as {
        code?: unknown;
        meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } } };
    } | null;
    if (e?.code !== 'P2002') return false;
    // The pg driver adapter names the index; the classic engine names its
    // columns in `target`. Anything else is not recognised and stays a 500,
    // as it was, rather than being reported as a name clash it may not be.
    const constraint = e.meta?.driverAdapterError?.cause?.constraint;
    if (constraint?.index === LIVE_NAME_INDEX) return true;
    if (Array.isArray(constraint?.fields) && constraint.fields.includes('name')) return true;
    const target = e.meta?.target;
    if (target === LIVE_NAME_INDEX) return true;
    return Array.isArray(target) && target.includes('name');
}

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
    assertAdminBaseOnlyPermissions(input.permissionsJson, input.baseRole);

    return runInTenantContext(ctx, async (db) => {
        // Check for a duplicate name among the tenant's LIVE roles.
        const existing = await findLiveCustomRoleByName(db, ctx.tenantId, name);
        if (existing) {
            throw badRequest(`A custom role named "${name}" already exists in this tenant.`);
        }

        const role = await db.tenantCustomRole
            .create({
                data: {
                    tenantId: ctx.tenantId,
                    name,
                    description: input.description?.trim() || null,
                    baseRole: input.baseRole,
                    permissionsJson: input.permissionsJson as object,
                    isActive: true,
                },
            })
            .catch((err: unknown) => {
                // Two creates of one name at once both pass the check above;
                // the partial unique index refuses the second (#4581).
                if (isLiveNameTaken(err)) {
                    throw badRequest(`A custom role named "${name}" already exists in this tenant.`);
                }
                throw err;
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
        // A deleted (inactive) role is gone as far as the API is concerned: it
        // is hidden from the list and cannot be edited or deleted again (#4581).
        const existing = await db.tenantCustomRole.findFirst({
            where: { id: roleId, tenantId: ctx.tenantId, isActive: true },
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
            // Check for a duplicate name among the tenant's LIVE roles.
            if (name !== existing.name) {
                const dup = await findLiveCustomRoleByName(db, ctx.tenantId, name, roleId);
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
        // The RESULTING role again, but only when the update writes one of the
        // two halves the rule is about: a rename of a legacy role must not be
        // refused for a grant the rename does not touch.
        if (input.permissionsJson !== undefined || input.baseRole !== undefined) {
            assertAdminBaseOnlyPermissions(
                input.permissionsJson !== undefined ? input.permissionsJson : existing.permissionsJson,
                input.baseRole !== undefined ? input.baseRole : existing.baseRole,
            );
        }

        // Who CARRIES the role decides what it may become (owner decision,
        // 2026-10-30): a save that would give a non-ADMIN carrier an admin-tier
        // base or an admin-membership-only key is refused, naming how many
        // members block it. Judged on the resulting role, like the grant check
        // above, and only for what the save ADDS, so a save that narrows a
        // legacy role is never refused.
        //
        // LAST, on purpose: the two checks above are about the role's own
        // content and read nothing, this one is about who carries it and reads
        // the memberships. So when a save breaks both kinds (an
        // Admin-base-only permission on a non-ADMIN base AND a new admin-only
        // key for a non-ADMIN carrier), the content refusal (400,
        // PERMISSION_NEEDS_ADMIN_BASE) is the one returned, and the carriage
        // refusal follows once it is fixed. The two never ask contradictory
        // fixes of one save: an Admin-base-only permission needs an ADMIN
        // base, which a non-ADMIN carrier refuses, so the fixes that satisfy
        // both are to switch it off, or to make every carrier ADMIN first.
        await assertCustomRoleSaveCarriableInTx(db, ctx, roleId, existing, {
            baseRole: input.baseRole !== undefined ? input.baseRole : existing.baseRole,
            permissionsJson:
                input.permissionsJson !== undefined ? input.permissionsJson : existing.permissionsJson,
        });

        const updated = await db.tenantCustomRole
            .update({
                where: { id: roleId },
                data,
            })
            .catch((err: unknown) => {
                // A rename racing another create or rename of the same name
                // (#4581); see `isLiveNameTaken`.
                if (isLiveNameTaken(err)) {
                    throw badRequest(`A custom role named "${data.name}" already exists.`);
                }
                throw err;
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
        // A deleted (inactive) role is gone as far as the API is concerned: it
        // is hidden from the list and cannot be edited or deleted again (#4581).
        const existing = await db.tenantCustomRole.findFirst({
            where: { id: roleId, tenantId: ctx.tenantId, isActive: true },
        });
        if (!existing) {
            throw notFound('Custom role not found.');
        }

        // Soft-delete: deactivate the role. A legacy row built on OWNER or
        // AI_ADMIN would fail `TenantCustomRole_base_role_not_built_in_scope`
        // (#3734) on any UPDATE that keeps that base, so the deactivation also
        // moves it to READER — the one write that lets a person remove it.
        const deleted = await db.tenantCustomRole.update({
            where: { id: roleId },
            data: {
                isActive: false,
                ...(VALID_BASE_ROLES.includes(existing.baseRole) ? {} : { baseRole: 'READER' as Role }),
            },
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
        // The keys also travel in `details`, under a reason, so the roles
        // page can name them by their labels rather than show the keys (#4467).
        throw forbidden(
            `Cannot grant permissions you do not hold: ${exceeded.join(', ')}.`,
            { reason: CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER, exceeded },
        );
    }
}

/**
 * Only an ADMIN-based custom role may hold the permissions in
 * `ADMIN_BASE_ONLY_PERMISSIONS` (#4536, #4581 A; owner decisions 2026-10-30).
 * Server code behind each asks the Admin tier, which a custom role reads from
 * its base, so on any other base the route let the role in and the usecase
 * refused it. The keys travel in `details.permissions` so the Roles page can
 * name them by their labels.
 */
function assertAdminBaseOnlyPermissions(permissionsJson: unknown, baseRole: Role): void {
    const refused = grantsNeedingAdminBase(permissionsJson, baseRole);
    if (refused.length > 0) {
        throw badRequest(
            `Only a custom role based on Admin can hold: ${refused.join(', ')}. Switch them off, or base the role on Admin.`,
            { reason: PERMISSION_NEEDS_ADMIN_BASE, permissions: refused },
        );
    }
}

// ─── Assign Custom Role to Member ───

/**
 * Assign a custom role to an ACTIVE membership, or clear it (`null`).
 *
 * Two rules on the TARGET membership's role, ahead of the grant check:
 *
 *   - **Assigning** to a role whose scope is always the built-in one (OWNER,
 *     AI_ADMIN — `mayCarryCustomRole`) is refused for every caller, OWNER
 *     included: 409, `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`. On an OWNER
 *     it was a demotion through a side door (#3720) — the custom role replaces
 *     the OWNER's permissions while the enum role, and so every last-OWNER
 *     check, still reads OWNER.
 *   - **Clearing** on an OWNER is OWNER-tier (`clearingCustomRoleIsOwnerTier`):
 *     it restores full OWNER authority, so it needs `admin.owner_management`;
 *     an ADMIN gets 403, `CLEARING_OWNER_CUSTOM_ROLE_IS_OWNER_TIER`. Only a
 *     legacy row can have one to clear. Clearing on any other role, AI_ADMIN
 *     included, is unchanged.
 *
 * The database holds the first rule too (CHECK
 * `TenantMembership_built_in_scope_role_no_custom_role`); the usecase is the
 * front door with the named reason.
 *
 * Its three parts are exported for the members page's Save, which sends a role
 * and a custom role together (`updateTenantMemberRoleAndCustomRole`): every
 * check of both halves runs before either write, so a refused custom role
 * leaves the role unchanged (#4118).
 */
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

        await assertCustomRoleAssignableInTx(db, ctx, membership.role, customRoleId);
        await assertCustomRoleCarriageInTx(
            db,
            ctx.tenantId,
            { role: membership.role, customRoleId },
            { role: membership.role, customRoleId: membership.customRoleId },
            'assign-custom-role',
        );
        const updated = await writeCustomRoleInTx(db, membership.id, customRoleId);
        await logCustomRoleChange(db, ctx, { membership, updated, customRoleId });
        return updated;
    });
}

/**
 * Every refusal `assignCustomRole` can give, asked of a membership that holds
 * (or, in a combined change, is about to hold) `membershipRole`. Throws the
 * refusal; writes nothing.
 */
export async function assertCustomRoleAssignableInTx(
    db: PrismaTx,
    ctx: RequestContext,
    membershipRole: Role,
    customRoleId: string | null,
): Promise<void> {
    // An OWNER's or an AI_ADMIN's scope is always the built-in one (#3720,
    // #3699): a custom role would replace it at resolution. Refused for
    // every caller — this is a rule about the membership, not the caller.
    if (customRoleId && !mayCarryCustomRole(membershipRole)) {
        throw new ConflictError(builtInScopeRoleMessage(membershipRole, 'assign-custom-role'), {
            reason: BUILT_IN_SCOPE_REFUSAL,
        });
    }
    // Clearing one from an OWNER (legacy data only) restores full OWNER
    // authority, so it is an OWNER's change (#3720). Refused whether or not
    // there is anything to clear: an ADMIN does not modify an OWNER
    // membership. Clearing on every other role stays open, AI_ADMIN included.
    if (
        customRoleId === null &&
        clearingCustomRoleIsOwnerTier(membershipRole) &&
        !ctx.appPermissions.admin.owner_management
    ) {
        throw forbidden(ownerTierClearMessage(), { reason: OWNER_TIER_CLEAR_REFUSAL });
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
}

/** A membership's built-in role and the id of the custom role it carries. */
export interface MembershipCarriage {
    role: Role;
    customRoleId: string | null;
}

/** The database surface the carriage check reads: the tenant's custom roles, by id. */
type CustomRoleReader = Pick<PrismaTx, 'tenantCustomRole'>;

/**
 * Refuse moving a membership from `before` to `after` when the move ADDS an
 * offence to the rule only an ADMIN membership may carry a custom role built
 * on ADMIN or granting an admin-membership-only key (owner decision,
 * 2026-10-30; `customRoleCarriageRefusal` in `src/lib/roles.ts`). 409, with the
 * reason and the offending keys or base in `details`. Writes nothing.
 *
 * Every membership writer that can change a role or a custom role asks it: the
 * assignment above, the members-page role change and the two together, and
 * invite creation and redemption. `before` is `null` for a membership that
 * does not exist yet. Clearing a custom role, replacing it with one that
 * offends no more, and every change on an ADMIN membership pass without a read.
 *
 * The custom roles are read by id within `tenantId` whatever their `isActive`:
 * a membership carrying a deleted role is impossible (deletion clears it), and
 * a stale id judged as "no custom role" would read as no offence, which is the
 * direction this check must not fail in.
 */
export async function assertCustomRoleCarriageInTx(
    db: CustomRoleReader,
    tenantId: string,
    after: MembershipCarriage,
    before: MembershipCarriage | null,
    asked: 'assign-custom-role' | 'change-role' | 'invite',
): Promise<void> {
    if (!after.customRoleId || after.role === 'ADMIN') return;
    const ids = [...new Set([after.customRoleId, before?.customRoleId].filter((id): id is string => !!id))];
    const rows = await db.tenantCustomRole.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, baseRole: true, permissionsJson: true },
        take: ids.length,
    });
    const byId = new Map<string, CustomRoleForCarriage>(rows.map((r) => [r.id, r]));
    const shape = (id: string | null | undefined) => (id ? (byId.get(id) ?? null) : null);
    const refusal = customRoleCarriageRefusal(
        { membershipRole: after.role, customRole: shape(after.customRoleId) },
        before ? { membershipRole: before.role, customRole: shape(before.customRoleId) } : null,
    );
    if (refusal) throw carriageConflict(refusal, asked);
}

function carriageConflict(
    refusal: CustomRoleCarriageRefusal,
    asked: Parameters<typeof customRoleCarriageMessage>[1],
    blockingMemberships?: number,
): ConflictError {
    return new ConflictError(
        customRoleCarriageMessage(refusal, asked, blockingMemberships),
        customRoleCarriageDetails(refusal, blockingMemberships === undefined ? {} : { blockingMemberships }),
    );
}

/**
 * The save half of the rule: may the role `roleId`, as it stood (`existing`),
 * become `next` while the memberships carrying it hold the roles they hold?
 * Each built-in role among its carriers is asked once (`groupBy`, so a role
 * carried by thousands of members costs one row per built-in role), and the
 * refusal counts every carrier whose built-in role the save would put in
 * breach. Carriers of every status count: a deactivated member carrying the
 * role is one reactivation from carrying it live.
 */
async function assertCustomRoleSaveCarriableInTx(
    db: PrismaTx,
    ctx: RequestContext,
    roleId: string,
    existing: CustomRoleForCarriage,
    next: CustomRoleForCarriage,
): Promise<void> {
    const carriers = await db.tenantMembership.groupBy({
        by: ['role'],
        where: { tenantId: ctx.tenantId, customRoleId: roleId },
        _count: { _all: true },
    });
    let first: CustomRoleCarriageRefusal | null = null;
    let blocking = 0;
    for (const group of carriers) {
        const refusal = customRoleCarriageRefusal(
            { membershipRole: group.role, customRole: next },
            { membershipRole: group.role, customRole: existing },
        );
        if (!refusal) continue;
        first ??= refusal;
        blocking += group._count._all;
    }
    if (first) throw carriageConflict(first, 'save-custom-role', blocking);
}

/** The write of `customRoleId`, after `assertCustomRoleAssignableInTx` has passed. */
export async function writeCustomRoleInTx(
    db: PrismaTx,
    membershipId: string,
    customRoleId: string | null,
) {
    return db.tenantMembership.update({
        where: { id: membershipId },
        data: { customRoleId },
        include: {
            user: { select: { id: true, name: true, email: true } },
            customRole: { select: { id: true, name: true } },
        },
    });
}

/**
 * The audit row for a custom-role change. Written after every write of the
 * request: `logEvent` appends on its own connection, so a row written before a
 * later write failed would narrate a change that rolled back.
 */
export async function logCustomRoleChange(
    db: PrismaTx,
    ctx: RequestContext,
    change: {
        /** The membership as read, with the role it holds once the request applies. */
        membership: { role: Role; customRoleId: string | null; user: { email: string } };
        updated: { id: string; customRole: { name: string } | null };
        customRoleId: string | null;
    },
): Promise<void> {
    const { membership, updated, customRoleId } = change;
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
            fromStatus: membership.customRoleId ?? 'none',
            toStatus: customRoleId ?? 'none',
        },
    });
}
