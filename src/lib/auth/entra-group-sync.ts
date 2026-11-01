/**
 * EI-3 — Entra group → IC-role enforcement at sign-in.
 *
 * EI-1 puts the user's AAD groups on the token; EI-2 stores the per-tenant
 * group → role mappings. EI-3 is where they meet: at every `microsoft-entra-id`
 * sign-in we resolve the user's groups against the mappings of EVERY workspace
 * they belong to that has a Microsoft Entra ID provider (#4869, owner decision
 * 2026-11-01 — it used to be the session's primary workspace alone) and
 *   1. **sync** the role of their EXISTING active membership to the mapped role
 *      (an UPDATE — never a join; membership creation stays on the Epic 1 paths
 *      so the no-auto-join invariant is untouched), and
 *   2. **enforce the group gate** — when `enforceGroupGate` is on and the user
 *      matches no mapped group, deny tenant access for the session.
 *
 * A sign-in counts only from the Microsoft directory this workspace configured
 * (`aadTenantId` on its Entra provider, matched against the ID token's `tid`).
 * The deployment's Microsoft app can admit any directory, and the mappings are
 * the workspace's own; a user from another directory gets no mapped role, and
 * is refused by the gate when it is on. A workspace with mappings but no
 * configured directory applies none at sign-in. SCIM's Groups push is not a
 * sign-in and carries no directory: it is authenticated by the workspace's own
 * SCIM token instead.
 *
 * The provider's "Allowed sign-in domains" (`emailDomains`) narrow it further
 * (#4869, owner decision 2026-11-01): a sign-in whose email domain is not on a
 * non-empty list gets no role from the mappings, and is refused by the gate
 * when it is on (`domain_not_allowed`). It only ever narrows — the directory
 * check runs first — so it stays an Admin setting.
 *
 * A gate refusal holds for the session: `applyEntraSyncToToken` records the
 * workspace in `entraGateDeniedTenantIds`, the periodic membership re-read
 * leaves it out, and the DB-backed workspace gates refuse it
 * (`src/lib/auth/entra-gate-scope.ts`). The next Microsoft sign-in decides
 * again.
 *
 * OWNER is immune to both: a misconfigured mapping must never demote or lock out
 * a tenant owner (ownership is manually managed, and the last-OWNER guard would
 * reject a demotion anyway). Group sync only ever *raises/sets* a role to a
 * matched mapping — it never demotes a user who matches nothing (use the gate to
 * deny access, or remove the membership manually).
 *
 * It is one of the two writers of `AI_ADMIN` (#3699 deploy 2), and it holds the
 * role's one structural rule as the members page does: a membership carrying a
 * custom role is never moved into it (`mayCarryCustomRole`). Such a sync
 * changes nothing and records `custom_role_held`. It holds the same way for a
 * custom role only an ADMIN membership may carry — one built on ADMIN, or
 * granting an admin-membership-only key (owner decision, 2026-10-30;
 * `customRoleCarriageRefusal`): a mapping never moves such an ADMIN to another
 * role with it kept.
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
import { customRoleCarriageRefusal, mayCarryCustomRole } from '@/lib/roles';
import { parseEntraConfig } from '@/app-layer/schemas/entra-provider.schemas';
import { emailDomainAllowed } from './entra-gate-scope';

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
    tenantIdentityProvider: {
        findFirst: (args: unknown) => Promise<{ configJson: unknown; emailDomains?: string[] | null } | null>;
    };
    tenantEntraGroupMapping: {
        findMany: (args: unknown) => Promise<Array<{ aadGroupId: string; role: Role; priority: number }>>;
    };
    tenantMembership: {
        findFirst: (args: unknown) => Promise<{
            id: string;
            role: Role;
            customRoleId?: string | null;
            customRole?: { baseRole: Role; permissionsJson: unknown } | null;
        } | null>;
        update: (args: unknown) => Promise<unknown>;
    };
}

/** Whether a sign-in's directory is the workspace's configured one. GUIDs compare case-insensitively. */
function isConfiguredDirectory(signInDirectoryId: string | null, configured: string | undefined): boolean {
    return Boolean(signInDirectoryId && configured && signInDirectoryId.toLowerCase() === configured.toLowerCase());
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
         * (`SCIM_GROUP_ASSIGNABLE_ROLES`), omitted by the sign-in path where an
         * admin-configured ADMIN mapping is a deliberate feature.
         */
        assignableRoles?: readonly Role[];
        /**
         * The directory (`tid`) the signing-in Microsoft account belongs to.
         * Supplied by the sign-in path, `null` when the token carries none;
         * the mappings and the gate then apply only to the workspace's
         * configured directory. Omitted by the SCIM path, which has no
         * sign-in and is authenticated by the workspace's SCIM token.
         */
        signInDirectoryId?: string | null;
        /**
         * The email the Microsoft sign-in resolved to. Supplied by the sign-in
         * path alongside `signInDirectoryId`; the provider's allowed domains
         * apply only then. `null` is a sign-in with no email, which a
         * non-empty domain list refuses.
         */
        signInEmail?: string | null;
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
        select: {
            id: true,
            role: true,
            customRoleId: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
    });

    // OWNER is immune — never demoted, never gate-locked-out.
    if (membership?.role === 'OWNER') {
        recordEntraRoleSync({ outcome: 'owner_immune' });
        return { effectiveRole: 'OWNER', changed: false, gateDenied: false };
    }

    const provider = await db.tenantIdentityProvider.findFirst({
        where: { tenantId, type: 'ENTRA_ID' },
        select: { configJson: true, emailDomains: true },
    });
    const config = parseEntraConfig(provider?.configJson);

    // A sign-in from any directory but the configured one is not this
    // workspace's to map.
    if (input.signInDirectoryId !== undefined && !isConfiguredDirectory(input.signInDirectoryId, config?.aadTenantId)) {
        recordEntraRoleSync({ outcome: 'foreign_directory' });
        edgeLogger.warn('Entra sign-in from another directory: group mappings not applied', {
            component: 'entra',
            tenantId,
            reason: config?.aadTenantId ? 'directory_mismatch' : 'no_configured_directory',
        });
        return config?.enforceGroupGate ? { effectiveRole: null, changed: false, gateDenied: true } : NO_OP;
    }

    // From the right directory, but not from a domain the workspace allows.
    if (input.signInEmail !== undefined && !emailDomainAllowed(input.signInEmail, provider?.emailDomains ?? [])) {
        recordEntraRoleSync({ outcome: 'domain_not_allowed' });
        edgeLogger.warn('Entra sign-in from a domain the workspace does not allow: group mappings not applied', {
            component: 'entra',
            tenantId,
            reason: 'domain_not_allowed',
        });
        return config?.enforceGroupGate ? { effectiveRole: null, changed: false, gateDenied: true } : NO_OP;
    }

    // A ceiling-bound caller may not touch a membership whose CURRENT role it
    // could not itself have assigned. Without this, a SCIM token holder could
    // not promote an ADMIN but could still demote one — the mirror of the
    // `membership.role !== 'ADMIN'` guard the SCIM Users path already carries.
    if (membership && assignableRoles && !assignableRoles.includes(membership.role)) {
        recordEntraRoleSync({ outcome: 'role_protected' });
        return { effectiveRole: membership.role, changed: false, gateDenied: false };
    }

    const { role: mappedRole, matchedGroupIds, clampedGroupIds, ambiguousGroupIds } = resolveRoleFromGroups(
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
    if (config?.enforceGroupGate && matchedGroupIds.length === 0) {
        recordEntraRoleSync({ outcome: 'gate_denied' });
        edgeLogger.warn('Entra group gate denied sign-in', {
            component: 'entra',
            tenantId,
            reason: 'no_mapped_group',
        });
        return { effectiveRole: null, changed: false, gateDenied: true };
    }

    // An equal-priority tie seniority may not break (AI_ADMIN against a role
    // it does not contain) decides nothing: the membership keeps its role, and
    // the admin settles it with `priority`. See `TIE_DECIDABLE_AGAINST`.
    if (ambiguousGroupIds.length > 0) {
        recordEntraRoleSync({ outcome: 'ambiguous_tie' });
        edgeLogger.warn('Entra role mapping tie left undecided', {
            component: 'entra',
            tenantId,
            reason: 'ambiguous_priority_tie',
            ambiguousGroupIds,
        });
        return NO_OP;
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

    // A role whose scope is always the built-in one (AI_ADMIN) is never written
    // over a custom role — the custom role would REPLACE it at resolution. The
    // mapping does not clear the custom role either: that is a person's change.
    if (membership.customRoleId && !mayCarryCustomRole(mappedRole)) {
        recordEntraRoleSync({ outcome: 'custom_role_held' });
        edgeLogger.warn('Entra role mapping refused: membership carries a custom role', {
            component: 'entra',
            tenantId,
            reason: 'custom_role_on_built_in_scope_role',
            mappedRole,
        });
        return { effectiveRole: membership.role, changed: false, gateDenied: false };
    }

    // Only an ADMIN membership carries a custom role built on ADMIN or
    // granting an admin-membership-only key (owner decision, 2026-10-30). A
    // mapping that would move such an ADMIN to another role with it kept
    // changes nothing, like the rule above, and leaves the custom role to a
    // person. Only what the move ADDS is held: a membership already in breach
    // (data from before the rule) still follows its mappings.
    const carriage = customRoleCarriageRefusal(
        { membershipRole: mappedRole, customRole: membership.customRole ?? null },
        { membershipRole: membership.role, customRole: membership.customRole ?? null },
    );
    if (membership.customRoleId && carriage) {
        recordEntraRoleSync({ outcome: 'custom_role_held' });
        edgeLogger.warn('Entra role mapping refused: membership carries a custom role only an ADMIN may carry', {
            component: 'entra',
            tenantId,
            reason: carriage.reason,
            mappedRole,
        });
        return { effectiveRole: membership.role, changed: false, gateDenied: false };
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
    /** Workspaces the gate refused at this sign-in; held for the session. */
    entraGateDeniedTenantIds?: string[];
}

/**
 * Apply a sync result to the JWT for the tenant it was computed against. Pure +
 * synchronous so it's unit-testable without NextAuth.
 *
 * - **gate denied** → drop the gated tenant from `memberships`, record it in
 *   `entraGateDeniedTenantIds` so the refusal holds for the session, set
 *   `error = 'EntraGroupGateDenied'`, and — only when it was the primary —
 *   recompute the primary claims from the remaining memberships (falling back
 *   to no-tenant / READER). The user keeps every other tenant.
 * - **role synced** → update the matching `memberships[]` entry, and `role`
 *   when it is the primary.
 */
export function applyEntraSyncToToken(
    token: SyncableToken,
    tenantId: string,
    result: EntraRoleSyncResult,
): void {
    if (result.gateDenied) {
        token.memberships = (token.memberships ?? []).filter((m) => m.tenantId !== tenantId);
        const denied = new Set(token.entraGateDeniedTenantIds ?? []);
        denied.add(tenantId);
        token.entraGateDeniedTenantIds = [...denied];
        token.error = 'EntraGroupGateDenied';
        if (token.tenantId !== tenantId) return;
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

    if (result.effectiveRole) {
        const role = result.effectiveRole;
        if (token.tenantId === tenantId) token.role = role;
        token.memberships = (token.memberships ?? []).map((m) =>
            m.tenantId === tenantId ? { ...m, role } : m,
        );
    }
}

/** The extra reads the sign-in fan-out needs, beside {@link EntraSyncDb}. */
export interface EntraSignInDb extends EntraSyncDb {
    tenantMembership: EntraSyncDb['tenantMembership'] & {
        findMany: (args: unknown) => Promise<Array<{ tenantId: string }>>;
    };
    tenantIdentityProvider: EntraSyncDb['tenantIdentityProvider'] & {
        findMany: (args: unknown) => Promise<Array<{ tenantId: string }>>;
    };
}

/**
 * At a Microsoft sign-in, sync every workspace the person belongs to that has
 * a Microsoft Entra ID provider (#4869, owner decision 2026-11-01). Each
 * workspace applies its own rules: its directory, its domains, its mappings,
 * its gate, and OWNER immunity — `syncEntraMembershipRole` once per workspace.
 *
 * A workspace with mappings but no provider applies nothing at sign-in (it has
 * no configured directory), so only workspaces with a provider are asked.
 * One failing workspace is logged and skipped; it never blocks the others or
 * the sign-in.
 */
export async function syncEntraMembershipRolesAtSignIn(
    input: {
        userId: string;
        aadGroups: readonly string[];
        signInDirectoryId: string | null;
        signInEmail: string | null;
    },
    deps: { db?: EntraSignInDb } = {},
): Promise<Array<{ tenantId: string; result: EntraRoleSyncResult }>> {
    const db = (deps.db ?? prisma) as EntraSignInDb;
    const memberships = await db.tenantMembership.findMany({
        where: { userId: input.userId, status: 'ACTIVE', tenant: { deletedAt: null } },
        select: { tenantId: true },
        orderBy: { createdAt: 'asc' },
    });
    if (memberships.length === 0) return [];
    const providers = await db.tenantIdentityProvider.findMany({
        where: { type: 'ENTRA_ID', tenantId: { in: memberships.map((m) => m.tenantId) } },
        select: { tenantId: true },
    });
    const withProvider = new Set(providers.map((p) => p.tenantId));

    const results: Array<{ tenantId: string; result: EntraRoleSyncResult }> = [];
    for (const { tenantId } of memberships) {
        if (!withProvider.has(tenantId)) continue;
        try {
            const result = await syncEntraMembershipRole(
                {
                    userId: input.userId,
                    tenantId,
                    aadGroups: input.aadGroups,
                    signInDirectoryId: input.signInDirectoryId,
                    signInEmail: input.signInEmail,
                },
                { db },
            );
            results.push({ tenantId, result });
        } catch (err) {
            edgeLogger.error('Entra group role-sync failed for a workspace', {
                component: 'entra',
                tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return results;
}
