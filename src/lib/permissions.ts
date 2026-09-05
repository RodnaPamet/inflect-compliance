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
    /**
     * Business-continuity register — the Business Impact Analysis, its
     * dependency edges and its control links (ISO 22301 / NIS2 Art.21(2)(c)).
     *
     * ─── ONE ACTION, AND THE ABSENCE OF `view` IS THE DECISION ─────────
     *
     * `edit` mirrors `assertCanWrite` exactly: `computePermissions` sets
     * `canWrite` at role level >= 3, which is OWNER / ADMIN / EDITOR, and the
     * branches below grant `edit` to precisely those three. So the caller set
     * is unchanged for every built-in role, and for every stored custom role
     * too — `parsePermissionsJson` merges over the row's own `baseRole`
     * defaults, and a blob written before this domain existed simply inherits
     * them.
     *
     * There is deliberately NO `view`. Every peer domain has one, so this is
     * the first without, and the reason is that nothing would read it: the BIA
     * reads gate on `assertCanRead`, which is `true` for all five roles, and
     * shipping a checkbox in the custom-role editor that grants and revokes
     * nothing is the exact drift #2225 fixed — a permission the model claims
     * and no code consults. Making reads enforce a new `continuity.view` is a
     * separate, larger behaviour change (it would newly 403 every non-`*` API
     * key that reads the register), and belongs to whoever needs to delegate
     * read visibility, not to a diff about unrecorded refusals.
     */
    continuity: { edit: boolean };
    /**
     * Process maps — the canvas graph, its snapshots and its restore verb.
     *
     * `edit` mirrors `assertCanWrite`, same reasoning and same population as
     * `continuity.edit` above; and there is no `view` for the same reason.
     *
     * DELETING a process map stays on `admin.manage`, NOT this flag:
     * `deleteProcessMap` asserts `assertCanAdmin` because ProcessMap is in
     * neither `SOFT_DELETE_MODELS` nor the `SoftDeletableModel` union, so a
     * mistaken delete has no restore path for any role. Mirroring the assert
     * means the delete keeps the higher bar.
     */
    processes: { edit: boolean };
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
        /**
         * The AGENT REGISTER: register an autonomous agent, change what
         * authority it holds, activate it, suspend it, retire it.
         *
         * Its own key rather than `admin.manage` because of what activation
         * MEANS. An ACTIVE row here is what lets a credential through the
         * `/api/mcp` registration gate, so this flag is the authority to decide
         * which autonomous agents may act inside the tenant at all. Folding it
         * into the general admin flag would have made that decision a side
         * effect of holding any admin authority.
         *
         * NOT split view/manage the way the DSAR pair is. There is a real case
         * for an AUDITOR reading the register — it is the inventory an audit
         * asks for — and the split is the obvious next move; it is left undone
         * rather than guessed at, because a `_view` flag nobody grants is
         * indistinguishable from one nobody needed.
         */
        agent_registry: boolean;
        /**
         * TOOL EXPOSURE: grant or revoke an individual MCP tool for a
         * registered agent.
         *
         * Its own key, separate from `agent_registry`, because the two decide
         * different things and the blast radius of getting them wrong is not
         * the same. `agent_registry` says WHETHER an agent may act — a binary
         * an operator sets once and reviews at audit time. This says WHAT it
         * may reach, tool by tool, and it is the flag that moves whenever
         * somebody wires up a new automation. Folding them together would mean
         * every routine "let the reporting agent read tasks too" grant carried
         * the authority to activate an agent nobody had scored.
         *
         * The narrower key is also the one that can be delegated: a platform
         * team can be trusted to widen an already-approved agent's tool list
         * without also holding the switch that admits new agents.
         */
        agent_tool_exposure: boolean;
        /**
         * THE POLICY CARD: create an agent's machine-readable runtime policy,
         * and widen or narrow it.
         *
         * A THIRD key rather than a reuse of either neighbour, and the split is
         * the same argument `agent_tool_exposure` makes against
         * `agent_registry`, applied once more — because the card is the widest
         * of the three, not the narrowest.
         *
         * A card declares the permitted tools AND the data rung AND the autonomy
         * rung AND the per-run and per-day action budgets AND how many humans
         * must sign what the agent proposes. Folding it into
         * `agent_tool_exposure` would mean every routine "let the reporting
         * agent read tasks too" grant also carried the authority to raise that
         * agent's autonomy ceiling and its action budgets — which is precisely
         * the composition `agent_tool_exposure`'s own docstring rejects one
         * level down. Folding it into `agent_registry` would put the everyday
         * edit behind the switch that admits new agents, and an edit people
         * cannot make is an edit people route around.
         *
         * Granted to OWNER and ADMIN, like both neighbours. Never to a bearer
         * token, not even `*` — see `scopesToPermissions`: a `*` key CARRIED BY
         * an agent that could edit its own card could widen its own ceiling, and
         * a policy its own subject can rewrite is not a policy.
         */
        agent_policy_card: boolean;
    };
};

/**
 * Canonical list of all permission domain keys and their actions.
 *
 * This is the SINGLE SOURCE OF TRUTH for the shape of `PermissionSet`.
 * Used for validation (`validatePermissionsJson`), for merging stored
 * blobs over role defaults (`parsePermissionsJson`), for the
 * escalation guard (`permissionsExceeding`), and — since it is
 * exported — for every surface that needs to enumerate the domains.
 *
 * DO NOT re-declare this list anywhere else. It is exported precisely
 * so that no caller has to. Five hand-written copies existed when #2225
 * measured them and three had drifted: the custom-role editor's grid,
 * its separate `RESOURCE_KEYS` label list, and the API-key scope map.
 * None of the drift was type-checked, because a literal in a different
 * shape from the type it mirrors is not a mirror to the compiler.
 *
 * ADDING A DOMAIN? Two surfaces still enumerate by hand, because what
 * they hold is editorial and cannot be derived — but their COVERAGE is
 * asserted, so a missing entry fails a test rather than shipping:
 *   • `SCOPE_ACTION_MAP` (`src/lib/auth/api-key-auth.ts`) — the
 *     read/write/admin grouping for API-key scopes.
 *   • `SCOPE_GROUPS` (the admin api-keys page) — the operator-facing
 *     labels. A domain missing here is a scope the auth layer accepts
 *     and no operator can grant.
 * Both assertions live in `tests/unit/api-key-management.test.ts`. Only
 * the first of them existed until #2197 followed this instruction and
 * found the second mirror unguarded — the sentence above was true of one
 * surface and stated of two.
 * Everything else — the editor grid, its labels, the MCP guardrail's
 * `KNOWN_RESOURCES` — now derives from this object.
 *
 * Client-safe: this module's only Prisma dependency is an
 * `import type`, which is erased at compile time, so a `'use client'`
 * component can import this constant.
 */
export const PERMISSION_SCHEMA: Record<keyof PermissionSet, string[]> = {
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
    continuity: ['edit'],
    processes: ['edit'],
    frameworks: ['view', 'install'],
    audits: ['view', 'manage', 'freeze', 'share'],
    reports: ['view', 'export', 'schedule_external'],
    admin: [
        'view', 'manage', 'members', 'sso', 'scim',
        'tenant_lifecycle', 'owner_management',
        'compliance_dsar_view', 'compliance_dsar_manage',
        'agent_registry', 'agent_tool_exposure', 'agent_policy_card',
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
                continuity: { edit: true },
                processes: { edit: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true },
                reports: { view: true, export: true, schedule_external: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    tenant_lifecycle: true, owner_management: true,
                    compliance_dsar_view: true, compliance_dsar_manage: true,
                    agent_registry: true, agent_tool_exposure: true,
                    agent_policy_card: true,
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
                continuity: { edit: true },
                processes: { edit: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true },
                reports: { view: true, export: true, schedule_external: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    // Explicit false: ADMIN is NOT the tenant owner.
                    // Delete / DEK rotation / OWNER management require OWNER role.
                    tenant_lifecycle: false, owner_management: false,
                    compliance_dsar_view: true, compliance_dsar_manage: true,
                    // ADMIN holds this. Deciding which agents may act is
                    // operational administration, not tenant ownership — the
                    // two OWNER-only flags above are about the tenant's own
                    // existence and its owners, and an agent register is
                    // neither.
                    agent_registry: true,
                    // Same reasoning, one notch narrower: deciding which tools
                    // an approved agent may reach is operational administration.
                    agent_tool_exposure: true,
                    // Same reasoning one axis further: editing a card is
                    // operational administration of an already-approved agent,
                    // not the authority to admit new ones.
                    agent_policy_card: true,
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
                continuity: { edit: true },
                processes: { edit: true },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false },
                reports: { view: true, export: true, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: false, compliance_dsar_manage: false, agent_registry: false, agent_tool_exposure: false, agent_policy_card: false },
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
                continuity: { edit: false },
                processes: { edit: false },
                frameworks: { view: true, install: false },
                // Auditors can view and maybe export/share depending on policy, but let's keep view/share
                audits: { view: true, manage: false, freeze: false, share: true },
                reports: { view: true, export: true, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: true, compliance_dsar_manage: false, agent_registry: false, agent_tool_exposure: false, agent_policy_card: false },
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
                continuity: { edit: false },
                processes: { edit: false },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false },
                reports: { view: true, export: false, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: false, compliance_dsar_manage: false, agent_registry: false, agent_tool_exposure: false, agent_policy_card: false },
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
