import type { Role, OrgRole } from '@prisma/client';

export type PermissionSet = {
    controls: { view: boolean; create: boolean; edit: boolean };
    evidence: { view: boolean; upload: boolean; edit: boolean; download: boolean };
    policies: { view: boolean; create: boolean; edit: boolean; approve: boolean };
    tasks: { view: boolean; create: boolean; edit: boolean; assign: boolean };
    risks: { view: boolean; create: boolean; edit: boolean };
    assets: { view: boolean; create: boolean; edit: boolean };
    vendors: { view: boolean; create: boolean; edit: boolean };
    tests: { view: boolean; create: boolean; execute: boolean };
    /**
     * NIS2 Article 23 incident response. `manage` (create incidents,
     * advance phases, mark reportable, file regulatory notifications) is
     * a privileged security-team action — ADMIN/OWNER only, NOT a general
     * editor action. `view` is available to every member for compliance
     * visibility.
     */
    incidents: { view: boolean; manage: boolean };
    /** People layer (PR-4). `manage` = connect HRIS + edit the roster (OWNER/ADMIN); `view` for all. */
    personnel: { view: boolean; manage: boolean };
    frameworks: { view: boolean; install: boolean };
    audits: { view: boolean; manage: boolean; freeze: boolean; share: boolean };
    reports: {
        view: boolean;
        export: boolean;
        /**
         * Point a RECURRING report delivery at an address outside this tenant's
         * own membership (allowlisted per `TenantSecuritySettings`).
         *
         * Separate from `export` on purpose. A one-off export hands data to the
         * person who asked for it and is already bounded by their session; a
         * schedule is a standing outbound feed that keeps sending after that
         * person loses access. Creating one to a colleague stays at write level;
         * aiming it off-tenant is the elevation.
         */
        schedule_external: boolean;
    };
    admin: {
        view: boolean;
        manage: boolean;
        members: boolean;
        sso: boolean;
        scim: boolean;
        /**
         * Tenant lifecycle operations: delete tenant, rotate DEK,
         * transfer ownership. OWNER-only by policy; ADMIN gets false.
         */
        tenant_lifecycle: boolean;
        /**
         * Invite / remove OWNERs, assign OWNER role. OWNER-only by
         * policy; ADMIN gets false (ADMIN can still invite ADMIN).
         */
        owner_management: boolean;
        /**
         * READ the DSAR register (GDPR Art. 15/16 rights requests).
         * Granted to AUDITOR as well as OWNER/ADMIN — reading the
         * rights-request log IS the auditor's job, and a register an
         * auditor cannot see is not serving its purpose.
         */
        compliance_dsar_view: boolean;
        /**
         * RECORD and ADVANCE DSARs. Separate from _view because
         * fulfilment is a staff action with legal consequence; AUDITOR
         * observes the register but never moves a request through it.
         */
        compliance_dsar_manage: boolean;
    };
};

/**
 * Canonical list of all permission domain keys.
 * Used for validation to ensure the JSON shape exactly matches PermissionSet.
 */
const PERMISSION_SCHEMA: Record<keyof PermissionSet, string[]> = {
    controls: ['view', 'create', 'edit'],
    evidence: ['view', 'upload', 'edit', 'download'],
    policies: ['view', 'create', 'edit', 'approve'],
    tasks: ['view', 'create', 'edit', 'assign'],
    risks: ['view', 'create', 'edit'],
    assets: ['view', 'create', 'edit'],
    vendors: ['view', 'create', 'edit'],
    tests: ['view', 'create', 'execute'],
    incidents: ['view', 'manage'],
    personnel: ['view', 'manage'],
    frameworks: ['view', 'install'],
    audits: ['view', 'manage', 'freeze', 'share'],
    reports: ['view', 'export', 'schedule_external'],
    admin: [
        'view', 'manage', 'members', 'sso', 'scim',
        'tenant_lifecycle', 'owner_management',
        'compliance_dsar_view', 'compliance_dsar_manage',
    ],
};

/**
 * Returns a static, granular UI PermissionSet for a given Role.
 * This ensures that client UI elements can rely on a consistent set of booleans
 * instead of manually checking `role === 'ADMIN' || role === 'EDITOR'`
 * which can lead to UI bugs and inconsistencies.
 * 
 * Note: Backend/API authorization must still independently verify permissions.
 */
export function getPermissionsForRole(role: Role): PermissionSet {
    switch (role) {
        case 'OWNER':
            // OWNER = ADMIN + tenant_lifecycle + owner_management.
            // Only role that can delete the tenant, rotate DEK, transfer
            // ownership, invite/remove other OWNERs, or assign OWNER role.
            return {
                controls: { view: true, create: true, edit: true },
                evidence: { view: true, upload: true, edit: true, download: true },
                policies: { view: true, create: true, edit: true, approve: true },
                tasks: { view: true, create: true, edit: true, assign: true },
                risks: { view: true, create: true, edit: true },
                assets: { view: true, create: true, edit: true },
                vendors: { view: true, create: true, edit: true },
                tests: { view: true, create: true, execute: true },
                incidents: { view: true, manage: true },
                personnel: { view: true, manage: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true },
                reports: { view: true, export: true, schedule_external: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    tenant_lifecycle: true, owner_management: true,
                    compliance_dsar_view: true, compliance_dsar_manage: true,
                },
            };
        case 'ADMIN':
            return {
                controls: { view: true, create: true, edit: true },
                evidence: { view: true, upload: true, edit: true, download: true },
                policies: { view: true, create: true, edit: true, approve: true },
                tasks: { view: true, create: true, edit: true, assign: true },
                risks: { view: true, create: true, edit: true },
                assets: { view: true, create: true, edit: true },
                vendors: { view: true, create: true, edit: true },
                tests: { view: true, create: true, execute: true },
                incidents: { view: true, manage: true },
                personnel: { view: true, manage: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true },
                reports: { view: true, export: true, schedule_external: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    // Explicit false: ADMIN is NOT the tenant owner.
                    // Delete / DEK rotation / OWNER management require OWNER role.
                    tenant_lifecycle: false, owner_management: false,
                    compliance_dsar_view: true, compliance_dsar_manage: true,
                },
            };
        case 'EDITOR':
            return {
                controls: { view: true, create: true, edit: true },
                evidence: { view: true, upload: true, edit: true, download: true },
                // Editors cannot approve policies usually, or maybe they can?
                // Aligning with standard EDITOR: can't approve or admin.
                policies: { view: true, create: true, edit: true, approve: false },
                tasks: { view: true, create: true, edit: true, assign: true },
                risks: { view: true, create: true, edit: true },
                assets: { view: true, create: true, edit: true },
                vendors: { view: true, create: true, edit: true },
                tests: { view: true, create: true, execute: true },
                incidents: { view: true, manage: false },
                personnel: { view: true, manage: false },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false },
                reports: { view: true, export: true, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: false, compliance_dsar_manage: false },
            };
        case 'AUDITOR':
            return {
                controls: { view: true, create: false, edit: false },
                // Auditors can often download evidence but not upload/edit
                evidence: { view: true, upload: false, edit: false, download: true },
                policies: { view: true, create: false, edit: false, approve: false },
                // Auditors might be able to assign or comment on tasks, but typically read-only. We'll set read-only here.
                tasks: { view: true, create: false, edit: false, assign: false },
                risks: { view: true, create: false, edit: false },
                assets: { view: true, create: false, edit: false },
                vendors: { view: true, create: false, edit: false },
                tests: { view: true, create: false, execute: false },
                incidents: { view: true, manage: false },
                personnel: { view: true, manage: false },
                frameworks: { view: true, install: false },
                // Auditors can view and maybe export/share depending on policy, but let's keep view/share
                audits: { view: true, manage: false, freeze: false, share: true },
                reports: { view: true, export: true, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: true, compliance_dsar_manage: false },
            };
        case 'READER':
        default:
            return {
                controls: { view: true, create: false, edit: false },
                evidence: { view: true, upload: false, edit: false, download: true },
                policies: { view: true, create: false, edit: false, approve: false },
                tasks: { view: true, create: false, edit: false, assign: false },
                risks: { view: true, create: false, edit: false },
                assets: { view: true, create: false, edit: false },
                vendors: { view: true, create: false, edit: false },
                tests: { view: true, create: false, execute: false },
                incidents: { view: true, manage: false },
                personnel: { view: true, manage: false },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false },
                reports: { view: true, export: false, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: false, compliance_dsar_manage: false },
            };
    }
}

// ─── Hub-and-spoke organization permissions (Epic O-2) ────────────────────
//
// Org-level permissions are deliberately KEPT SEPARATE from the tenant-
// level `PermissionSet` rather than nested inside it. The two govern
// different domains: tenant `PermissionSet` controls per-tenant
// resource access (controls, evidence, risks, etc.); `OrgPermissionSet`
// controls portfolio-level access (the org dashboard, tenant lifecycle
// under the org, org member management).
//
// They never mix: a request resolves EITHER `RequestContext` (tenant
// scope, via `getTenantCtx`) OR `OrgContext` (org scope, via
// `getOrgCtx`) — never both at the same time. The drill-down from
// portfolio → tenant detail re-resolves as `RequestContext` against
// the auto-provisioned AUDITOR membership, where the existing
// per-tenant permissions take over.

/**
 * Portfolio-level permissions for a hub-and-spoke organization.
 *
 *   - canViewPortfolio  — see the org dashboard summary cards
 *                         (snapshot aggregates across child tenants).
 *   - canDrillDown      — open per-tenant detail rows from the
 *                         portfolio. ORG_ADMIN only — relies on the
 *                         auto-provisioned AUDITOR `TenantMembership`
 *                         in every child tenant; ORG_READER doesn't
 *                         get that auto-provisioning, so even if the
 *                         UI hint were `true` they'd 403 at the
 *                         tenant RLS layer.
 *   - canExportReports  — CSV/PDF export of portfolio summary +
 *                         non-performing items. Available to both
 *                         org roles; the export only contains data
 *                         the role can see (snapshot data for both;
 *                         drill-down content for ORG_ADMIN only).
 *   - canManageTenants  — create new tenants under the org, link
 *                         existing tenants. ORG_ADMIN only.
 *   - canManageMembers  — add / remove / role-change org members.
 *                         ORG_ADMIN only.
 *   - canConfigureDashboard — add / update / delete the widgets that
 *                         compose the org-level dashboard. ORG_ADMIN
 *                         only. Read access to the rendered dashboard
 *                         is gated by `canViewPortfolio`; this flag
 *                         only controls the configuration layer
 *                         (Epic 41 — Configurable Dashboard Widget Engine).
 */
export type OrgPermissionSet = {
    canViewPortfolio: boolean;
    canDrillDown: boolean;
    canExportReports: boolean;
    canManageTenants: boolean;
    canManageMembers: boolean;
    canConfigureDashboard: boolean;
    /**
     * Set the org-wide threat posture (the ORG_THREAT_LEVEL widget).
     * Narrower-intent than `canConfigureDashboard` — broadcasting a
     * curated security signal is more privileged than moving a widget,
     * so it gets its own flag (ORG_ADMIN only) even though both map to
     * ORG_ADMIN in v1. The set action audits via ORG_THREAT_LEVEL_SET.
     */
    canSetThreatLevel: boolean;
    /**
     * Set the org security-maturity rating (the ORG_MATURITY widget).
     * Like canSetThreatLevel, a privileged curated-judgment action
     * (ORG_ADMIN only); audits via ORG_MATURITY_RATING_SET.
     */
    canSetMaturity: boolean;
};

/**
 * Maps an OrgRole to its concrete permission booleans.
 *
 * The role-to-permission mapping is intentionally hard-coded (no
 * custom-role overrides at the org layer in v1) — org membership
 * roles are simple by design, and any future complexity is better
 * addressed by adding new roles than by per-org policy blobs.
 */
export function getOrgPermissions(role: OrgRole): OrgPermissionSet {
    switch (role) {
        case 'ORG_ADMIN':
            return {
                canViewPortfolio: true,
                canDrillDown: true,
                canExportReports: true,
                canManageTenants: true,
                canManageMembers: true,
                canConfigureDashboard: true,
                canSetThreatLevel: true,
                canSetMaturity: true,
            };
        case 'ORG_READER':
            return {
                // Portfolio summary only — no per-tenant drill-down,
                // no management. Future portfolio-only personas (e.g.
                // a board member who needs read-only attestation
                // visibility) slot in here.
                canViewPortfolio: true,
                canDrillDown: false,
                canExportReports: true,
                canManageTenants: false,
                canManageMembers: false,
                canConfigureDashboard: false,
                canSetThreatLevel: false,
                canSetMaturity: false,
            };
        default: {
            // Defensive — Prisma's enum is closed, so the runtime
            // should never reach here. Returning the zero-permission
            // bag matches the fail-closed posture of every other
            // permission helper in this file.
            const _exhaustive: never = role;
            void _exhaustive;
            return {
                canViewPortfolio: false,
                canDrillDown: false,
                canExportReports: false,
                canManageTenants: false,
                canManageMembers: false,
                canConfigureDashboard: false,
                canSetThreatLevel: false,
                canSetMaturity: false,
            };
        }
    }
}

// ─── Custom Role Helpers ───────────────────────────────────────────────────

/**
 * Validates that a JSON value conforms to the PermissionSet shape.
 * Returns a list of error strings; empty list = valid.
 *
 * Used at write-time (creating/updating custom roles) to prevent
 * saving malformed permission blobs.
 */
export function validatePermissionsJson(json: unknown): string[] {
    const errors: string[] = [];

    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return ['permissionsJson must be a non-null object'];
    }

    const obj = json as Record<string, unknown>;
    const expectedDomains = Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[];
    const actualDomains = Object.keys(obj);

    // Check for missing domains
    for (const domain of expectedDomains) {
        if (!(domain in obj)) {
            errors.push(`Missing permission domain: "${domain}"`);
            continue;
        }

        const domainValue = obj[domain];
        if (typeof domainValue !== 'object' || domainValue === null) {
            errors.push(`Permission domain "${domain}" must be an object`);
            continue;
        }

        const domainObj = domainValue as Record<string, unknown>;
        const expectedActions = PERMISSION_SCHEMA[domain];

        for (const action of expectedActions) {
            if (!(action in domainObj)) {
                errors.push(`Missing action "${domain}.${action}"`);
            } else if (typeof domainObj[action] !== 'boolean') {
                errors.push(`"${domain}.${action}" must be boolean, got ${typeof domainObj[action]}`);
            }
        }

        // Check for unexpected actions
        for (const action of Object.keys(domainObj)) {
            if (!expectedActions.includes(action)) {
                errors.push(`Unexpected action "${domain}.${action}"`);
            }
        }
    }

    // Check for unexpected domains
    for (const domain of actualDomains) {
        if (!expectedDomains.includes(domain as keyof PermissionSet)) {
            errors.push(`Unexpected permission domain: "${domain}"`);
        }
    }

    return errors;
}

/**
 * Safely parses a permissionsJson blob from the database into a typed PermissionSet.
 * Falls back to the baseRole's defaults for any missing or invalid fields.
 *
 * Used at read-time to ensure the runtime always has a complete, valid PermissionSet
 * even if the stored JSON is partially malformed (defensive programming).
 */
export function parsePermissionsJson(json: unknown, baseRole: Role): PermissionSet {
    const defaults = getPermissionsForRole(baseRole);

    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return defaults;
    }

    const obj = json as Record<string, Record<string, unknown>>;
    const result = { ...defaults };

    for (const domain of Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]) {
        if (domain in obj && typeof obj[domain] === 'object' && obj[domain] !== null) {
            const actions = PERMISSION_SCHEMA[domain];
            const domainResult: Record<string, boolean> = { ...defaults[domain] };

            for (const action of actions) {
                if (action in obj[domain] && typeof obj[domain][action] === 'boolean') {
                    domainResult[action] = obj[domain][action] as boolean;
                }
            }

            (result as Record<keyof PermissionSet, Record<string, boolean>>)[domain] = domainResult;
        }
    }

    return result;
}

// ─── Privilege-escalation guard ──────────────────────────────────────

/**
 * A single permission the grantor does not itself hold.
 * Shaped `domain.action` (e.g. `admin.tenant_lifecycle`).
 */
export type PermissionKey = string;

/**
 * Which permissions in `granted` exceed `held` — i.e. are `true` in the
 * set being handed out while `false` for the person handing it out.
 *
 * ─── Why this exists ────────────────────────────────────────────────
 *
 * Custom roles resolve through `parsePermissionsJson`, which merges the
 * role's JSON over its base-role defaults. `PERMISSION_SCHEMA.admin`
 * includes `tenant_lifecycle` and `owner_management` — the two flags that
 * separate OWNER from ADMIN and gate deleting the tenant, rotating the
 * tenant DEK, and managing OWNERs.
 *
 * Every custom-role entrypoint is gated on `assertCanAdmin`, so an ADMIN
 * could previously mint a role setting those two true, assign it to
 * themselves, and hold OWNER-only powers on the next request. The enum
 * path makes that impossible at compile time
 * (`getPermissionsForRole('ADMIN').admin.tenant_lifecycle` is `false` by
 * type); the custom-role path bypassed it entirely.
 *
 * The invariant is the ordinary one for delegated authority: you cannot
 * grant what you do not hold. Revoking is always allowed — handing out
 * LESS than you hold is not escalation.
 */
export function permissionsExceeding(
    granted: PermissionSet,
    held: PermissionSet,
): PermissionKey[] {
    const exceeded: PermissionKey[] = [];
    for (const domain of Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]) {
        for (const action of PERMISSION_SCHEMA[domain]) {
            const wants = (granted[domain] as Record<string, boolean> | undefined)?.[action];
            const has = (held[domain] as Record<string, boolean> | undefined)?.[action];
            if (wants === true && has !== true) exceeded.push(`${domain}.${action}`);
        }
    }
    return exceeded;
}
