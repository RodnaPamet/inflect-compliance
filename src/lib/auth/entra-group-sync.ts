/**
 * EI-3 — Entra group → IC-role enforcement at sign-in.
 *
 * EI-1 puts the user's AAD groups on the token; EI-2 stores the per-tenant
 * group → role mappings. EI-3 is where they meet: at every `microsoft-entra-id`
 * sign-in we resolve the user's groups against the active tenant's mappings and
 *   1. **sync** the role of their EXISTING active membership to the mapped role
 *      (an UPDATE — never a join; membership creation stays on the Epic 1 paths
 *      so the no-auto-join invariant is untouched), and
 *   2. **enforce the group gate** — when `enforceGroupGate` is on and the user
 *      matches no mapped group, deny tenant access for the session.
 *
 * OWNER is immune to both: a misconfigured mapping must never demote or lock out
 * a tenant owner (ownership is manually managed, and the last-OWNER guard would
 * reject a demotion anyway). Group sync only ever *raises/sets* a role to a
 * matched mapping — it never demotes a user who matches nothing (use the gate to
 * deny access, or remove the membership manually).
 *
 * Runs inside the NextAuth `jwt` callback, which uses the privileged Prisma
 * client (RLS `superuser_bypass`), so reads/writes go direct — consistent with
 * `applyMembershipClaims`. Every query still filters by `tenantId` explicitly.
 */
import type { Role } from '@prisma/client';
import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { recordEntraRoleSync } from '@/lib/observability/metrics';
import { resolveRoleFromGroups } from './entra-role-mapping';
import { parseEntraConfig } from '@/app-layer/schemas/entra-provider.schemas';

export interface EntraRoleSyncResult {
    /** The role the active-tenant membership should carry after sync (or null). */
    effectiveRole: Role | null;
    /** True when an actual role UPDATE was written. */
    changed: boolean;
    /** True when `enforceGroupGate` denied access (no mapped group matched). */
    gateDenied: boolean;
}

const NO_OP: EntraRoleSyncResult = { effectiveRole: null, changed: false, gateDenied: false };

/** Minimal Prisma surface used here — lets tests inject a mock. */
export interface EntraSyncDb {
    tenantIdentityProvider: { findFirst: (args: unknown) => Promise<{ configJson: unknown } | null> };
    tenantEntraGroupMapping: {
        findMany: (args: unknown) => Promise<Array<{ aadGroupId: string; role: Role; priority: number }>>;
    };
    tenantMembership: {
        findFirst: (args: unknown) => Promise<{ id: string; role: Role } | null>;
        update: (args: unknown) => Promise<unknown>;
    };
}

/**
 * Resolve + apply the user's Entra-group-driven role for one tenant. Pure of
 * NextAuth — takes ids + the resolved group list, returns the decision. Records
 * exactly one `auth.entra.role_sync` metric.
 */
export async function syncEntraMembershipRole(
    input: {
        userId: string;
        tenantId: string;
        aadGroups: readonly string[];
        /**
         * Ceiling on what this caller may resolve to AND on which memberships
         * it may touch. Supplied by the SCIM Groups push path
         * (`SCIM_ASSIGNABLE_ROLES`), omitted by the sign-in path where an
         * admin-configured ADMIN mapping is a deliberate feature.
         */
        assignableRoles?: readonly Role[];
    },
    deps: { db?: EntraSyncDb } = {},
): Promise<EntraRoleSyncResult> {
    const db = (deps.db ?? prisma) as EntraSyncDb;
    const { userId, tenantId, aadGroups, assignableRoles } = input;

    const mappings = await db.tenantEntraGroupMapping.findMany({
        where: { tenantId },
        select: { aadGroupId: true, role: true, priority: true },
    });
    if (mappings.length === 0) {
        recordEntraRoleSync({ outcome: 'no_mappings' });
        return NO_OP;
    }

    const membership = await db.tenantMembership.findFirst({
        where: { userId, tenantId, status: 'ACTIVE' },
        select: { id: true, role: true },
    });

    // OWNER is immune — never demoted, never gate-locked-out.
    if (membership?.role === 'OWNER') {
        recordEntraRoleSync({ outcome: 'owner_immune' });
        return { effectiveRole: 'OWNER', changed: false, gateDenied: false };
    }

    // A ceiling-bound caller may not touch a membership whose CURRENT role it
    // could not itself have assigned. Without this, a SCIM token holder could
    // not promote an ADMIN but could still demote one — the mirror of the
    // `membership.role !== 'ADMIN'` guard the SCIM Users path already carries.
    if (membership && assignableRoles && !assignableRoles.includes(membership.role)) {
        recordEntraRoleSync({ outcome: 'role_protected' });
        return { effectiveRole: membership.role, changed: false, gateDenied: false };
    }

    const { role: mappedRole, matchedGroupIds, clampedGroupIds } = resolveRoleFromGroups(
        aadGroups,
        mappings,
        { assignableRoles },
    );

    if (clampedGroupIds.length > 0) {
        edgeLogger.warn('Entra role mapping clamped to caller ceiling', {
            component: 'entra',
            tenantId,
            reason: 'role_above_ceiling',
            clampedGroupIds,
        });
    }

    // Gate: enforceGroupGate on + no mapped group matched → deny access.
    const provider = await db.tenantIdentityProvider.findFirst({
        where: { tenantId, type: 'ENTRA_ID' },
        select: { configJson: true },
    });
    const config = parseEntraConfig(provider?.configJson);
    if (config?.enforceGroupGate && matchedGroupIds.length === 0) {
        recordEntraRoleSync({ outcome: 'gate_denied' });
        edgeLogger.warn('Entra group gate denied sign-in', {
            component: 'entra',
            tenantId,
            reason: 'no_mapped_group',
        });
        return { effectiveRole: null, changed: false, gateDenied: true };
    }

    if (!mappedRole) {
        recordEntraRoleSync({ outcome: 'no_match' });
        return NO_OP;
    }
    if (!membership) {
        // A role mapped, but there's no membership to sync. Membership creation
        // deliberately stays on the Epic 1 paths (invite / SSO-JIT / SCIM).
        recordEntraRoleSync({ outcome: 'no_membership' });
        return { effectiveRole: mappedRole, changed: false, gateDenied: false };
    }
    if (membership.role === mappedRole) {
        recordEntraRoleSync({ outcome: 'unchanged' });
        return { effectiveRole: mappedRole, changed: false, gateDenied: false };
    }

    await db.tenantMembership.update({
        where: { id: membership.id },
        data: { role: mappedRole },
    });
    recordEntraRoleSync({ outcome: 'synced' });

    try {
        await appendAuditEntry({
            tenantId,
            userId,
            actorType: 'SYSTEM',
            entity: 'TenantMembership',
            entityId: membership.id,
            action: 'MEMBER_ROLE_CHANGED',
            details: `Entra group sync: role ${membership.role} → ${mappedRole}`,
            detailsJson: {
                category: 'access',
                summary: 'Membership role synced from Entra group mapping',
                targetUserId: userId,
                before: { role: membership.role },
                after: { role: mappedRole },
                source: 'entra_group_sync',
                matchedGroupIds,
            },
        });
    } catch (err) {
        // Audit failure must never block sign-in — the role change is committed.
        edgeLogger.error('Entra role-sync audit failed', {
            component: 'entra',
            tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return { effectiveRole: mappedRole, changed: true, gateDenied: false };
}

/** The JWT fields `applyEntraSyncToToken` reads/writes (subset of the full JWT). */
export interface SyncableToken {
    tenantId?: string | null;
    tenantSlug?: string | null;
    role?: Role;
    error?: string;
    memberships?: Array<{ slug: string; role: Role; tenantId: string }>;
}

/**
 * Apply a sync result to the JWT for the tenant it was computed against. Pure +
 * synchronous so it's unit-testable without NextAuth.
 *
 * - **gate denied** → drop the gated tenant from `memberships`, set
 *   `error = 'EntraGroupGateDenied'`, and recompute the primary claims from the
 *   remaining memberships (falling back to no-tenant / READER) — the user lands
 *   on `/no-tenant` for that tenant but keeps any other tenants.
 * - **role synced** → update `role` + the matching `memberships[]` entry.
 */
export function applyEntraSyncToToken(
    token: SyncableToken,
    tenantId: string,
    result: EntraRoleSyncResult,
): void {
    if (result.gateDenied) {
        token.memberships = (token.memberships ?? []).filter((m) => m.tenantId !== tenantId);
        token.error = 'EntraGroupGateDenied';
        const primary = token.memberships[0];
        if (primary) {
            token.tenantId = primary.tenantId;
            token.tenantSlug = primary.slug;
            token.role = primary.role;
        } else {
            token.tenantId = null;
            token.tenantSlug = null;
            token.role = 'READER';
        }
        return;
    }

    if (result.effectiveRole && token.tenantId === tenantId) {
        const role = result.effectiveRole;
        token.role = role;
        token.memberships = (token.memberships ?? []).map((m) =>
            m.tenantId === tenantId ? { ...m, role } : m,
        );
    }
}
