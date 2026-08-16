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
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import type { Role } from '@prisma/client';

// ─── Valid roles for assignment ───
const VALID_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER'];

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

export async function updateTenantMemberRole(
    ctx: RequestContext,
    input: { membershipId: string; role: Role }
) {
    assertCanChangeRoles(ctx);

    if (!VALID_ROLES.includes(input.role)) {
        throw badRequest(`Invalid role: ${input.role}`);
    }

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            throw notFound('Membership not found or not active.');
        }

        // Safety: prevent self-demotion
        assertNotSelfDemotion(ctx, membership.userId, input.role);

        // Safety: OWNER-boundary checks — only OWNERs can touch OWNER memberships
        // or promote to OWNER. The DB trigger is the backstop; these checks are
        // the user-friendly front door with clearer error messages.
        if (input.role === 'OWNER' && !ctx.appPermissions.admin.owner_management) {
            throw forbidden('Only OWNERs can promote to OWNER.');
        }
        if (membership.role === 'OWNER' && !ctx.appPermissions.admin.owner_management) {
            throw forbidden('Only OWNERs can modify an OWNER membership.');
        }

        // Safety: last-OWNER protection — do not demote the only OWNER.
        if (membership.role === 'OWNER' && input.role !== 'OWNER') {
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
        if (membership.role === 'ADMIN' && input.role !== 'ADMIN' && input.role !== 'OWNER') {
            const adminCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'ADMIN',
                    status: 'ACTIVE',
                },
            });
            if (adminCount <= 1) {
                throw forbidden('Cannot remove the last admin. Promote another member first.');
            }
        }

        const oldRole = membership.role;

        const updated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: { role: input.role },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_ROLE_CHANGED',
            entityType: 'TenantMembership',
            entityId: updated.id,
            details: `Role changed: ${oldRole} → ${input.role} for ${membership.user.email}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: oldRole,
                toStatus: input.role,
            },
        });

        return updated;
    });
}

// ─── Deactivate Member ───

export async function deactivateTenantMember(
    ctx: RequestContext,
    input: { membershipId: string }
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            throw notFound('Membership not found or not active.');
        }

        // Safety: prevent self-deactivation
        assertNotSelfDeactivation(ctx, membership.userId);

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
            const adminCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'ADMIN',
                    status: 'ACTIVE',
                },
            });
            if (adminCount <= 1) {
                throw forbidden('Cannot deactivate the last admin.');
            }
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
 * deactivate — no self-removal, no removing the last ACTIVE OWNER (the
 * `tenant_membership_last_owner_guard` DB trigger is the fail-closed backstop).
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
