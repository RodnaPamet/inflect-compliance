/**
 * Tenant Admin Usecases — Member Management & Settings
 *
 * Core admin functions for Epic 12: Admin UI & RBAC Management.
 * All mutations require ADMIN role, enforced server-side via policies.
 *
 * Safety invariants:
 *   - Cannot demote yourself (last-admin protection)
 *   - Cannot deactivate yourself
 *   - Cannot assign a role higher than ADMIN (only ADMIN exists above EDITOR)
 *
 * @module usecases/tenant-admin
 */
import { RequestContext } from '../types';
import {
    assertCanManageMembers,
    assertCanChangeRoles,
    assertCanViewAdminSettings,
    assertNotSelfDemotion,
    assertNotSelfDeactivation,
} from '../policies/admin.policies';
import { assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { notFound, badRequest, forbidden, ConflictError } from '@/lib/errors/types';
import type { Role } from '@prisma/client';
import {
    BUILT_IN_SCOPE_REFUSAL,
    builtInScopeRoleMessage,
    isMemberRoleChangeRole,
    isOwnerManagedRole,
    mayCarryCustomRole,
    OWNER_MANAGED_MEMBERSHIP_END_REFUSAL,
    ownerManagedMembershipEndMessage,
    ownerManagedRoleMessage,
    unassignableRoleMessage,
} from '@/lib/roles';
import {
    assertCustomRoleAssignableInTx,
    logCustomRoleChange,
    writeCustomRoleInTx,
} from './custom-roles';

// Safety cap on the two whole-tenant membership scans below. Both feed
// surfaces that legitimately want every member (the admin roster, and the
// people-picker options), so neither can paginate — the cap is a latency and
// memory guard against a pathological tenant, not a page size. Set an order
// of magnitude above the largest plausible tenant so it does not bind in
// practice; when it does bind, it truncates the OLDEST-first ordering
// deterministically rather than returning an arbitrary subset.
//
// Neither read was bounded before, and the Layer-D2 unbounded-findMany budget
// could not see them: D2 scans `src/app-layer/repositories`, and these live in
// usecases.
const MEMBERSHIP_SCAN_CAP = 5000;

// ─── List Members ───

export async function listTenantMembers(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);
    const memberships = await runInTenantContext(ctx, (db) =>
        db.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { in: ['ACTIVE', 'INVITED', 'DEACTIVATED'] },
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                        createdAt: true,
                    },
                },
                invitedBy: {
                    select: { id: true, name: true },
                },
                customRole: {
                    select: { id: true, name: true },
                },
            },
            orderBy: { createdAt: 'asc' },
            take: MEMBERSHIP_SCAN_CAP,
        })
    );

    // Epic C.3 — attach live-session counts so the admin members UI
    // can surface "3 active sessions" without an N+1 cascade of
    // requests. Best-effort: a DB failure falls back to 0 counts and
    // the UI degrades gracefully rather than failing the whole page.
    let counts: Record<string, number> = {};
    try {
        const { countActiveSessionsForTenantUsers } = await import(
            '@/lib/security/session-tracker'
        );
        counts = await countActiveSessionsForTenantUsers(ctx.tenantId);
    } catch {
        counts = {};
    }
    return memberships.map((m) => ({
        ...m,
        activeSessionCount: counts[m.userId] ?? 0,
    }));
}

// ─── List Assignable Users (B1 — task-assignee population fix) ───
//
// `listTenantMembers` above is admin-gated — that's correct because
// the admin view exposes session counts, invite state, deactivated
// rows, and custom-role linkage. But the in-product
// "assign this task / risk / evidence to a teammate" pickers need a
// roster too, and non-admin users (EDITOR / READER) have a real
// reason to read it. Pre-B1 the only roster endpoint was the
// admin one, so the `<UserCombobox>` silently rendered an empty
// dropdown for everyone below ADMIN.
//
// This usecase returns the MINIMAL safe shape — id + name + email +
// image, ACTIVE rows only, no session counts, no role badges, no
// invite/deactivated rows. Read access via `assertCanRead`, which
// every signed-in tenant member has.

export interface AssignableUser {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
}

export async function listAssignableUsers(
    ctx: RequestContext,
): Promise<AssignableUser[]> {
    assertCanRead(ctx);
    const memberships = await runInTenantContext(ctx, (db) =>
        db.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            select: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                    },
                },
            },
            orderBy: { createdAt: 'asc' },
            take: MEMBERSHIP_SCAN_CAP,
        }),
    );
    return memberships.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
    }));
}

// ─── Invite Member (DEPRECATED — use createInviteToken from tenant-invites.ts) ───
//
// This thin wrapper exists purely for backward-compatibility while callers
// are updated. The old "existing user → direct ACTIVE membership" path has
// been REMOVED — every membership must now go through redeemInvite.

export async function inviteTenantMember(
    ctx: RequestContext,
    input: { email: string; role: Role }
) {
    const { createInviteToken } = await import('./tenant-invites');
    const result = await createInviteToken(ctx, input);
    return { type: 'invited' as const, invite: result.invite, url: result.url };
}

// ─── Update Member Role ───

/** The membership row the role change and the custom-role change act on. */
type ActiveMembership = {
    id: string;
    userId: string;
    role: Role;
    customRoleId: string | null;
    user: { id: string; name: string | null; email: string };
};

/**
 * Change an EXISTING, ACTIVE member's built-in role — the members page.
 *
 * One of the two writers of `AI_ADMIN` (#3699 deploy 2; the other is an Entra
 * group mapping). It reads `MEMBER_ROLE_CHANGE_ROLES`, the writers' list plus
 * that role, and holds the role's two rules: moving a member INTO or OUT OF it
 * needs `admin.owner_management` (`OWNER_MANAGED_ROLES` — an ADMIN can neither
 * assign nor remove it), and a member carrying a custom role is not moved into
 * it (`mayCarryCustomRole` — refused, never cleared on the caller's behalf).
 *
 * The custom-role rule covers OWNER too since #3720: a member carrying a
 * custom role is not promoted to OWNER until it is removed (409,
 * `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`). An ADMIN never reaches that
 * check — promoting to OWNER is refused to them first.
 */
export async function updateTenantMemberRole(
    ctx: RequestContext,
    input: { membershipId: string; role: Role }
) {
    assertRoleChangeRequested(ctx, input.role);

    return runInTenantContext(ctx, async (db) => {
        const membership = await findActiveMembership(db, ctx, input.membershipId);
        await assertRoleChangeAllowedInTx(db, ctx, membership, input.role);
        const updated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: { role: input.role },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
        await logRoleChange(db, ctx, membership, input.role, updated.id);
        return updated;
    });
}

/**
 * The members page's Save when it changes BOTH the role and the custom role —
 * all or nothing (#4118).
 *
 * These were two requests' worth of work run one after the other, role first,
 * so a refused custom role (one the caller may not grant, or one deleted since
 * the page loaded) answered an error while the role change had already
 * committed. Now every check of both halves runs first, against the
 * membership as read — the custom-role half against the role it is about to
 * hold — then both writes, then both audit rows. A refusal of either half
 * writes nothing.
 *
 * Each half is the same code its single-field usecase runs
 * (`updateTenantMemberRole`, `assignCustomRole`), so the combination can
 * refuse nothing the two would allow one after the other, and allow nothing
 * either would refuse.
 */
export async function updateTenantMemberRoleAndCustomRole(
    ctx: RequestContext,
    input: { membershipId: string; role: Role; customRoleId: string | null }
) {
    assertRoleChangeRequested(ctx, input.role);
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const membership = await findActiveMembership(db, ctx, input.membershipId);
        await assertRoleChangeAllowedInTx(db, ctx, membership, input.role);
        await assertCustomRoleAssignableInTx(db, ctx, input.role, input.customRoleId);

        const roleChanged = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: { role: input.role },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
        const updated = await writeCustomRoleInTx(db, input.membershipId, input.customRoleId);

        await logRoleChange(db, ctx, membership, input.role, roleChanged.id);
        await logCustomRoleChange(db, ctx, {
            membership: { ...membership, role: input.role },
            updated,
            customRoleId: input.customRoleId,
        });
        return updated;
    });
}

/** The role change's checks that need no database: the caller and the role asked for. */
function assertRoleChangeRequested(ctx: RequestContext, role: Role): void {
    assertCanChangeRoles(ctx);

    // `MEMBER_ROLE_CHANGE_ROLES`, not `Role`: a new enum value is unassignable
    // here until it is added there on purpose.
    if (!isMemberRoleChangeRole(role)) {
        throw badRequest(unassignableRoleMessage(role));
    }
    // Into an OWNER-managed role — refused before the membership is even read.
    // OWNER keeps its own wording below; this is the AI_ADMIN half.
    const intoOwnerManaged = role !== 'OWNER' && isOwnerManagedRole(role);
    if (intoOwnerManaged && !ctx.appPermissions.admin.owner_management) {
        throw forbidden(ownerManagedRoleMessage(role));
    }
}

async function findActiveMembership(
    db: PrismaTx,
    ctx: RequestContext,
    membershipId: string,
): Promise<ActiveMembership> {
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
    return membership;
}

/** Every refusal of a role change that reads the membership or the tenant. Writes nothing. */
async function assertRoleChangeAllowedInTx(
    db: PrismaTx,
    ctx: RequestContext,
    membership: ActiveMembership,
    role: Role,
): Promise<void> {
    // Safety: prevent self-demotion
    assertNotSelfDemotion(ctx, membership.userId, role);

    // Safety: OWNER-boundary checks — only OWNERs can touch OWNER memberships
    // or promote to OWNER. The DB trigger is the backstop; these checks are
    // the user-friendly front door with clearer error messages.
    if (role === 'OWNER' && !ctx.appPermissions.admin.owner_management) {
        throw forbidden('Only OWNERs can promote to OWNER.');
    }
    if (membership.role === 'OWNER' && !ctx.appPermissions.admin.owner_management) {
        throw forbidden('Only OWNERs can modify an OWNER membership.');
    }
    // Out of an OWNER-managed role (AI_ADMIN).
    if (isOwnerManagedRole(membership.role) && !ctx.appPermissions.admin.owner_management) {
        throw forbidden(ownerManagedRoleMessage(membership.role));
    }

    // A role whose scope is always the built-in one (OWNER, AI_ADMIN) never
    // sits under a custom role, which would replace it at resolution. This
    // also refuses a no-op OWNER → OWNER on a legacy row that carries one:
    // the database CHECK would refuse that write anyway, without a reason.
    if (membership.customRoleId && !mayCarryCustomRole(role)) {
        throw new ConflictError(builtInScopeRoleMessage(role, 'promote'), {
            reason: BUILT_IN_SCOPE_REFUSAL,
        });
    }

    // Safety: last-OWNER protection — do not demote the only OWNER.
    if (membership.role === 'OWNER' && role !== 'OWNER') {
        const ownerCount = await db.tenantMembership.count({
            where: {
                tenantId: ctx.tenantId,
                role: 'OWNER',
                status: 'ACTIVE',
            },
        });
        if (ownerCount <= 1) {
            throw forbidden('Cannot demote the last OWNER. Promote another OWNER first.');
        }
    }

    // Safety: last-admin protection (legacy — keep for non-OWNER admins)
    if (membership.role === 'ADMIN' && role !== 'ADMIN' && role !== 'OWNER') {
        await assertNotLastActiveAdmin(db, ctx, 'Cannot remove the last admin. Promote another member first.');
    }
}

async function logRoleChange(
    db: PrismaTx,
    ctx: RequestContext,
    membership: ActiveMembership,
    role: Role,
    entityId: string,
): Promise<void> {
    await logEvent(db, ctx, {
        action: 'MEMBER_ROLE_CHANGED',
        entityType: 'TenantMembership',
        entityId,
        details: `Role changed: ${membership.role} → ${role} for ${membership.user.email}`,
        detailsJson: {
            category: 'status_change',
            entityName: 'TenantMembership',
            fromStatus: membership.role,
            toStatus: role,
        },
    });
}

/**
 * Last-admin protection (legacy — kept for non-OWNER admins): refuse a change
 * that would leave the tenant with no ACTIVE ADMIN. The role change, the
 * deactivation and the removal each ask it, with their own sentence, for a
 * target that is an ACTIVE ADMIN.
 */
async function assertNotLastActiveAdmin(
    db: PrismaTx,
    ctx: RequestContext,
    refusal: string,
): Promise<void> {
    const adminCount = await db.tenantMembership.count({
        where: {
            tenantId: ctx.tenantId,
            role: 'ADMIN',
            status: 'ACTIVE',
        },
    });
    if (adminCount <= 1) {
        throw forbidden(refusal);
    }
}

/**
 * Only an OWNER (a holder of `admin.owner_management`) ends an OWNER-managed
 * membership — OWNER or AI_ADMIN (`OWNER_MANAGED_ROLES`), ACTIVE or
 * DEACTIVATED — the boundary the role change holds. Without it an ADMIN, who
 * cannot so much as change such a member's role, could switch the membership
 * off or delete it. AI_ADMIN joined the rule in #4118 (owner decision).
 */
function assertMayEndMembership(
    ctx: RequestContext,
    membership: { role: Role },
    verb: 'deactivate' | 'remove',
): void {
    if (isOwnerManagedRole(membership.role) && !ctx.appPermissions.admin.owner_management) {
        throw forbidden(ownerManagedMembershipEndMessage(membership.role, verb), {
            reason: OWNER_MANAGED_MEMBERSHIP_END_REFUSAL,
        });
    }
}

// ─── Deactivate Member ───

export async function deactivateTenantMember(
    ctx: RequestContext,
    input: { membershipId: string }
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const membership = await findActiveMembership(db, ctx, input.membershipId);

        // Safety: prevent self-deactivation
        assertNotSelfDeactivation(ctx, membership.userId);

        // Safety: only an OWNER deactivates an OWNER or an AI_ADMIN.
        assertMayEndMembership(ctx, membership, 'deactivate');

        // Safety: last-OWNER protection — cannot deactivate the only OWNER.
        if (membership.role === 'OWNER') {
            const ownerCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });
            if (ownerCount <= 1) {
                throw forbidden('Cannot deactivate the last OWNER.');
            }
        }

        // Safety: last-admin protection (legacy — keep for non-OWNER admins)
        if (membership.role === 'ADMIN') {
            await assertNotLastActiveAdmin(db, ctx, 'Cannot deactivate the last admin.');
        }

        const deactivated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: {
                status: 'DEACTIVATED',
                deactivatedAt: new Date(),
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_DEACTIVATED',
            entityType: 'TenantMembership',
            entityId: deactivated.id,
            details: `Deactivated member: ${membership.user.email}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: 'ACTIVE',
                toStatus: 'DEACTIVATED',
            },
        });

        return deactivated;
    });
}

/**
 * Hard-remove a member from the tenant (deletes the TenantMembership row).
 * Distinct from deactivate (soft, revocable): this fully detaches the user.
 * Works on ACTIVE or already-DEACTIVATED members. Same guardrails as
 * deactivate — no self-removal, an OWNER or an AI_ADMIN only by an OWNER, no
 * removing the last ACTIVE OWNER (the `tenant_membership_last_owner_guard` DB
 * trigger is the fail-closed backstop) and no removing the last ACTIVE ADMIN
 * (#4118 — deactivation refused it while removal allowed it).
 */
export async function removeTenantMember(
    ctx: RequestContext,
    input: { membershipId: string }
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            throw notFound('Membership not found.');
        }

        // Safety: prevent self-removal.
        if (ctx.userId === membership.userId) {
            throw forbidden('Cannot remove your own membership. Ask another admin.');
        }

        // Safety: only an OWNER removes an OWNER or an AI_ADMIN, ACTIVE or
        // DEACTIVATED — the same boundary as deactivation and the role change.
        assertMayEndMembership(ctx, membership, 'remove');

        // Safety: last-OWNER protection — cannot remove the only ACTIVE OWNER.
        if (membership.role === 'OWNER' && membership.status === 'ACTIVE') {
            const ownerCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });
            if (ownerCount <= 1) {
                throw forbidden('Cannot remove the last OWNER. Promote another OWNER first.');
            }
        }

        // Safety: last-admin protection — the check the role change and the
        // deactivation ask. A DEACTIVATED admin is not counted, so removing one
        // leaves the count as it was.
        if (membership.role === 'ADMIN' && membership.status === 'ACTIVE') {
            await assertNotLastActiveAdmin(db, ctx, 'Cannot remove the last admin. Promote another member first.');
        }

        await db.tenantMembership.delete({
            where: { id: input.membershipId },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_REMOVED',
            entityType: 'TenantMembership',
            entityId: membership.id,
            details: `Removed member: ${membership.user.email}`,
            // `logEvent` validates detailsJson.category against the 6-value
            // AuditDetailsJsonSchema enum — a hard delete is `entity_lifecycle`
            // + operation:'delete' (NOT the 'membership' category, which is
            // only accepted by the lower-level appendAuditEntry path).
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantMembership',
                operation: 'delete',
                event: 'member_removed',
            },
        });

        return { id: membership.id, userId: membership.userId };
    });
}

// ─── Tenant Admin Settings ───

export async function getTenantAdminSettings(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [tenant, memberCounts, pendingInvites, identityProviders, securitySettings] =
            await Promise.all([
                db.tenant.findUnique({
                    where: { id: ctx.tenantId },
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        industry: true,
                        createdAt: true,
                    },
                }),
                db.tenantMembership.groupBy({
                    by: ['status'],
                    where: { tenantId: ctx.tenantId },
                    _count: { id: true },
                }),
                db.tenantInvite.count({
                    where: {
                        tenantId: ctx.tenantId,
                        acceptedAt: null,
                        revokedAt: null,
                        expiresAt: { gt: new Date() },
                    },
                }),
                db.tenantIdentityProvider.findMany({
                    where: { tenantId: ctx.tenantId },
                    select: {
                        id: true,
                        name: true,
                        type: true,
                        isEnabled: true,
                        isEnforced: true,
                    },
                }),
                db.tenantSecuritySettings.findUnique({
                    where: { tenantId: ctx.tenantId },
                    select: {
                        mfaPolicy: true,
                        sessionMaxAgeMinutes: true,
                    },
                }),
            ]);

        const statusCounts: Record<string, number> = {};
        for (const g of memberCounts) {
            statusCounts[g.status] = g._count.id;
        }

        return {
            tenant,
            members: {
                active: statusCounts['ACTIVE'] ?? 0,
                invited: statusCounts['INVITED'] ?? 0,
                deactivated: statusCounts['DEACTIVATED'] ?? 0,
                total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
            },
            pendingInvites,
            identityProviders,
            security: securitySettings ?? { mfaPolicy: 'DISABLED', sessionMaxAgeMinutes: null },
        };
    });
}

// ─── List Pending Invites (DEPRECATED — use listPendingInvites from tenant-invites.ts) ───

export async function listPendingInvites(ctx: RequestContext) {
    const { listPendingInvites: listInvites } = await import('./tenant-invites');
    return listInvites(ctx);
}

// ─── Revoke Invite (DEPRECATED — use revokeInvite from tenant-invites.ts) ───

export async function revokeInvite(ctx: RequestContext, inviteId: string) {
    const { revokeInvite: revoke } = await import('./tenant-invites');
    return revoke(ctx, { inviteId });
}
