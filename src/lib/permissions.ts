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
    /**
     * People layer (PR-4): the employee roster, devices, training assignments
     * and background checks. `manage` = edit the roster and its records.
     *
     * BOTH keys are OWNER/ADMIN only (owner decision, 2026-10-29). `view` was
     * granted to every role until then, so any member could read the whole
     * roster through `GET /personnel`, `/devices`, `/training` and
     * `/background-checks` although the pages that show it sit under the
     * admin console. EDITOR, AUDITOR, READER and AI_ADMIN hold neither. A
     * custom role may still grant `view`; a stored blob that carries the key
     * keeps what it says, and one that predates the domain takes its base
     * role's default, which is now `false` for every base but ADMIN.
     */
    personnel: { view: boolean; manage: boolean };
    /**
     * Access reviews (Epic G-4 + legacy recertification Step 5a).
     *
     * ─── THE GRANTS REPRODUCE THE PRE-KEY OUTCOMES EXACTLY ─────────────
     *
     * Before these keys existed the four verbs were gated by the coarse
     * `ctx.permissions` booleans from `computePermissions`, so the caller
     * set each key must reproduce is already fixed:
     *
     *   view    `assertCanRead`  — `canRead` is level >= 1, i.e. ALL five
     *                              roles. Granted to all five.
     *   create  `assertCanAdmin` — `canAdmin` is level >= 4, i.e. OWNER and
     *                              ADMIN. Granted to those two.
     *   close   `assertCanAdmin` — same two.
     *   decide  `assertCanRead` PLUS a reviewer rule inside the usecase.
     *
     * `decide` is therefore granted to ALL FIVE ROLES, which looks too wide
     * read on its own and is the only grant that reproduces today. The
     * narrowing is not a role question: `submitDecision`,
     * `revokeDecision` and `submitConnectedDecision` each refuse unless the
     * caller is the campaign's ASSIGNED REVIEWER or holds `canAdmin`, and a
     * reviewer is assigned per campaign, so any role can legitimately be one.
     * Granting `decide` to OWNER/ADMIN only would silently strip the verb
     * from an EDITOR, AUDITOR or READER who IS the assigned reviewer — a
     * live authorisation regression wearing the shape of a tightening.
     *
     * So the reviewer rule STAYS IN THE USECASE and these keys sit in front
     * of it. The key answers "may this role ever decide"; the usecase
     * answers "is this the person we asked".
     */
    access_reviews: { view: boolean; create: boolean; decide: boolean; close: boolean };
    /**
     * Reconciling legacy accounts to people (Step 4b).
     *
     * `confirm` is deliberately narrower than `access_reviews.decide`, which
     * EDITOR, AUDITOR and READER all hold. Deciding an access review is the
     * assigned reviewer's job and its effect is bounded by that review.
     * Confirming an alias writes a DURABLE row: from then on the account
     * resolves as LINKED on every future run, and a LINKED is acted on by later
     * steps without anybody looking. A wrong confirmation therefore keeps
     * somebody's access across every subsequent cycle, silently, which is the
     * failure recertification exists to catch rather than cause.
     *
     * So it follows `close` (OWNER/ADMIN) rather than `decide`. Owner ruling,
     * 2026-10-09.
     */
    identity_reconciliation: { view: boolean; confirm: boolean };
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
    audits: {
        view: boolean;
        manage: boolean;
        freeze: boolean;
        share: boolean;
        /**
         * READING THE AUDITOR AGENT'S WORKPAPERS (#3749), and nothing else.
         *
         * Reading workpapers takes `audits.manage` (step 0e): a workpaper lists
         * exceptions about named people's access. This key is the read half of
         * that, for a bearer token: the auditor agent's key reads a period's
         * workpapers (`list_audit_workpapers`) through it and can manage,
         * freeze and share nothing. The workpaper reads admit either key, so
         * nobody who could read workpapers before it lost the read.
         *
         * Held by OWNER and ADMIN, the roles that hold `audits.manage`. A custom
         * role may express it; a stored custom role saved before it existed
         * takes it from its own `audits.manage` (`DERIVED_FROM`), never from its
         * base role, so a role that switched `manage` off does not gain the read.
         *
         * Carried by a bearer token only through its own NAMED scope,
         * `audits:workpaper_view`. Neither `*` nor `audits:*` carries it
         * (`WILDCARD_EXCLUDED_ACTIONS` in `src/lib/auth/api-key-auth.ts`), so
         * every key already issued resolves to what it did before.
         */
        workpaper_view: boolean;
    };
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
         * Split view/manage since #3710, the way the DSAR pair is: READING the
         * agent inventory is `agent_registry_view`, below. This key keeps every
         * write — register, amend, activate, suspend, retire, scanner keys,
         * peers, the registration intake, the service-principal link confirm —
         * and the reads that are not the inventory (the governance surfaces each
         * detail tab reads, receipts, quarantine, review quality). A read moved
         * to the view key admits a holder of THIS key too, so nobody who could
         * read the inventory before the split lost it.
         */
        agent_registry: boolean;
        /**
         * READING THE AGENT INVENTORY (#3710): the register list and one
         * agent's register row, the harness scans and the harness matrix, one
         * discovered agent's facts (`get_discovered_agent`), the governance pack
         * — and agent runs and agent proposals, which `admin.view` alone used to
         * gate.
         *
         * Read-only, and that is the whole of its definition: no usecase writes
         * under it, and `tests/unit/agent-registry-view-key.test.ts` enumerates
         * every `admin.agent_registry` write path and refuses a holder of this
         * key alone. Approving a proposal in particular still needs write on the
         * domain the proposal changes (`approveAgentProposal`'s `assertCanWrite`).
         *
         * Held by OWNER, ADMIN, AI_ADMIN and AUDITOR — the last because the
         * inventory is what an audit asks for, the case `agent_registry`'s own
         * docstring named and left undone. A custom role may express it.
         *
         * Carried by a bearer token only through its own NAMED scope,
         * `admin:agent_registry_view`. Neither `*` nor `admin:*` carries it (see
         * `scopesToPermissions`): every key already issued resolves to exactly
         * what it did before this key existed, and a model reads the inventory
         * — `DiscoveredAgent.ownerRef` among it — only through a key somebody
         * minted for that purpose, held by an agent granted the tool.
         */
        agent_registry_view: boolean;
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
        /**
         * THE KILL SWITCH: stop one agent, or every agent in the tenant, at the
         * tool boundary — including runs already in flight.
         *
         * ## Why it is not `admin.agent_registry`
         *
         * `agent_registry` already carries "suspend", and on a first read that
         * looks like the same authority. It is not, in the direction that
         * matters: `agent_registry` BUNDLES suspend with activate, so a tenant
         * cannot delegate the authority to STOP without also delegating the
         * authority to ADMIT an agent nobody has scored. Those two have opposite
         * risk profiles — a wrong stop is bounded, reversible and audited; a
         * wrong start is the thing every other key in this block exists to
         * prevent — and a permission model that cannot separate them forces the
         * dangerous half onto whoever needs the safe one.
         *
         * The separation is the point of the key, and it is the widening this
         * subsystem expects a tenant to make: an on-call rota that holds
         * `agent_kill_switch` through a custom role and holds none of the other
         * three is a sensible configuration, and it is unspellable without this
         * flag.
         *
         * Granted to OWNER and ADMIN by default, like its three neighbours. The
         * default is not the argument; the grantability is.
         *
         * ## What no tenant key can express
         *
         * The PLATFORM-wide kill has no tenant to scope a permission to, and
         * `requirePermission` resolves a tenant role. It is gated by
         * `PLATFORM_ADMIN_API_KEY` through `verifyPlatformApiKey` instead — the
         * same credential that creates tenants and transfers their ownership. A
         * tenant administrator can neither pull it nor lift it, which is correct:
         * stopping every deployment is not an authority a customer holds.
         */
        agent_kill_switch: boolean;
        /**
         * CALLING a tool that lives on an external MCP server.
         *
         * A FIFTH agent key, and the only one of the five that is not about
         * configuring an agent. `agent_registry` admits an agent,
         * `agent_tool_exposure` decides what it may reach, `agent_policy_card`
         * sets how far it may go and `agent_kill_switch` stops it. Each governs
         * a human changing a record. This one governs the AGENT ACTING, and
         * acting outside the platform boundary specifically.
         *
         * ## Why it is not folded into `agent_tool_exposure`
         *
         * That key answers "who may grant this tool", which is already asked
         * and already enforced — a grant requires a pin, and the pin requires a
         * human to have read the definition. The question left over is a
         * different one asked at a different time by a different principal:
         * whether the CREDENTIAL presenting itself at call time may leave the
         * tenant at all. Folding them would mean the authority to configure an
         * agent's tool list is the same authority the agent then exercises,
         * which is the composition every one of its neighbours exists to
         * refuse.
         *
         * ## Why not `admin.manage`, which owns the connection
         *
         * `admin.manage` gates `/admin/integrations` — CONFIGURING outbound
         * integrations, noted there as "mis-configuration leaks data outside
         * the tenant". Requiring it here would mean a credential that reads
         * alerts from one Grafana server also holds CRUD over every integration
         * the tenant has. The narrower key is the point: an operator can let an
         * agent call out without handing it the keys to rewire what it calls.
         *
         * Granted to OWNER and ADMIN by default, like its four neighbours. The
         * default is deliberately NOT where this feature's caution lives: a
         * call still needs a pinned definition a human accepted, a grant on the
         * agent, and an agent registered as reaching `EXTERNAL_EGRESS`. Making
         * this key alone default-off would add a fourth lock to a door with
         * three, while making the other three easy to mistake for the whole
         * protection.
         */
        agent_external_tools: boolean;
        /**
         * SUBMITTING a harness scan (#3665): a scanner in the client's
         * environment posting its signed report.
         *
         * A SIXTH agent key because it is held by a different principal from
         * the other five. They are held by the people who govern agents; this
         * is held by the scanner, through its API key, and nothing else that
         * key carries should let it do more. Folding it into `agent_registry`
         * would hand every scanner the switch that admits new agents.
         *
         * The key is necessary, not sufficient. A report is ingested only when
         * it is signed by a public key the tenant registered for that scanner,
         * which takes `agent_registry` — so the authority to report and the
         * authority to decide whose reports count stay apart.
         *
         * Granted to OWNER and ADMIN by default so a person can upload a report
         * by hand; the scanner's API key carries it through the
         * `admin:harness_ingest` scope.
         */
        agent_harness_ingest: boolean;
        /**
         * OWNING AN AGENT BY TRANSFER (#3699): propose, read, cancel and
         * complete a two-step agent ownership transfer
         * (`…/admin/agents/[agentId]/ownership-transfer` and `…/complete`).
         * The person completing step two must hold it too, so it is also the
         * key that decides who can RECEIVE an agent.
         *
         * Until #3699 both steps took `admin.tenant_lifecycle`, whose docstring
         * lists "transfer ownership" — so an agent could pass only to an
         * OWNER, and the built-in `AI_ADMIN` role, which runs the agent
         * register without any tenant-wide admin key, could never hold the
         * accountability for one. This key separates the two: accountability
         * for an agent from authority over the tenant's existence.
         *
         * OWNER and AI_ADMIN hold it. ADMIN does NOT, deliberately (owner
         * default, 2026-10-18): ADMIN holds `agent_registry`, and an agent's
         * accountable owner must not be movable by the role that owner is
         * accountable to — the reason 0e put the transfer on tenant lifecycle
         * in the first place. An OWNER can still give an ADMIN a custom role
         * carrying it (`permissionsExceeding` lets a holder grant what they
         * hold).
         *
         * Never carried by a bearer token: `scopesToPermissions` builds `*`
         * from ADMIN's set, and no scope maps to it, so a transfer is a human
         * act at both ends.
         */
        agent_ownership: boolean;
        /**
         * APPROVING A TENANT SKILL (#3680, step 4c; narrowed by #3778): approve
         * or reject a version in review, and retire one, at
         * `…/admin/agents/skills/tenant/**` (`approve`, `reject`, `retire`).
         *
         * Authoring is its own key since #3778, `agent_skill_author`, below, by
         * the owner's decision: a provider that writes a tenant's skills must
         * be expressible as a holder of authoring who cannot approve. The
         * four-eyes rule is still a PERSON as well: the usecase refuses an
         * approval by the version's author, and a CHECK makes one
         * unrepresentable, whoever holds both keys. Reading a tenant skill
         * takes either key.
         *
         * OWNER, ADMIN and AI_ADMIN hold it. OWNER and ADMIN by step 0e's signed
         * permission table (`docs/agentic-iam-roadmap.md`), which names both:
         * deciding what an agent may be taught is operational administration of
         * agents, like the register and the card, and a tenant needs two holders
         * for the four-eyes rule to be satisfiable at all — refusing ADMIN would
         * make a one-OWNER tenant unable to approve anything. AI_ADMIN because it
         * is an agent key (`AGENT_ADMIN_KEYS`), and that role holds every one.
         *
         * Never carried by a bearer token: `*` subtracts it and no scope maps to
         * it. A skill is text mounted into an agent's context, and a key held by
         * an agent that could approve skill text could teach itself.
         */
        agent_skill_review: boolean;
        /**
         * AUTHORING A TENANT SKILL (#3778): create a skill, create a version
         * (an edit), attach its evaluation record and submit it for review, at
         * `…/admin/agents/skills/tenant/**`. Approval, rejection and retirement
         * are `agent_skill_review`'s.
         *
         * OWNER, ADMIN and AI_ADMIN hold both halves, so nobody who could act
         * before the split lost an act. A custom role may carry this half alone,
         * which is how a provider who writes the tenant's skills is kept from
         * approving them (`docs/agentic-iam-managed-service.md`). A custom role
         * stored before this key existed takes it from its own
         * `agent_skill_review` (`DERIVED_FROM`), never from its base role.
         *
         * Never carried by a bearer token, for the reason the review key is
         * not: an agent that could write skill text could teach itself.
         */
        agent_skill_author: boolean;
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
    access_reviews: ['view', 'create', 'decide', 'close'],
    identity_reconciliation: ['view', 'confirm'],
    continuity: ['edit'],
    processes: ['edit'],
    frameworks: ['view', 'install'],
    audits: ['view', 'manage', 'freeze', 'share', 'workpaper_view'],
    reports: ['view', 'export', 'schedule_external'],
    admin: [
        'view', 'manage', 'members', 'sso', 'scim',
        'tenant_lifecycle', 'owner_management',
        'compliance_dsar_view', 'compliance_dsar_manage',
        'agent_registry', 'agent_registry_view', 'agent_tool_exposure', 'agent_policy_card',
        'agent_kill_switch', 'agent_external_tools', 'agent_harness_ingest',
        'agent_ownership', 'agent_skill_review', 'agent_skill_author',
    ],
};

/**
 * The `admin` keys that are about AGENTS — the ones the built-in `AI_ADMIN`
 * role holds (#3699). Every other `admin` key is tenant-wide (members, SSO,
 * SCIM, billing and security settings behind `manage`, the tenant's lifecycle,
 * its owners, the DSAR register, the admin console's `view`) and `AI_ADMIN`
 * holds none of them.
 *
 * `agent_skill_review` (step 4c, #3680) is classified here: what an agent may
 * be taught is about agents, not the tenant. The Skills tab's READ of the
 * corpus stays under `agent_registry`. `tests/unit/ai-admin-permissions.test.ts`
 * enumerates `PERMISSION_SCHEMA` and fails on a key nobody classified.
 */
export const AGENT_ADMIN_KEYS = [
    'agent_registry',
    'agent_registry_view',
    'agent_tool_exposure',
    'agent_policy_card',
    'agent_kill_switch',
    'agent_external_tools',
    'agent_harness_ingest',
    'agent_ownership',
    'agent_skill_review',
    'agent_skill_author',
] as const satisfies readonly (keyof PermissionSet['admin'])[];

// The two agent read predicates (#3710) live in `agent-inventory-read.ts` so a
// client component can hold them without pulling in this module; re-exported
// here so every server caller imports them from one place.
export { mayReadAgentInventory, mayReadAgentActivity } from '@/lib/agent-inventory-read';

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
            // OWNER = ADMIN + tenant_lifecycle + owner_management +
            // agent_ownership. Only role that can delete the tenant, rotate
            // DEK, transfer ownership, invite/remove other OWNERs, or assign
            // OWNER role; and, with AI_ADMIN, the only built-in role that can
            // own an agent by transfer (#3699).
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
                access_reviews: { view: true, create: true, decide: true, close: true },
                identity_reconciliation: { view: true, confirm: true },
                continuity: { edit: true },
                processes: { edit: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true, workpaper_view: true },
                reports: { view: true, export: true, schedule_external: true },
                admin: {
                    view: true, manage: true, members: true, sso: true, scim: true,
                    tenant_lifecycle: true, owner_management: true,
                    compliance_dsar_view: true, compliance_dsar_manage: true,
                    agent_registry: true, agent_registry_view: true, agent_tool_exposure: true,
                    agent_policy_card: true,
                    agent_kill_switch: true, agent_external_tools: true,
                    agent_harness_ingest: true,
                    agent_ownership: true,
                    agent_skill_review: true,
                    agent_skill_author: true,
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
                access_reviews: { view: true, create: true, decide: true, close: true },
                identity_reconciliation: { view: true, confirm: true },
                continuity: { edit: true },
                processes: { edit: true },
                frameworks: { view: true, install: true },
                audits: { view: true, manage: true, freeze: true, share: true, workpaper_view: true },
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
                    // Reading the inventory (#3710): the register key's holders
                    // always could, and the view key is that read on its own.
                    agent_registry_view: true,
                    // Same reasoning, one notch narrower: deciding which tools
                    // an approved agent may reach is operational administration.
                    agent_tool_exposure: true,
                    // Same reasoning one axis further: editing a card is
                    // operational administration of an already-approved agent,
                    // not the authority to admit new ones.
                    agent_policy_card: true,
                    agent_kill_switch: true, agent_external_tools: true,
                    agent_harness_ingest: true,
                    // Explicit false (#3699, owner default): ADMIN holds the
                    // register key, and an agent's accountable owner must not
                    // be movable by the role that owner is accountable to. An
                    // OWNER can grant it through a custom role.
                    agent_ownership: false,
                    // ADMIN holds it (#3680), by step 0e's permission table:
                    // what an agent is taught is operational administration of
                    // agents. The four-eyes rule is the author/approver split,
                    // which the usecase and a CHECK hold whoever holds the key.
                    agent_skill_review: true,
                    agent_skill_author: true,
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
                // OWNER/ADMIN only — see the `personnel` docblock above.
                personnel: { view: false, manage: false },
                access_reviews: { view: true, create: false, decide: true, close: false },
                identity_reconciliation: { view: true, confirm: false },
                continuity: { edit: true },
                processes: { edit: true },
                frameworks: { view: true, install: false },
                audits: { view: true, manage: false, freeze: false, share: false, workpaper_view: false },
                reports: { view: true, export: true, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: false, compliance_dsar_manage: false, agent_registry: false, agent_registry_view: false, agent_tool_exposure: false, agent_policy_card: false, agent_kill_switch: false, agent_external_tools: false, agent_harness_ingest: false, agent_ownership: false, agent_skill_review: false, agent_skill_author: false },
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
                // OWNER/ADMIN only — see the `personnel` docblock above.
                personnel: { view: false, manage: false },
                access_reviews: { view: true, create: false, decide: true, close: false },
                identity_reconciliation: { view: true, confirm: false },
                continuity: { edit: false },
                processes: { edit: false },
                frameworks: { view: true, install: false },
                // Auditors can view and maybe export/share depending on policy, but let's keep view/share
                audits: { view: true, manage: false, freeze: false, share: true, workpaper_view: false },
                reports: { view: true, export: true, schedule_external: false },
                admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: true, compliance_dsar_manage: false, agent_registry: false, agent_registry_view: true, agent_tool_exposure: false, agent_policy_card: false, agent_kill_switch: false, agent_external_tools: false, agent_harness_ingest: false, agent_ownership: false, agent_skill_review: false, agent_skill_author: false },
            };
        case 'READER':
            return readerPermissions();
        case 'AI_ADMIN': {
            // #3699 — runs the agent register and can own and receive agents,
            // and is a READER everywhere else. READER's set exactly, with the
            // agent keys (`AGENT_ADMIN_KEYS`) switched on and nothing else:
            // no members, SSO, SCIM, billing or security settings
            // (`admin.manage`), no tenant lifecycle, no owner management, no
            // DSAR register and no admin console (`admin.view`). Reads, because
            // an administrator of agents has to see what the agents touch —
            // except the people layer, which it inherits from READER as
            // `personnel.view: false` (OWNER/ADMIN only, 2026-10-29).
            //
            // The coarse tier matches: `ROLE_ORDER.AI_ADMIN` is READER's level,
            // so `canWrite` / `canAdmin` are false and no usecase that gates on
            // the coarse tier alone admits this role. The agent usecases' own
            // floor admits a holder of the agent key the route requires
            // (`assertAgentGovernanceFloor`).
            const reader = readerPermissions();
            return {
                ...reader,
                admin: {
                    ...reader.admin,
                    agent_registry: true,
                    agent_registry_view: true,
                    agent_tool_exposure: true,
                    agent_policy_card: true,
                    agent_kill_switch: true,
                    agent_external_tools: true,
                    agent_harness_ingest: true,
                    agent_ownership: true,
                    agent_skill_review: true,
                    agent_skill_author: true,
                },
            };
        }
        default: {
            // Exhaustive: a seventh `Role` is a type error here rather than a
            // silent READER. At runtime an unrecognised value (a stale claim,
            // a hand-written row) still fails CLOSED to READER.
            const unhandled: never = role;
            void unhandled;
            return readerPermissions();
        }
    }
}

/**
 * READER's set — every domain readable except the people layer
 * (`personnel.view` is OWNER/ADMIN only), nothing writable, no admin key.
 */
function readerPermissions(): PermissionSet {
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
        // OWNER/ADMIN only — see the `personnel` docblock on `PermissionSet`.
        personnel: { view: false, manage: false },
        access_reviews: { view: true, create: false, decide: true, close: false },
        identity_reconciliation: { view: true, confirm: false },
        continuity: { edit: false },
        processes: { edit: false },
        frameworks: { view: true, install: false },
        audits: { view: true, manage: false, freeze: false, share: false, workpaper_view: false },
        reports: { view: true, export: false, schedule_external: false },
        admin: { view: false, manage: false, members: false, sso: false, scim: false, tenant_lifecycle: false, owner_management: false, compliance_dsar_view: false, compliance_dsar_manage: false, agent_registry: false, agent_registry_view: false, agent_tool_exposure: false, agent_policy_card: false, agent_kill_switch: false, agent_external_tools: false, agent_harness_ingest: false, agent_ownership: false, agent_skill_review: false, agent_skill_author: false },
    };
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
 * Keys a stored custom-role blob that predates them takes from ANOTHER key of
 * the same blob rather than from its base role (#3749).
 *
 * A key that splits a read off an existing key would otherwise widen any custom
 * role that had switched the existing key off: the base role's default is
 * `true` wherever the base holds the existing key. `audits.workpaper_view` is
 * the read half of `audits.manage`, so a blob saved before it existed reads
 * workpapers exactly when it could before: when it held `audits.manage`.
 */
const DERIVED_FROM: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    audits: { workpaper_view: 'manage' },
    // #3778: a role that could author through the review key before the split
    // keeps authoring, and one that could not does not gain it.
    admin: { agent_skill_author: 'agent_skill_review' },
};

/**
 * Safely parses a permissionsJson blob from the database into a typed PermissionSet.
 * Falls back to the baseRole's defaults for any missing or invalid fields.
 *
 * Used at read-time to ensure the runtime always has a complete, valid PermissionSet
 * even if the stored JSON is partially malformed (defensive programming). A key
 * named in `DERIVED_FROM` falls back to its source key in the blob first.
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
                    continue;
                }
                const source = DERIVED_FROM[domain]?.[action];
                if (source !== undefined && typeof obj[domain][source] === 'boolean') {
                    domainResult[action] = obj[domain][source] as boolean;
                }
            }

            (result as Record<keyof PermissionSet, Record<string, boolean>>)[domain] = domainResult;
        }
    }

    return result;
}

/**
 * The permission set a MEMBERSHIP resolves to — the custom role's, parsed over
 * its base role, when it has one; the built-in role's otherwise.
 *
 * The same expression `getTenantCtx` (via `src/lib/tenant-context.ts`) builds
 * `appPermissions` from, for a principal who is not the caller. It exists for a
 * usecase that must predict what ANOTHER member will be allowed to do — the
 * agent ownership transfer (#3698) refuses at step one a recipient who could
 * never pass step two's `requirePermission`. A job acting for the member who
 * started it reads it too (`initiatorAuthority`, #4362). The request-context
 * resolvers keep their own inline copies; this one must stay in step with them.
 */
export function permissionsForMembership(membership: {
    role: Role;
    customRole: { permissionsJson: unknown; baseRole: Role } | null;
}): PermissionSet {
    return membership.customRole
        ? parsePermissionsJson(membership.customRole.permissionsJson, membership.customRole.baseRole)
        : getPermissionsForRole(membership.role);
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
