/**
 * The permissions only a custom role based on ADMIN may hold (#4536, #4581 A;
 * owner decisions 2026-10-30).
 *
 * A custom role's base role is what every coarse-tier check reads
 * (`canAdmin` / `assertCanAdmin`). A route gated on one of these keys passes a
 * role that grants it, and the server code behind the route then asks the
 * Admin tier, which a Reader, Editor or Auditor base does not have — so the
 * role was let in and refused, with no `AUTHZ_DENIED` row. The owner chose to
 * refuse the combination itself: the Roles page stops offering these keys on
 * other bases, `createCustomRole` / `updateCustomRole` refuse them, and
 * migrations switch off the grants already stored.
 *
 * Every `admin` key is classified in exactly one of the two lists below, so a
 * new one fails `tests/unit/custom-role-admin-base-rule.test.ts` until somebody
 * decides which.
 *
 * Client-safe: no server imports, so the Roles page applies the same rule.
 */

/** The refusal reason, in `error.details.reason`; the keys are in `error.details.permissions`. */
export const PERMISSION_NEEDS_ADMIN_BASE = 'PERMISSION_NEEDS_ADMIN_BASE' as const;

/**
 * Held only on an ADMIN base, each because server code behind a route gated on
 * it asks the Admin tier.
 */
export const ADMIN_BASE_ONLY_PERMISSIONS = [
    // Most of its routes reach `assertCanAdmin` (#4581 A; the custom roles and
    // integrations pages are where it was found).
    'admin.manage',
    // Member, invite, custom-role assignment and session usecases call
    // `assertCanManageMembers`.
    'admin.members',
    // Read inside the member and invite usecases, behind the same check.
    'admin.owner_management',
    // OWNER-only; two of its routes (external prior-state read, MCP server
    // token) reach `assertCanAdmin`.
    'admin.tenant_lifecycle',
    // #4536: the roster read is off on every other base, so a role could
    // create records it could not list.
    'personnel.manage',
] as const;

export type AdminBaseOnlyPermission = (typeof ADMIN_BASE_ONLY_PERMISSIONS)[number];

/**
 * The `admin` keys a custom role may hold on any base, and why. Not read by
 * the rule; it exists so every admin key is a decision.
 */
export const ADMIN_KEYS_ON_ANY_BASE: Readonly<Record<string, string>> = {
    view: 'Also gates agent runs and proposals, outside /admin, with no Admin-tier check; the admin pages need an Admin membership anyway (#4581 B).',
    sso: 'No server code reads it.',
    scim: 'Its one route checks the key and nothing else.',
    compliance_dsar_view: 'The built-in Auditor holds it; the read checks the key.',
    compliance_dsar_manage: 'The register usecase checks the key, not the tier.',
    agent_registry: 'Agent usecases take the coarse tier OR the key (assertAgentGovernance*).',
    agent_registry_view: 'Read-only inventory key; the built-in Auditor holds it.',
    agent_tool_exposure: 'Agent governance floor: tier OR key.',
    agent_policy_card: 'Agent governance floor: tier OR key.',
    agent_kill_switch: 'Agent governance floor: tier OR key.',
    agent_external_tools: 'Agent governance floor: tier OR key.',
    agent_harness_ingest: 'Agent governance floor: tier OR key.',
    agent_ownership: 'Agent governance floor: tier OR key; the built-in AI admin, on a Reader rung, holds it.',
    agent_skill_review: 'Agent governance floor: tier OR key.',
    agent_skill_author: 'Agent governance floor: tier OR key.',
};

const ADMIN_BASE_ONLY = new Set<string>(ADMIN_BASE_ONLY_PERMISSIONS);

/** Whether `domain.action` is held only on an ADMIN base. */
export function needsAdminBase(domain: string, action: string): boolean {
    return ADMIN_BASE_ONLY.has(`${domain}.${action}`);
}

/** Whether a custom role on `baseRole` may hold `domain.action`. */
export function mayHoldOnBase(baseRole: string, domain: string, action: string): boolean {
    return baseRole === 'ADMIN' || !needsAdminBase(domain, action);
}

/**
 * The Admin-base-only keys a stored or submitted permission blob grants
 * (`true`), in list order. Empty for a blob that grants none of them.
 */
export function adminBaseOnlyGrants(permissionsJson: unknown): AdminBaseOnlyPermission[] {
    const blob = (permissionsJson ?? {}) as Record<string, Record<string, unknown> | undefined>;
    return ADMIN_BASE_ONLY_PERMISSIONS.filter((key) => {
        const [domain, action] = key.split('.');
        return blob[domain]?.[action] === true;
    });
}

/** The keys `permissionsJson` grants that `baseRole` may not hold. Empty on an ADMIN base. */
export function grantsNeedingAdminBase(permissionsJson: unknown, baseRole: string): AdminBaseOnlyPermission[] {
    return baseRole === 'ADMIN' ? [] : adminBaseOnlyGrants(permissionsJson);
}

/** The refused keys when a parsed API error body is this refusal, else `null`. */
export function adminBaseRefusalPermissions(body: unknown): string[] | null {
    const details = (body as { error?: { details?: { reason?: unknown; permissions?: unknown } } } | null)?.error?.details;
    if (details?.reason !== PERMISSION_NEEDS_ADMIN_BASE) return null;
    return Array.isArray(details.permissions) ? details.permissions.filter((k): k is string => typeof k === 'string') : [];
}
