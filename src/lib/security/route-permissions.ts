/**
 * Route → permission map for the API surface (Epic C.1).
 *
 * The map is the single declarative source of truth for "which
 * `PermissionKey` does this URL require?" — it lets us:
 *
 *   1. Roll the `requirePermission(...)` middleware across handlers
 *      without duplicating the policy in twelve different files.
 *   2. Guard against a new sensitive route shipping unprotected: the
 *      coverage test in `tests/guardrails/api-permission-coverage.test.ts`
 *      walks `src/app/api/**\/route.ts` and verifies every in-scope
 *      route has a matching rule AND uses `requirePermission(...)` in
 *      its handler.
 *   3. Surface the policy in code review: a PR that touches an admin
 *      route is forced to update this map, which a reviewer can read
 *      in isolation without context-switching across handler files.
 *
 * Adding or moving an admin/privileged route:
 *   - Add a rule below covering the path + methods.
 *   - Wire `requirePermission(<key>, …)` into the route handler.
 *   - Run `npm test -- tests/guardrails/api-permission-coverage.test.ts`
 *     to verify the rollout is complete.
 *
 * This file is intentionally narrow in scope. It only enumerates
 * privileged routes (admin, key rotation, member management, etc.).
 * Read-mostly tenant routes (controls, evidence, risks, reports,
 * etc.) continue to authorise via the existing usecase-layer policy
 * helpers (`assertCanRead/Write/Admin/Audit`) — Epic C.2 will widen
 * the route-map to those once the granular policy keys settle.
 */

import type { PermissionKey, PermissionMode } from './permission-middleware';
import { AGENT_ADMIN_API_STATIC_SEGMENTS } from '@/lib/auth/guard';

// ─── Rule shape ─────────────────────────────────────────────────────

/**
 * Closed set of HTTP methods a rule may gate. Template-literal union
 * enforces at compile time that every rule uses the canonical
 * uppercase form — the hot path at line ~210 does a direct
 * `includes` with no per-call normalisation.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RoutePermissionRule {
    /**
     * Regex matched against `req.nextUrl.pathname`. Use `\/[^/]+\/` for
     * a single dynamic segment (so trailing slashes / query strings
     * don't accidentally match).
     */
    path: RegExp;
    /**
     * HTTP methods this rule covers. Omit to apply to every method.
     * MUST be uppercase — the compile-time `HttpMethod` union enforces.
     */
    methods?: readonly HttpMethod[];
    /**
     * Permission key(s) required to call the route.
     */
    permission: PermissionKey | readonly PermissionKey[];
    /**
     * All-of vs any-of when multiple keys. Defaults to `'all'`.
     */
    mode?: PermissionMode;
    /**
     * Short human-readable rationale. Required so a reviewer can sanity-
     * check the policy at a glance — `'admin.scim'` on the SCIM route is
     * obvious; rules that combine keys or carve exceptions are not.
     */
    note: string;
}

// ─── Tenant route prefix ────────────────────────────────────────────

/**
 * Shared prefix for every tenant-scoped API path. Centralised so a
 * future rename (`/api/t/` → `/api/tenants/`) updates one place.
 */
const T = String.raw`\/api\/t\/[^/]+`;

// ─── The map ────────────────────────────────────────────────────────

export const ROUTE_PERMISSIONS: readonly RoutePermissionRule[] = [
    // ── DSAR register (manual-fulfilment queue) ─────────────────────
    // Split view/manage: AUDITOR holds _view because reading the
    // rights-request log IS the auditor's job, but must never advance a
    // request. Two rules rather than one so the GET stays readable to a
    // role that cannot mutate.
    {
        // Tenant-wide calendar consent. `admin.manage`, not a calendar key:
        // Microsoft's tenant-wide grant admits EVERY user in the tenant to a
        // third-party calendar API, which is an admin authority rather than a
        // calendar one. A weaker key here would be an UNLOGGED gate — the
        // request would pass the middleware and be refused deeper, where
        // nothing writes AUTHZ_DENIED.
        // Legacy access recertification (Step 2a). Both `admin.manage`.
        //
        // GET is admin rather than reader on purpose: the response enumerates a
        // customer's legacy SCHEMA. What a reviewer legitimately needs — why one
        // account was suggested to one person — is the convention and the signal
        // list, not the whole column map.
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/profile$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Profiles a legacy connection\'s columns for the mapping screen. POST '
            + 'because it dials a customer-hosted server; the response enumerates '
            + 'their schema, so it is not a reader\'s.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/pull$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Starts a legacy access pull. Enqueues only — the job dials a '
            + 'customer-hosted MCP server and writes a snapshot.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/reconcile$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Starts a reconciliation run over one snapshot. Enqueues only. A run '
            + 'decides which legacy accounts are claimed to belong to which people, '
            + 'and a LINKED is acted on by later steps without anybody re-reading '
            + 'the evidence, so it is not a writer\'s either.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/snapshot$`),
        methods: ['GET'],
        permission: 'admin.manage',
        note:
            'Reads a connection\'s latest legacy snapshot (status, counts, coverage, '
            + 'whether it is matched) and its id, which the reconcile POST needs. The '
            + 'same key as the pull and reconcile it drives; the counts describe a '
            + 'customer legacy access table.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/mapping$`),
        methods: ['GET', 'PUT'],
        permission: 'admin.manage',
        note:
            'Reads and sets the column mapping. PUT decides which legacy column '
            + 'means email and which means employeeNumber, both STRONG signals; '
            + 'GET enumerates a customer legacy schema, so neither is a reader.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/calendar\\/consent$`),
        permission: 'admin.manage',
        note: 'Grant, read or withdraw tenant-wide calendar consent (audited).',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/dsar-requests(\\/.*)?$`),
        methods: ['GET'],
        permission: 'admin.compliance_dsar_view',
        note:
            'Reading the GDPR Art.15/17 rights-request register — includes ' +
            'the identity of data subjects who exercised a right.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/dsar-requests(\\/.*)?$`),
        methods: ['POST', 'PATCH'],
        permission: 'admin.compliance_dsar_manage',
        note:
            'Recording and advancing rights requests — a staff action with ' +
            'legal consequence, so AUDITOR observes but never transitions.',
    },
    // ── Member management ───────────────────────────────────────────
    // A member's line of defence (#3675). ABOVE the members catch-all, which
    // matches first-wins and would record `admin.members` — a key ADMIN holds —
    // for a route whose handler requires `admin.owner_management`.
    {
        path: new RegExp(`^${T}\\/admin\\/members\\/[^/]+\\/line-of-defence$`),
        methods: ['PUT'],
        permission: 'admin.owner_management',
        note:
            "Declare a member's line of defence (FIRST, SECOND, THIRD or not " +
            'declared). OWNER-only: it decides who may own the auditor agent ' +
            'and who may review its workpapers. The usecase also requires the ' +
            "caller's built-in role to be OWNER and refuses their own membership.",
    },
    {
        path: new RegExp(`^${T}\\/admin\\/members(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Listing members, inviting, editing role, deactivating — ' +
            'changes who can access the tenant and at what level.',
    },

    // ── Session management (Epic C.3) ────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/sessions(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Listing + revoking active user sessions for the tenant. ' +
            'Treated as a member-management action since it controls ' +
            'who currently has live access.',
    },

    // ── SCIM token management ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/scim$`),
        permission: 'admin.scim',
        note:
            'Generating, listing and revoking SCIM bearer tokens — ' +
            'controls automated provisioning from the IdP.',
    },

    // ── Custom RBAC roles ───────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/roles(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Creating / editing / deleting custom roles. Falls under ' +
            "admin.manage — there's no separate `admin.roles` key.",
    },

    // ── Tenant-wide settings ────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/settings(\\/.*)?$`),
        permission: 'admin.manage',
        note: 'Tenant settings (display name, branding, defaults).',
    },

    // ── Outbound integrations ───────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/integrations(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'CRUD on outbound integrations (Slack, webhooks, ticketing). ' +
            'Mis-configuration leaks data outside the tenant.',
    },

    // ── Risk matrix configuration (Epic 44) ──────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/risk-matrix-config(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Tenant-scoped likelihood × impact matrix shape, axis ' +
            'labels, severity bands, and per-level vocabulary. ' +
            'Read-only sibling at /risk-matrix-config (risks.view).',
    },

    // ── M2M API keys ────────────────────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/api-keys(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'API key issuance + revocation — every key is a long-lived ' +
            'credential against the tenant; treat as admin-only.',
    },

    // ── Agent register (Epic Agentic) ───────────────────────────────
    //
    // THE UI MOVED AND THESE RULES DID NOT (AGENTIC UI 1/4, #2429). The agent
    // register's PAGE is at `/t/:slug/agents` since that prompt; every API
    // route it drives is still at `/api/t/:slug/admin/agents/*`, which is what
    // these patterns match. This map is the API surface only — `T` is
    // `\/api\/t\/[^/]+` — so a UI route needs no rule here and adding one
    // would match nothing.
    //
    // BE PRECISE ABOUT WHAT THIS MAP IS, because this comment used to say
    // `resolveRoutePermission` "is called from the middleware against
    // `req.nextUrl.pathname` for API requests" and that was never true:
    // `src/middleware.ts` does not mention it, and across `src/` the only
    // occurrence is the definition itself — every other caller is under
    // `tests/`. This map is a DECLARATIVE POLICY RECORD that
    // `tests/guardrails/api-permission-coverage.test.ts` checks each
    // privileged route against. The LIVE gate is the literal
    // `requirePermission(...)` wrapper in the route file; that is what denies
    // the request and writes the hash-chained `AUTHZ_DENIED` row. Reading
    // this map as a second enforcement layer overstates the defence in depth
    // by one layer. Page-level
    // gating is each page's own `ctx.appPermissions` check, asserted by
    // `tests/integration/agents-{page,subpage}-authz.test.ts`.
    //
    // MOVING THE API WITH THE PAGE WOULD HAVE BEEN THE BREAKING CHANGE: these
    // three narrow rules and the catch-all would stop matching, every route
    // docstring citing its own path would be wrong, and the
    // `PRIVILEGED_ROOTS` population `api-permission-coverage.test.ts` curates
    // would shift under it. The UI path and the API path are allowed to differ.
    //
    // ORDER MATTERS: matching is first-wins, so every narrower rule here has to
    // precede the register's own catch-all below. Reversed, every grant, every
    // card edit and every kill would resolve to `admin.agent_registry`: the
    // narrow keys would be present in the type and enforced nowhere, and
    // whoever holds the register key would silently gain all of those surfaces
    // — which is the exact consolidation the split exists to prevent. It fails
    // SILENTLY, because a route gated by the wrong-but-still-privileged key
    // still returns 403 to everyone it should. So the narrow rules are kept
    // together above the catch-all rather than sorted in with it, and
    // `tests/integration/policy-card-authz.test.ts` asserts both paths resolve
    // to their own key rather than only asserting the narrow one.
    //
    // THERE ARE FOUR OF THEM, AND THIS PARAGRAPH USED TO SAY TWO. It counted
    // a pair while the block below held policy-card, tools, kill-switch and
    // mcp/quarantine — prose that was correct when written and has been wrong
    // since the third rule landed. Fixed by removing the count rather than
    // updating it: the claim is now about "the narrow rules", which stays true
    // as the set grows, and a number in a comment has nothing keeping it
    // honest. The old wording is deliberately not quoted here — a comment
    // that repeats a phrase a guard might match is a survivor that can satisfy
    // an assertion after the real code is deleted.
    // #3484 — the per-tenant cap on CONCURRENT agentic runs. Above the
    // register's catch-all like every other narrow rule here, and it resolves
    // to `admin.agent_registry` deliberately rather than to
    // `admin.agent_kill_switch`: a cap bounds how much NEW work may start and
    // stops nothing already running, where a kill switch is an emergency that
    // also stops tool calls inside runs already going, carries a reason and is
    // lifted by name. Sharing the kill key would mean a tenant could not
    // delegate capacity planning without delegating the emergency stop.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/concurrency$`),
        permission: 'admin.agent_registry',
        note:
            'Read or set how many agentic runs this tenant may execute at ' +
            'once. The second axis beside the monthly token budget, which ' +
            'bounds spend over a month and cannot express simultaneity.',
    },
    // #3777 — the monthly token budget, the concurrency cap's sibling, under
    // the same key for the same reason (capacity, not the emergency stop), by
    // the owner's decision to set the two axes in one place.
    // ── A2A host consumers (#3861) ──────────────────────────────────
    //
    // `admin.agent_registry` because a host consumer is "whom may call us",
    // which is register-shaped rather than call-shaped (ADR 0003, owner
    // decision). The KILL sits under `admin.agent_kill_switch` instead, and
    // its rule must come FIRST — this map is first-wins, and the broader
    // host-consumers pattern below would otherwise swallow it.
    {
        path: new RegExp(`^${T}\\/admin\\/a2a\\/host-consumers\\/[^/]+\\/kill$`),
        permission: 'admin.agent_kill_switch',
        note:
            'Stop or restore ONE host consumer — the host that calls us as a ' +
            'client. Not the register key, for the reason the agent kill ' +
            'carries: `agent_registry` bundles admit with suspend, so sharing ' +
            'it would mean a tenant cannot delegate the authority to STOP an ' +
            'integration without also delegating the authority to ADMIT one. ' +
            'It is also the term that makes a stateless access token ' +
            'acceptable (threat-model R26): there is no revoking one token, so ' +
            'stopping the consumer is what stands in for it.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/a2a\\/host-consumers(\\/[^/]+)?$`),
        permission: 'admin.agent_registry',
        note:
            'Create, list, rotate the secret of and revoke a HOST CONSUMER ' +
            '(#3861) — the principal SAP Joule arrives as, which calls us as ' +
            'a client with an OAuth2 bearer rather than as a peer with a ' +
            'signed receipt. The secret is returned once on creation and the ' +
            'row keeps only its SHA-256. Never issued by an API key: a ' +
            'credential that admits an external system is created by a person ' +
            'who can be named in the audit row.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/budget$`),
        permission: 'admin.agent_registry',
        note:
            'Read or set this tenant\'s monthly token budget for agentic runs. ' +
            'Inbound A2A refuses until it and the concurrency cap are both set.',
    },
    // ── Agent RUNS and agent PROPOSALS (#3472, #3710) ───────────────
    //
    // Every route under `/agent-runs` and the four proposal routes behind the
    // review queue. They sit outside `/admin/` and every one of them is gated
    // in its route file by `requirePermission` on the SAME pair of keys:
    // `admin.view` OR `admin.agent_registry_view`. That is the gate the runs,
    // run detail and proposals PAGES apply before they load anything
    // (`mayReadAgentActivity`), so the API refuses exactly whom the pages do.
    // `api-permission-coverage.test.ts` takes these directories as privileged
    // roots, so a route added beside them arrives ungated only by failing CI.
    //
    // Until these entries, the list, the run detail, the step feed, resume,
    // abort and the four proposal routes had only their usecase's
    // `assertCanRead` / `assertCanWrite`: every member of a workspace could
    // read every run's step input and output and every proposal's content, and
    // an EDITOR could start, resume and abort runs and approve and reject
    // proposals, through the API, while the pages refused both.
    //
    // THE WRITES ARE TWO LAYERS, and neither alone is the page's gate. The
    // pages render for the pair below and enable Start, Resume, Abort, Approve
    // and Reject on the role-tier write (`canWrite`), which each usecase
    // asserts itself. So the view key is the reach, never the write: an
    // AUDITOR or AI_ADMIN passes the route and is refused by the usecase, as
    // the page refuses it by disabling the button.
    //
    // Deliberately NOT `admin.agent_registry`, unlike the inventory reads
    // below: `mayReadAgentActivity` does not admit the register key, and
    // `tests/unit/agent-registry-view-key.test.ts` pins that.
    {
        path: new RegExp(`^${T}\\/agent-runs$`),
        methods: ['GET'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            "List the tenant's agentic workflow runs (optionally one agent's). " +
            'The runs page\'s gate (`mayReadAgentActivity`). Each row carries ' +
            "the run's summary and context, so it is the same authority as " +
            'the page that lists them.',
    },
    {
        path: new RegExp(`^${T}\\/agent-runs$`),
        methods: ['POST'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            'Start a workflow run. For a PERSON: the runs page\'s gate, then ' +
            'the role-tier write `startWorkflowRun` asserts — what the page ' +
            'enables Start on. A bearer API KEY is held instead to the ' +
            '`mcp:orchestrate` capability scope the usecase enforces for every ' +
            'key (and the registered-agent requirement for a Flue run): that ' +
            'is how a registered agent starts a run, and its key holds no ' +
            'admin-console scope. The route applies the person\'s gate to every ' +
            'context that did not authenticate as a key.',
    },
    {
        path: new RegExp(`^${T}\\/agent-runs\\/[^/]+$`),
        methods: ['GET'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            'One run with every step, each step\'s decrypted input and output ' +
            'included. The run detail page\'s gate. Tenant scope is the usecase ' +
            'predicate, so a run in another tenant is not-found rather than ' +
            'forbidden.',
    },
    {
        path: new RegExp(`^${T}\\/agent-runs\\/[^/]+\\/steps$`),
        methods: ['GET'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            "One bounded page of a run's step ledger. The same rows as the " +
            'unpaged run read, so the same gate — a different one would gate ' +
            'the paged view of data the unpaged view hands out.',
    },
    {
        path: new RegExp(`^${T}\\/agent-runs\\/[^/]+\\/(resume|abort)$`),
        methods: ['POST'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            'Resume a paused run, or abort one. The runs page\'s gate here and ' +
            'the role-tier write the usecase asserts — the two the page enables ' +
            'Resume and Abort on. The view key opens the surface and writes ' +
            'nothing: an AUDITOR or AI_ADMIN is refused by the usecase.',
    },
    // The live tail of one run's step ledger. The only `text/event-stream`
    // route under `/api/t/:slug`. The same authority as the run detail page it
    // drives; the stream adds latency, not reach.
    {
        path: new RegExp(`^${T}\\/agent-runs\\/[^/]+\\/stream$`),
        // #3710 — `admin.view` OR the inventory view key, because the run
        // detail page this drives admits either (`mayReadAgentActivity`).
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            "Live tail of one agentic run's append-only step ledger (SSE). The " +
            'same authority as the run detail page it drives; the stream adds ' +
            'latency, not reach. Tenant scope is the usecase predicate, so a ' +
            "run in another tenant is not-found rather than forbidden.",
    },
    //
    // The CHECKPOINT read beside it. A proposal DIFF carries the current values
    // of a risk, control, policy or finding beside what an agent proposes to
    // change them to, and the surface that shows those is `/agents/proposals`.
    // The canvas that consumes this is NOT an admin surface, so serving the
    // review queue from it under a weaker gate would be a permissions change
    // wearing a UI feature's clothes.
    {
        path: new RegExp(`^${T}\\/agent-runs\\/[^/]+\\/checkpoint$`),
        // #3710 — the proposals page's gate, both keys (`mayReadAgentActivity`).
        // The canvas that consumes it still offers the review on `admin.view`
        // alone; the route admitting more than one consumer offers is the safe
        // direction.
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            "One run's open human checkpoint: its status plus every PENDING " +
            'proposal it queued, each with a server-computed diff. The same ' +
            'authority as the /agents/proposals page, because it is the same ' +
            'data — the canvas reads it to offer inline approve/reject, and ' +
            'the decision itself posts to the proposals routes, so this adds ' +
            'reach to no write. Tenant scope is the usecase predicate, so a ' +
            "run in another tenant is not-found rather than forbidden.",
    },
    {
        path: new RegExp(`^${T}\\/agent-proposals$`),
        methods: ['GET'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            'The agent-proposal review queue as data. The proposals page\'s ' +
            'gate. Each row is returned WITHOUT `payloadJson`, the raw payload ' +
            'the page sends to no browser (it sends a server-computed diff).',
    },
    {
        path: new RegExp(`^${T}\\/agent-proposals\\/([^/]+\\/(approve|reject)|bulk\\/reject)$`),
        methods: ['POST'],
        permission: ['admin.view', 'admin.agent_registry_view'],
        mode: 'any',
        note:
            'Approve or reject one proposal, or reject a batch. The proposals ' +
            'page\'s gate here and the role-tier write the usecase asserts — ' +
            'the two the page enables Approve and Reject on. Approval also ' +
            'refuses every API key in the usecase: a machine cannot be one of ' +
            'the humans a proposal needs.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/[^/]+\\/policy-card$`),
        permission: 'admin.agent_policy_card',
        note:
            "Create or edit an agent's versioned runtime policy card. Its own " +
            'key, and the WIDEST of the three agent keys rather than the ' +
            'narrowest: a card declares the permitted tools AND the data rung ' +
            'AND the autonomy rung AND the per-run and per-day action budgets. ' +
            'Sharing admin.agent_tool_exposure would make every routine tool ' +
            "grant carry the authority to raise an agent's autonomy ceiling.",
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/[^/]+\\/tools$`),
        permission: 'admin.agent_tool_exposure',
        note:
            'Grant / revoke an individual MCP tool for a registered agent. Its ' +
            'own key, narrower than admin.agent_registry: the register decides ' +
            'whether an agent may act, this decides what it may reach, and a ' +
            'tool absent from the list is unreachable at /api/mcp however ' +
            'widely the credential is scoped.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/[^/]+\\/ownership-transfer(\\/complete)?$`),
        permission: 'admin.agent_ownership',
        note:
            'Propose, read, cancel and complete a two-step agent ownership ' +
            'transfer (#3698). Its own key since #3699 (admin.tenant_lifecycle ' +
            'before it), held by OWNER and AI_ADMIN and NOT by ADMIN: ADMIN ' +
            "holds the register key, and an agent's accountable owner must not " +
            'be movable by the role it is accountable to. The person completing ' +
            'step two must hold this key too. Above the catch-all: ' +
            'first-match-wins would otherwise record admin.agent_registry.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/owner-orphan-pass$`),
        permission: 'admin.tenant_lifecycle',
        note:
            "Read or set the owner-orphan pass's mode (#3670), and read its " +
            'recorded passes. Tenant lifecycle — the key the identity ladder ' +
            'carries — because the mode decides whether a scheduled job stops ' +
            'agents unattended, and ADMIN holds the register key. Above the ' +
            'catch-all: first-match-wins would otherwise record ' +
            'admin.agent_registry.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/kill-switch$`),
        permission: 'admin.agent_kill_switch',
        note:
            "Stop one agent, or every agent in the tenant, at the MCP tool " +
            'boundary — including runs already in flight. Its own key, and NOT ' +
            'admin.agent_registry even though the register already carries ' +
            '"suspend": agent_registry bundles suspend with ACTIVATE, so a ' +
            'tenant cannot delegate the authority to stop without also ' +
            'delegating the authority to admit an agent nobody has scored, and ' +
            'those two have opposite risk profiles. Platform-wide has no tenant ' +
            'to scope a key to and lives at /api/admin/agent-kill-switch behind ' +
            'PLATFORM_ADMIN_API_KEY.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/mcp\\/quarantine$`),
        methods: ['GET'],
        permission: 'admin.agent_registry',
        note:
            'The QUARANTINE TRIAGE read — the proposals the agentic output ' +
            'guard refused, with the payload that was attempted. Same key as ' +
            'the agent register below and NOT a wider one: the operator move ' +
            'after reading this page is to suspend or retire the agent that ' +
            'produced the row, which is the authority that key names. This ' +
            'rule is REQUIRED, not a stylistic preference over a prefix ' +
            'match: no other rule in this map matches /admin/mcp/** at all, ' +
            'so without it the path carries no declared permission.',
    },
    // ── Harness assurance (#3665) ───────────────────────────────────
    //
    // SUBMITTING a scan is the scanner's authority, not the register's: the
    // key a scanner's API key carries is `agent_harness_ingest` and nothing
    // wider. Above the catch-all so a POST resolves here. Reading scans is the
    // inventory read (its own rule, below, #3710). Registering a scanner's
    // signing key and recording a shortfall acceptance fall to the catch-all's
    // `agent_registry`, because each decides whose reports count or which risk
    // the tenant carries.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/harness-scans$`),
        methods: ['POST'],
        permission: 'admin.agent_harness_ingest',
        note:
            'Submit a signed inflect-agent-harness/2 report. The key alone ' +
            'ingests nothing: the report must be signed by a scanner key the ' +
            'tenant registered, which takes admin.agent_registry.',
    },
    // The tenant's own A2A signing key (#3679; owner decision 2026-10-19).
    // Rotating it is OWNER-tier — the key that rotates the tenant's DEK — and
    // reading its public half is the register key's, as handing a peer its
    // credential is. Method-scoped, and above the /admin/agents catch-all.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/a2a-signing-key$`),
        methods: ['POST'],
        permission: 'admin.tenant_lifecycle',
        note:
            'Generate or rotate the tenant\'s A2A signing key: it signs every task and ' +
            'answer the tenant exchanges with another organisation\'s agent, so ' +
            'replacing it is the same tier of act as rotating the tenant DEK.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/a2a-signing-key$`),
        methods: ['GET'],
        permission: 'admin.agent_registry',
        note:
            'Read the public half of the tenant\'s A2A signing keys, in force and ' +
            'retired, to hand to a peer. The private seed is never returned.',
    },
    // A2A peer KILL (#3679). The key that stops an agent stops a peer (roadmap
    // permission table; decision 4: no second authority model). Above the
    // peers subtree rule below, because first match wins and that rule names
    // the register key.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/peers\\/[^/]+\\/kill$`),
        permission: 'admin.agent_kill_switch',
        note:
            'Engage or lift a kill on one A2A peer: every next message to or from it ' +
            'is refused while it is in force. Lifting needs a person and a reason.',
    },
    // A2A peers (#3673). The same key as the catch-all below, stated on its
    // own because which key it is was a decision (owner, 2026-10-18; residual
    // R3 of docs/a2a-threat-model.md), not an inheritance.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/peers(\\/.*)?$`),
        permission: 'admin.agent_registry',
        note:
            'Register an A2A peer agent, score it, approve its card pin, issue ' +
            'or revoke its inbound credential (#3679) and read its signed receipts. ' +
            'Configuration, so the register key: admin.agent_external_tools ' +
            'is the key for an agent call leaving the tenant, and the ' +
            'authority that acts must not also configure whom it talks to.',
    },
    // Tenant-authored skills (#3680, step 4c), split by #3778 into the
    // review key (approve, reject, retire) and the authoring key (create,
    // version, attach a record, submit), by the owner's decision: a provider
    // that writes a tenant's skills must be expressible as a holder of
    // authoring who cannot approve. Above the catch-all; the review acts
    // first, because the authoring rule below matches their paths too.
    // Reading the Skills tab, tenant skills included, stays on the
    // catch-all's `admin.agent_registry`.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/skills\\/tenant\\/[^/]+\\/versions\\/[^/]+\\/(approve|reject|retire)$`),
        permission: 'admin.agent_skill_review',
        note:
            'Approve, reject or retire a tenant-authored skill version. The ' +
            'approver is never the version\'s author (usecase and CHECK), and ' +
            'no API key holds the key.',
    },
    {
        // One skill's versions and their text, which the author edits from and
        // the reviewer approves from: either half admits the read.
        path: new RegExp(`^${T}\\/admin\\/agents\\/skills\\/tenant\\/[^/]+$`),
        methods: ['GET'],
        permission: ['admin.agent_skill_author', 'admin.agent_skill_review'],
        mode: 'any',
        note:
            'Read one tenant-authored skill and its versions, for authoring ' +
            'or for review.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/skills\\/tenant(\\/.*)?$`),
        permission: 'admin.agent_skill_author',
        note:
            'Author a tenant-authored skill: create it, create a version, ' +
            'attach its evaluation record and submit it for review. No API ' +
            'key holds the key.',
    },
    // The registration intake (#3669). The same key as the catch-all below,
    // stated on its own because step 0e's permission table names it: the
    // intake creates a register row and its AI-system entry, which is the
    // register's authority, and its owner is the person the caller confirms.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/intake$`),
        methods: ['POST'],
        permission: 'admin.agent_registry',
        note:
            'Register a shadow agent from its SHADOW_AGENT harness finding: a ' +
            'DRAFT register row and a provisional AI-system entry at ' +
            'UNCLASSIFIED, in one transaction, owned by the person the caller ' +
            'confirms. The agent cannot be activated until the entry is classified.',
    },
    // #3671 (2c). The same key as the catch-all below, stated on its own
    // because which key it is was a decision (owner, 2026-10-18), not an
    // inheritance: confirming which directory identity IS a registered agent is
    // register authority, and no API-key scope carries it, so a scanner cannot
    // confirm the links its own reports claim.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/[^/]+\\/service-principal-link$`),
        permission: 'admin.agent_registry',
        note:
            'Confirm that a discovered Entra service principal is a registered ' +
            "agent's own — the condition for an UNATTENDED disable of that " +
            'principal when the owner-orphan pass contains the agent.',
    },

    // Agent profiles (Step 1a of docs/claude-agent-sdk-design.md, #4143). The
    // same key as the catch-all below, stated on its own because which key it
    // is was a decision (owner decision 3, 2026-10-25): a profile is what the
    // agent should do, a register decision, and the four-eyes rule that a
    // version is approved by someone other than its author is held in the
    // usecase and by a CHECK, not by a second key. Above the inventory reads,
    // so a GET of a profile, which carries the instructions, takes the
    // register key and never the read-only view key.
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/[^/]+\\/profile(\\/.*)?$`),
        permission: 'admin.agent_registry',
        note:
            "Write, submit, approve, reject, retire and read an agent's profile: " +
            'the instructions, tools, skills and model tier it runs with. The ' +
            'approver is never the author (usecase and CHECK).',
    },

    // ── The agent INVENTORY reads (#3710) ─────────────────────────────
    //
    // Read-only `admin.agent_registry_view` OR the register key, whose holders
    // always could read these. Above the catch-all so a GET resolves here and
    // every write on the same paths still falls through to the register key.
    // The detail rule's segment excludes the static siblings by name
    // (`AGENT_ADMIN_API_STATIC_SEGMENTS`, pinned against the filesystem), so a
    // GET of `…/agents/skills` is not mistaken for one agent's row.
    {
        path: new RegExp(`^${T}\\/admin\\/agents$`),
        methods: ['GET'],
        permission: ['admin.agent_registry_view', 'admin.agent_registry'],
        mode: 'any',
        note:
            'List the agent register. The inventory an audit asks for, so the ' +
            'read-only view key (AUDITOR holds it) or the register key; ' +
            'registering an agent stays on the register key below.',
    },
    {
        path: new RegExp(
            `^${T}\\/admin\\/agents\\/(?!(?:${AGENT_ADMIN_API_STATIC_SEGMENTS.join('|')})$)[^/]+$`,
        ),
        methods: ['GET'],
        permission: ['admin.agent_registry_view', 'admin.agent_registry'],
        mode: 'any',
        note:
            "Read one agent's register row. The view key or the register key; " +
            'amending and retiring the agent stay on the register key below.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/harness-scans$`),
        methods: ['GET'],
        permission: ['admin.agent_registry_view', 'admin.agent_registry'],
        mode: 'any',
        note:
            'List harness scans. Reading the inventory, so the view key or the ' +
            'register key; submitting one is the ingest key, above.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/discovered$`),
        methods: ['GET'],
        permission: ['admin.agent_registry_view', 'admin.agent_registry'],
        mode: 'any',
        note:
            'List the discovered agents a person can start a discovered-agent ' +
            'review with (#4472). The key the harness-scans list and the ' +
            'get_discovered_agent tool take, so the run can read the agent it ' +
            'is started with.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/harness-estates$`),
        methods: ['GET'],
        permission: ['admin.agent_registry_view', 'admin.agent_registry'],
        mode: 'any',
        note:
            'Read the client estates and their schedule health (#3678): the last ' +
            'complete scan per estate and per source. Built from the scans, so ' +
            'the key their list takes. DECLARING an estate, changing it or ' +
            'removing it falls to the register key below: which scanner covers ' +
            'which estate is the register\'s decision, never the scanner\'s.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents\\/reports$`),
        methods: ['GET'],
        permission: ['admin.agent_registry_view', 'admin.agent_registry'],
        mode: 'any',
        note:
            'Read the agent governance pack. The view key or the register key. ' +
            'FILING it (POST …/reports/export) writes an Evidence row, so it ' +
            'falls to the register key below and the usecase adds evidence.edit.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agents(\\/.*)?$`),
        permission: 'admin.agent_registry',
        note:
            'Register / amend / activate / suspend / retire an autonomous ' +
            'agent. Its own key, not admin.manage: an ACTIVE row here is what ' +
            'lets a credential through the /api/mcp registration gate, so this ' +
            'is the authority to decide which agents may act in the tenant.',
    },

    // ── Device-agent tokens (PR-5) ──────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/device-tokens(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Device-agent token issuance + revocation — a long-lived ' +
            'per-tenant credential authenticating /devices/report; admin-only.',
    },

    // ── Master-KEK rotation (Epic B.3) ──────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/key-rotation(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Re-wraps the tenant DEK + re-encrypts v1 ciphertexts ' +
            'after the operator stages a new DATA_ENCRYPTION_KEY. ' +
            'Operator-driven fleet operation; ADMIN tier suffices.',
    },

    // ── NIS2 gap-assessment delegation (Prompt 2) ───────────────────
    {
        // Dispatch (POST) + owner list (GET) + finalize — assessment-admin
        // actions. The assignee self-service routes at
        // `/gap-assessments/<id>/assignments/my/**` are intentionally NOT
        // matched here (excluded below): they are ctx-scoped in the usecase to
        // the assignee, mirroring own-MFA / own-session self-service.
        path: new RegExp(`^${T}\\/gap-assessments\\/[^/]+\\/assignments(\\/finalize)?$`),
        permission: 'admin.manage',
        note:
            'Delegating a NIS2 gap re-assessment to respondents + finalising it ' +
            'is an assessment-admin action; per-respondent answering is ' +
            'self-service (ctx-scoped in the usecase).',
    },

    // ── Admin plan change (business-KPI plan-change boundary) ───────
    {
        path: new RegExp(`^${T}\\/admin\\/billing\\/plan(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Mutates BillingAccount.plan — direct billing + entitlement ' +
            'consequences. No Stripe webhook in this deployment, so this ' +
            'is the only first-party plan-change path; OWNER-only.',
    },

    // ── Which ENGINE executes this tenant's agentic runs ────────────
    // Method-scoped (owner decision 2026-10-25, #4139): READING the gate is
    // admin.view, so an ADMIN sees on the AI features page why the tenant runs
    // on the engine it does; CHANGING it stays OWNER-only. First match wins, so
    // the GET rule sits above the rule that covers every other method.
    {
        path: new RegExp(`^${T}\\/admin\\/agent-driver(\\/.*)?$`),
        methods: ['GET'],
        permission: 'admin.view',
        note:
            'Read which engine this tenant\'s agentic runs execute on, and why: the '
            + 'tenant\'s setting, the operator\'s env switch, whether the build has the '
            + 'engine, and the reason the effective engine is what it is. Every admin '
            + 'can see it, because a gate nobody can read looks the same as a broken '
            + 'one. The six-term wiring checklist, which adds counts over the agent '
            + 'register, stays on admin/flue-wiring under admin.tenant_lifecycle.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/agent-driver(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Change the customer half of the two-key agentic-driver gate. Switching '
            + 'to FLUE hands an external agent runtime the decision of what to '
            + 'TRY against this tenant\'s compliance data — `runReadTool` '
            + 'still decides what is PERMITTED, so no register control moves, '
            + 'but who may make that change is tenant-lifecycle authority. '
            + 'ADMIN deliberately does not hold it.',
    },

    // ── Whether the Flue engine is wired, and what still blocks it ──
    {
        path: new RegExp(`^${T}\\/admin\\/flue-wiring(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Read-only, and gated with the key that CHANGES the driver (the '
            + 'agent-driver PUT) rather than the admin.view its GET takes. The '
            + 'response adds two counts over the agent register to the driver '
            + 'gate\'s facts, and it is the owner\'s checklist for wiring a Flue '
            + 'run, shown beside the control only an owner can use.',
    },

    // ── Optional product modules (per tenant) ───────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/process-canvas-module(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Grants or removes a whole product surface for the tenant. ' +
            'OWNER-only on the same key as tenant deletion and the identity ' +
            'write ladder, because adding or removing a surface is authority ' +
            'of that class rather than day-to-day administration. It is also ' +
            'a licence control: the editor behind the process canvas may not ' +
            'be put in front of customers without a paid key, so the switch ' +
            'that decides whether a customer sees it cannot sit below OWNER.',
    },

    // ── AI feature switches (per tenant) ───────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/ai-features(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Turns AI on or off for the whole workspace — the master switch ' +
            'plus the three per-feature ones. On the same OWNER key as the ' +
            'process-canvas module rather than a narrower admin read key, for ' +
            'a reason that is contractual rather than technical: a customer ' +
            'may have undertaken that no model processes their data, and the ' +
            'control honouring that undertaking cannot sit where day-to-day ' +
            'administration can reach it. The GET shares the key because it ' +
            'discloses the deploy-level flags (which features the platform ' +
            'runs at all), which is infrastructure state rather than tenant ' +
            'configuration. Note the route can only ever flip the TENANT ' +
            'layer: the env flags are read once at process start, so no ' +
            'permission grants the power to change them from here.',
    },

    // ── JML identity-write authority (per direction) ────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/identity-write-policy(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Decides whether this product may DISABLE or CREATE accounts ' +
            'in the customer\'s own identity directory. Same OWNER-only key ' +
            'as tenant deletion and DEK rotation because it is authority of ' +
            'the same class — and ADMIN explicitly does not hold it. Every ' +
            'other integration reads; this is the one that writes to a ' +
            'system we do not own.',
    },

    // ── JML break-glass protection (never-offboard, per account) ────
    {
        path: new RegExp(`^${T}\\/admin\\/identity-account-protection(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Marks one directory account as never-offboard, or releases it. ' +
            'Same OWNER-only key as the write policy it overrides: deciding ' +
            'the product may NOT disable an account is authority of the same ' +
            'class as deciding that it may, and releasing one hands back ' +
            'standing power to disable it. A SIBLING path rather than nested ' +
            'under admin/integrations/identity-accounts, where the roster GET ' +
            'lives — matching is first-match-wins and that rule resolves to ' +
            'admin.manage.',
    },

    // ── JML joiner pass — the off-schedule RE-RUN trigger ─────────
    //
    // MUST PRECEDE the report rule below. First-match-wins, and the report's
    // subtree regex already covers `/run`; an exact-anchored rule here keeps
    // the TRIGGER from inheriting whatever key the read surface is later
    // given.
    {
        path: new RegExp(`^${T}\\/admin\\/identity-joiner-passes\\/run$`),
        methods: ['POST'],
        permission: 'admin.tenant_lifecycle',
        note:
            'Fires a joiner pass NOW, off the 04:30 schedule. NOT because it ' +
            'writes to a customer directory — JOINER_MAX_MODE is DRY_RUN and ' +
            'the pass writes none — but because the artefact it produces names ' +
            'which of a customer\'s people the product would create an account ' +
            'for, and at what address. Same OWNER-only key as reading that ' +
            'report and as the write policy the passes run under. Its own ' +
            'exact-anchored rule rather than riding the subtree rule, so a ' +
            'later weakening of the read surface cannot reach the trigger.',
    },

    // ── JML joiner pass reports (the seven-day observation record) ──
    {
        path: new RegExp(`^${T}\\/admin\\/identity-joiner-passes(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Reads the per-starter record of what a joiner pass would have ' +
            'done. Same OWNER-only key as the write policy those passes run ' +
            'under: the report names which of a customer\'s people the product ' +
            'would create an account for, and at what address, which is ' +
            'authority of the same class as granting the create. A SIBLING path ' +
            'rather than nested under admin/integrations, where first-match-wins ' +
            'would resolve it to the weaker admin.manage.',
    },

    // ── JML leaver pass — the off-schedule RE-RUN trigger ──────────
    //
    // MUST PRECEDE the report rule below. First-match-wins, and the report's
    // subtree regex already covers `/run`; an exact-anchored rule here keeps
    // the only endpoint in this subtree that WRITES to a customer's directory
    // from inheriting whatever key the read surface is later given.
    {
        path: new RegExp(`^${T}\\/admin\\/identity-leaver-passes\\/run$`),
        methods: ['POST'],
        permission: 'admin.tenant_lifecycle',
        note:
            'Fires a leaver pass NOW, off the 05:00 schedule — the direction ' +
            'that DISABLES accounts in the customer\'s own directory. Same ' +
            'OWNER-only key as the write policy that decides whether such a ' +
            'write is permitted at all, because being able to fire the pass ' +
            'and being able to authorise it are one authority. It has its own ' +
            'rule rather than riding the identity-leaver-passes subtree rule ' +
            'immediately below: that one gates a REPORT, and an edit softening ' +
            'it to admin.manage on the grounds that reading is not writing ' +
            'would otherwise hand every ADMIN an off-schedule directory write.',
    },

    // ── JML leaver pass reports (the seven-day observation record) ──
    {
        path: new RegExp(`^${T}\\/admin\\/identity-leaver-passes(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Reads the per-candidate record of what a leaver pass did, or ' +
            'would have done in dry run. Same OWNER-only key as the write policy ' +
            'those passes run under, because naming which of a customer\'s ' +
            'people the product would disable is authority of the same class ' +
            'as granting the disable. A SIBLING path rather than nested under ' +
            'admin/integrations on purpose: matching is first-match-wins and ' +
            'that rule resolves to admin.manage, so nesting would document a ' +
            'weaker gate here than the handler enforces.',
    },

    // ── JML write journal (what a disable replaced) ─────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/identity-write-journal(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Reads what a directory write REPLACED — the prior state captured ' +
            'before the account was disabled, plus the provider\'s own account ' +
            'of how the write went. This is the surface the DISABLED ' +
            'notification already sends operators to ("quote that reference to ' +
            'your platform administrator, who can read the captured state"), ' +
            'and until it existed that instruction named nothing. Same ' +
            'OWNER-only key as the write policy the write ran under and as the ' +
            'leaver-pass report that links here: the row says what was done to ' +
            'a named person\'s account, and reading that is authority of the ' +
            'same class as granting it. Subtree rule, so the by-reference ' +
            'lookup at /<journalId> is gated identically to the index rather ' +
            'than by a second rule that could drift. A SIBLING of ' +
            'admin/identity-write-policy rather than nested under ' +
            'admin/integrations, where first-match-wins would resolve it to ' +
            'admin.manage and document a weaker gate than the handler enforces.',
    },

    // ── Prior-state read pairing, per MCP connection (#2861) ───────
    {
        path: new RegExp(`^${T}\\/admin\\/external-prior-state-read(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Which READ is called to capture what an external WRITE is about to ' +
            'replace. Same OWNER-only key as the write ladder beside it: this ' +
            'decides what is called against a customer\'s own system immediately ' +
            'before it is changed, and a wrong pairing writes a plausible-looking ' +
            'record of the wrong object into the journal. A SIBLING path rather ' +
            'than nested under admin/integrations/<id>, because matching is ' +
            'first-match-wins and that rule resolves to admin.manage, which would ' +
            'document a weaker gate than the handler enforces.',
    },

    // ── External-write ladder, per MCP connection (#2861) ───────────
    {
        path: new RegExp(`^${T}\\/admin\\/external-write-policy(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'How far an AGENT may go when driving a write to a customer\'s own ' +
            'third-party system, per MCP connection. Same OWNER-only key as the ' +
            'identity write policy, for the same reason: this grants the product ' +
            'authority to CHANGE something in a system that is not ours, which is ' +
            'authority of the same class as disabling an account in their ' +
            'directory. A SIBLING path rather than nested under ' +
            'admin/integrations/<id> on purpose — matching is first-match-wins and ' +
            'that rule resolves to admin.manage, so nesting would document a ' +
            'weaker gate here than the handler enforces. Subtree rule, so the ' +
            'per-connection path is gated identically to any future index rather ' +
            'than by a second rule that could drift.',
    },

    // ── Integration passport, per MCP connection (#3672) ────────────
    {
        path: new RegExp(`^${T}\\/admin\\/integration-passport(\\/.*)?$`),
        methods: ['GET'],
        permission: 'admin.tenant_lifecycle',
        note:
            'One external agent connection\'s integration passport, built live ' +
            'from stored rows. Same OWNER-only key as the two rules above, as a ' +
            'PLACEMENT rather than a confidentiality boundary: the rung and the ' +
            'pairings are changed only under that key, and the OWNER role holds ' +
            'every finding on an unowned connection. The passport itself is the ' +
            'week\'s Evidence, readable by every evidence reader, so it carries ' +
            'nothing that relies on this gate. A SIBLING path rather than nested under ' +
            'admin/integrations/<id> — matching is first-match-wins and that ' +
            'rule resolves to admin.manage, which would document a weaker gate ' +
            'than the handler enforces. GET only, declared rather than left ' +
            'open, so a future write under this subtree fails the coverage ' +
            'guard instead of inheriting a read gate.',
    },

    // ── Entra entitlement discovery (#3329) ─────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/entra-entitlement(\\/.*)?$`),
        methods: ['GET'],
        permission: 'admin.manage',
        note:
            'Lists the access packages and assignment policies a grant can be ' +
            'composed against, so the compose form offers choices instead of two ' +
            'free-text boxes for opaque GUIDs. READ-ONLY, hence admin.manage and ' +
            'NOT the admin.tenant_lifecycle its sibling external-write-policy ' +
            'carries two rules above — that one sets how far an agent may go when ' +
            'CHANGING a customer system, which is authority of a different class. ' +
            'Knowing which packages exist grants nothing. GET only, declared ' +
            'rather than left open, so a future POST under this subtree fails the ' +
            'coverage guard instead of inheriting a read gate. Deliberately NOT a ' +
            'third tool on the grant MCP endpoint: that endpoint advertises two ' +
            'tools and a test asserts the COUNT, because its only intended client ' +
            'is our own dispatch, which is handed a resolved package id by an ' +
            'approved template and has no use for discovery.',
    },

    // ── Minting the grant endpoint's token (#3330) ──────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/mcp-server-token(\\/.*)?$`),
        methods: ['POST'],
        permission: 'admin.tenant_lifecycle',
        note:
            'Mints (or rotates) the bearer token the grant MCP endpoint ' +
            'authenticates. OWNER-only because minting the credential GRANTS the ' +
            'authority it carries: whoever holds it can drive a time-bounded ' +
            'directory write in the customer\'s own tenant. Same class as the ' +
            'external write policy above, not the configuration-editing class of ' +
            'the integrations CRUD — which is also why this is a SIBLING path and ' +
            'not nested under admin/integrations/<id>: matching is ' +
            'first-match-wins and that rule resolves to admin.manage, so nesting ' +
            'would document a weaker gate than the handler enforces. POST only: ' +
            'it overwrites any previous value, and a GET returning a credential ' +
            'invites a browser, a proxy or a log to keep it.',
    },

    // ── Per-tenant DEK rotation (Epic F.2 follow-up) ────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/tenant-dek-rotation(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Generates a fresh per-tenant DEK + sweeps every v2 ' +
            'ciphertext under the new key. Response to a per-tenant ' +
            'compromise — destructive on the timeline that matters ' +
            'and OWNER-only per the role model in CLAUDE.md.',
    },
    // ── The quarantine list (the read side of the reversal) ─────────
    //
    // Order against the reversal rule below does not matter: the two
    // paths are disjoint (`quarantined` carries no second segment), so
    // first-match-wins cannot confuse them. They sit adjacent because
    // they are one decision — a reviewer changing the tier of either
    // needs the other on the same screen.
    {
        path: new RegExp(`^${T}\\/admin\\/files\\/quarantined$`),
        permission: 'admin.tenant_lifecycle',
        methods: ['GET'],
        note:
            'Enumerates the files ClamAV condemned. Same OWNER-only key ' +
            'as the reversal it feeds, deliberately: it is the ONLY ' +
            'source of the fileId that write consumes, so a weaker tier ' +
            'here would be disclosure with no matching capability — and ' +
            'the rows are a map of the malware in a customer library ' +
            '(name, size, uploader, engine signature). An ADMIN mid- ' +
            'incident still reads every FILE_QUARANTINED audit row at ' +
            'the far lower audit.view bar.',
    },
    // ── False-positive quarantine reversal ──────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/files\\/[^/]+\\/clear-quarantine$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Returns a file ClamAV condemned to circulation — the only ' +
            'way back from a terminal INFECTED verdict. Serving suspected ' +
            'malware again is OWNER-grade authority, the same class as ' +
            'tenant deletion and DEK rotation; ADMIN is explicitly denied ' +
            'this key. Audited as FILE_QUARANTINE_CLEARED before the write.',
    },
    // ── Bounded AV catch-up rescan ──────────────────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/av-rescan$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Enqueues the bounded per-tenant `av-rescan` job, which turns ' +
            'evidence stuck at scanStatus PENDING into CLEAN or INFECTED. ' +
            'Same OWNER-only key as clear-quarantine directly above, because ' +
            'it is the same authority — deciding what the download gate will ' +
            'serve — applied in BULK rather than one file at a time. A ' +
            'SIBLING of admin/files rather than nested under it: matching is ' +
            'first-match-wins, and an exact-anchored path here means a future ' +
            'sub-route cannot silently inherit this gate. Audited as ' +
            'AV_RESCAN_INITIATED at enqueue time.',
    },
    // ── Per-tenant DEK rotation — GAP-22 alias path ─────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/rotate-dek(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Same handler as /admin/tenant-dek-rotation; aliased here ' +
            'so the GAP-22-prescribed short URL is gated identically ' +
            'rather than relying on path-equivalence at the runtime ' +
            'permission middleware (the regex matcher is path-string ' +
            'based, not handler-identity based).',
    },

    // ── Billing (Epic D.3 — was legacy requireAdminCtx) ─────────────
    {
        path: new RegExp(`^${T}\\/billing\\/(checkout|portal|events)(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Stripe checkout + customer portal + billing-event listing — ' +
            'commercial actions; treat as admin-only.',
    },

    // ── Security session-management bulk routes (Epic D.3) ──────────
    {
        path: new RegExp(`^${T}\\/security\\/sessions\\/(revoke-all|revoke-user)$`),
        permission: 'admin.members',
        note:
            'Admin-driven session revocation for the whole tenant or a ' +
            'specific colleague — same surface as /admin/sessions; ' +
            'gated under admin.members for consistency.',
    },

    // ── Tenant MFA policy (Epic D.3 — PUT only; GET is open) ────────
    // Only the PUT method is mapped here. The GET handler in the same
    // file is intentionally unprotected by `requirePermission` — any
    // tenant member can read the current MFA posture from the security
    // settings page. The methods array enforces the asymmetry.
    {
        path: new RegExp(`^${T}\\/security\\/mfa\\/policy$`),
        methods: ['PUT'],
        permission: 'admin.manage',
        note:
            'Mutating the tenant MFA policy is admin-only; the GET ' +
            'sibling stays open so the settings UI can render for ' +
            'every tenant member.',
    },

    // ── Tenant SSO configuration (Epic D.3) ─────────────────────────
    {
        path: new RegExp(`^${T}\\/sso(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'SSO provider configuration — provider list, upsert, ' +
            'enable/enforce toggles, deletion. All ADMIN-only.',
    },

    // ── Tenant invite management (Epic 1, PR 3) ──────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/invites(\\/.*)?$`),
        permission: 'admin.members',
        note:
            'Creating, listing, and revoking pending tenant invites. ' +
            'Changes who can join the tenant — gated under admin.members.',
    },

    // ── Trust Center — publish toggle (OWNER) ───────────────────────
    // MUST precede the compose rule below — first-match wins and this is the
    // more specific path. Publishing exposes company data on the PUBLIC
    // internet, so it is OWNER-only (admin.tenant_lifecycle), audited.
    {
        path: new RegExp(`^${T}\\/admin\\/trust-center\\/enable(\\/.*)?$`),
        permission: 'admin.tenant_lifecycle',
        note:
            'Enable/disable the PUBLIC /trust/<slug> page — exposes or ' +
            'withdraws company data on the open internet. OWNER-only; ' +
            'audited (TRUST_CENTER_PUBLISHED/UNPUBLISHED).',
    },

    // ── Trust Center — compose content (ADMIN) ──────────────────────
    {
        path: new RegExp(`^${T}\\/admin\\/trust-center(\\/.*)?$`),
        permission: 'admin.manage',
        note:
            'Compose the curated trust-center projection (display name, ' +
            'frameworks-to-show, posture prose, documents). ADMIN-tier; ' +
            'publishing it to the internet is the separate OWNER-gated ' +
            '/enable route above.',
    },

    // ── NIS2 Article 23 incident response ────────────────────────────
    // Mutations (create, advance phase, mark reportable, file a
    // regulatory notification, link controls, append timeline) are a
    // privileged security-team action — gated under `incidents.manage`.
    {
        path: new RegExp(`^${T}\\/incidents(\\/.*)?$`),
        methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
        permission: 'incidents.manage',
        note:
            'Create / advance / mark-reportable / submit-notification / ' +
            'link-controls / timeline writes — a privileged security-team ' +
            'action, not a general editor action. ADMIN/OWNER only.',
    },
    // Reads (list + detail + deadlines + timeline) are visible to every
    // member for compliance visibility — gated under `incidents.view`.
    {
        path: new RegExp(`^${T}\\/incidents(\\/.*)?$`),
        methods: ['GET'],
        permission: 'incidents.view',
        note: 'List / detail incident reads — compliance visibility for every member.',
    },

    // ── Report export surface (reports.export) ──────────────────────
    // The UI gates these three export actions with
    // <RequirePermission resource="reports" action="export"> — the API
    // must enforce the same or the gate is UI-only. READER has
    // reports.export=false; EDITOR/AUDITOR/ADMIN/OWNER have it true.
    {
        path: new RegExp(`^${T}\\/reports\\/pdf\\/generate$`),
        methods: ['POST'],
        permission: 'reports.export',
        note:
            'Generates a branded PDF report (audit-readiness / risk-register / ' +
            'gap-analysis) and streams or persists it — an export action.',
    },
    {
        path: new RegExp(`^${T}\\/reports\\/soa\\/export\\.csv$`),
        methods: ['GET'],
        permission: 'reports.export',
        note:
            'Exports the Statement of Applicability / coverage CSV — an export ' +
            'action carrying aggregated compliance posture out of the app.',
    },
    {
        path: new RegExp(`^${T}\\/risks\\/reports$`),
        methods: ['POST'],
        permission: 'reports.export',
        note:
            'Generates a risk report run (PDF/CSV/PPTX) — an export action. The ' +
            'GET on the same path (list templates + recent runs) stays open.',
    },

    // ── Asset bulk mutations + purge (Epic C.1 audit consistency) ────
    {
        path: new RegExp(`^${T}\\/assets\\/bulk\\/(status|assign)$`),
        methods: ['POST'],
        permission: 'assets.edit',
        note:
            'Bulk asset status change / owner assign — recoverable asset ' +
            'mutations; gated so denials audit at the permission layer.',
    },
    {
        // Split out of the (status|assign|delete) rule above, which declared
        // assets.edit for all three while the handler had always declared
        // admin.manage. Nothing enforced off this map, so the mismatch cost no
        // access — but the map is what a reviewer and the SDK read, and it
        // described the delete as one tier weaker than it is.
        path: new RegExp(`^${T}\\/assets\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk soft-delete of the asset register — bulkDeleteAsset asserts ' +
            'canAdmin, so the route gate matches at admin.manage rather than ' +
            'the assets.edit its recoverable bulk siblings use.',
    },
    {
        path: new RegExp(`^${T}\\/assets\\/bulk\\/import$`),
        methods: ['POST'],
        permission: 'assets.create',
        note: 'Bulk asset CSV import — creates assets, so gated on assets.create.',
    },
    {
        path: new RegExp(`^${T}\\/assets\\/[^/]+\\/(purge|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'IRREVERSIBLE hard delete of a soft-deleted asset, and its restore ' +
            'counterpart — both usecases assert canAdmin (via purgeEntity / ' +
            'restoreEntity), so the route gate matches at admin.manage ' +
            '(OWNER/ADMIN), not the assets.edit an EDITOR holds.',
    },

    // ── Tenant security settings ────────────────────────────────────
    // Admin-only on BOTH verbs, unlike the sibling MFA-policy route whose
    // GET is member-visible: this payload carries the session cap and
    // reveals whether an outbound audit-stream endpoint is configured.
    // The agent-enforcement PRE-FLIGHT. Listed ABOVE its sibling because the
    // sibling's pattern is anchored with `$` and would not match this path
    // anyway — the ordering here is for the READER, so the narrower route is
    // found first when someone scans this file for "security-settings".
    //
    // `admin.manage` is the ROUTE gate, matching its sibling. The usecase
    // additionally requires `admin.agent_registry` (#2444): the setting decides
    // whether the agent register is load-bearing, so flipping it without being
    // able to read the register is not a coherent authority. That check lives in
    // the usecase rather than here so the PUT path writing the same field cannot
    // bypass it.
    {
        path: new RegExp(`^${T}\\/admin\\/security-settings\\/agent-enforcement$`),
        permission: 'admin.manage',
        note:
            'Pre-flight for enforcing agent registration: lists the ACTIVE, ' +
            'UNBOUND credentials that the tool boundary would begin refusing. ' +
            'Read-only; the write goes through the sibling PUT.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/security-settings$`),
        permission: 'admin.manage',
        note:
            'Reading and writing the tenant security configuration — session ' +
            'cap, audit-stream endpoint + HMAC secret, AI guard mode and AI ' +
            'residency, whose consumers existed before any writer did — and ' +
            'the API-key rotation age the credential-hygiene pass applies (#3708).',
    },

    // ── Vendor sub-processor register (4th-party graph) ─────────────
    // Split read/write so AUDITOR and READER keep visibility of the
    // nth-party chain — reading who a vendor sub-processes to IS a
    // compliance-review action — while only vendors.edit can rewire it.
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/subprocessors(\\/chain)?$`),
        methods: ['GET'],
        permission: 'vendors.view',
        note:
            'Reading the sub-processor register and the recursive nth-party ' +
            'chain. Matches the usecase assert; the /chain leaf discloses the ' +
            'whole graph in one call, so it is gated identically rather than ' +
            'left to inherit.',
    },
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/subprocessors$`),
        methods: ['POST', 'DELETE'],
        permission: 'vendors.edit',
        note:
            'Adding or removing a sub-processor relationship — edits the ' +
            'GDPR Art.28 sub-processor record, so it sits at the vendor ' +
            'management tier, not the read tier.',
    },
    // ── Evidence bundles (the surviving `/issues` routes) ────────────
    // The rest of `/issues` was a parallel write API over the same `Task`
    // rows with strictly weaker gates, and was deleted. These three carry
    // behaviour with no `/tasks` twin, so they keep the path and gain the
    // gate they never had: without `requirePermission` the granular
    // custom-role `tasks.*` flags were unreachable — the coarse
    // `ctx.permissions` set is derived from the BASE role and never reads
    // `permissionsJson` — and a denial wrote no AUTHZ_DENIED row.
    {
        path: new RegExp(`^${T}\\/issues\\/[^/]+\\/bundles(\\/.*)?$`),
        methods: ['GET'],
        permission: 'tasks.view',
        note:
            'Reading a task\'s evidence bundles. Same key as the `/tasks` ' +
            'read tier, since a bundle is a view onto that task\'s evidence.',
    },
    {
        path: new RegExp(`^${T}\\/issues\\/[^/]+\\/bundles(\\/.*)?$`),
        methods: ['POST'],
        permission: 'tasks.edit',
        note:
            'Creating a bundle, adding an item, or FREEZING one. Freeze ' +
            'makes the bundle immutable, so it is an edit rather than a ' +
            'read even though it takes no body.',
    },

    // ── Destructive register verbs (#2117) ──────────────────────────
    // Bulk delete / archive / purge / restore across the evidence,
    // policy, vendor, test-plan and task registers. Every one of these
    // authorized correctly BEFORE this map entry existed — via the
    // usecase `assertCan*` — and every one of them recorded nothing when
    // it refused, because `AUTHZ_DENIED` is written by `requirePermission`
    // and by nothing else. The usecase asserts stay (they are what
    // protects jobs and scripts); these rules describe the route gate
    // that now sits in front of them.
    //
    // Each key is chosen to MIRROR the assert behind it, never to be
    // derived from the path. A key weaker than the assert is not a
    // lenient gate, it is an unlogged one; a key stricter than the
    // assert locks out a caller the usecase would admit.
    {
        path: new RegExp(`^${T}\\/evidence\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk soft-delete of the evidence register — `bulkDeleteEvidence` ' +
            'asserts canAdmin, so the route gate matches at admin.manage ' +
            'rather than the evidence.edit an EDITOR holds.',
    },
    {
        path: new RegExp(`^${T}\\/evidence\\/[^/]+\\/(purge|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'IRREVERSIBLE hard delete of a soft-deleted evidence record, and ' +
            'its restore counterpart. Both reach assertCanAdmin through ' +
            'purgeEntity / restoreEntity in soft-delete-operations.',
    },
    {
        path: new RegExp(`^${T}\\/policies\\/bulk\\/(delete|archive)$`),
        methods: ['POST'],
        permission: ['admin.manage', 'policies.edit'],
        mode: 'all',
        note:
            'Bulk delete / archive of the policy library. TWO keys because ' +
            'assertCanAdminPolicies is itself a conjunction — the coarse ADMIN ' +
            'tier AND the granular policies.edit flag — and the route must ' +
            'mirror the assert to catch every denial it exists to log.',
    },
    {
        path: new RegExp(`^${T}\\/policies\\/[^/]+\\/(purge|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Hard delete / restore of one policy. admin.manage ALONE, unlike ' +
            'the bulk siblings: purgePolicy and restorePolicy delegate to ' +
            'purgeEntity / restoreEntity, which assert only the coarse ' +
            'canAdmin and never reach assertCanAdminPolicies. Adding ' +
            'policies.edit here would out-strict the usecase.',
    },
    {
        path: new RegExp(`^${T}\\/vendors\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk delete of the vendor register — raised to assertCanAdmin so ' +
            'it matches every peer register, unlike its bulk/status and ' +
            'bulk/assign siblings which stay at the vendors.edit tier.',
    },
    {
        path: new RegExp(`^${T}\\/tests\\/plans\\/bulk\\/(delete|restore)$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk delete / restore of the control test programme. ' +
            'assertCanBulkManageTestPlans reads appPermissions.admin.manage ' +
            'directly, so route gate and usecase gate are the same predicate.',
    },
    {
        path: new RegExp(`^${T}\\/tasks\\/bulk\\/delete$`),
        methods: ['POST'],
        permission: 'admin.manage',
        note:
            'Bulk delete of the task register. Previously declared tasks.edit ' +
            'while bulkDeleteTask asserted canAdmin — a gate weaker than its ' +
            'assert, so an EDITOR passed the middleware and was refused deeper ' +
            'where nothing writes an audit row. Not an access change.',
    },

    // ── Destructive register verbs, second tranche (#2117) ──────────
    // Same defect, the single-entity half of the population: a correct
    // usecase refusal that writes no AUTHZ_DENIED row. The first tranche
    // above took the bulk + purge/restore verbs; these are per-record
    // destruction and credential revocation.
    //
    // The three vendor rules are the strongest form of "mirror the
    // assert": assertCanManageVendors, assertCanManageVendorDocs and
    // assertCanRunAssessment each read `appPermissions.vendors.edit`
    // DIRECTLY — the same object and the same flag `requirePermission`
    // evaluates. So the caller set is provably unchanged and only the
    // layer that records the refusal moves.
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/documents\\/[^/]+(\\/extract)?$`),
        methods: ['POST', 'DELETE'],
        permission: 'vendors.edit',
        note:
            'Removing a vendor due-diligence artefact (the SOC 2 report or DPA ' +
            'an assessment was signed off against), and the AI extraction over ' +
            'it. vendors.edit IS the predicate assertCanManageVendorDocs reads.',
    },
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/links\\/[^/]+$`),
        methods: ['DELETE'],
        permission: 'vendors.edit',
        note:
            'Detaching a vendor from the control, risk or asset it bears on — ' +
            'the traceability edge disappears from the governance view. ' +
            'vendors.edit IS the predicate assertCanManageVendors reads.',
    },
    {
        path: new RegExp(`^${T}\\/vendor-assessment-reviews\\/[^/]+\\/revoke$`),
        methods: ['POST'],
        permission: 'vendors.edit',
        note:
            'Killing an external respondent link — a credential-lifecycle verb, ' +
            'where a refused attempt is exactly what a reviewer looks for after ' +
            'a leak. vendors.edit IS the predicate assertCanRunAssessment reads.',
    },
    {
        path: new RegExp(`^${T}\\/policies\\/[^/]+\\/archive$`),
        methods: ['POST'],
        permission: ['admin.manage', 'policies.edit'],
        mode: 'all',
        note:
            'Archiving ONE policy. Two keys, matching its bulk/archive twin: ' +
            'archivePolicy asserts assertCanAdminPolicies, a conjunction, so a ' +
            'one-key gate would admit a role the usecase then refuses silently. ' +
            'Unlike the purge/restore rule above, which takes admin.manage alone.',
    },
    {
        path: new RegExp(`^${T}\\/loss-events\\/[^/]+$`),
        methods: ['DELETE'],
        permission: 'admin.manage',
        note:
            'Soft-delete of a recorded loss actual. deleteLossEvent asserts ' +
            'canAdmin because actuals are evidence, so the gate matches at ' +
            'admin.manage; DELETE-only, the GET/PATCH siblings are ordinary.',
    },

    // ── Destructive register verbs, third tranche (#2117) ───────────
    // Same defect once more, on the subset where an ALREADY-EXISTING key
    // admits exactly the population the usecase assert admits. Routes whose
    // assert has no matching key (the business-continuity DELETEs, which
    // gate on the coarse `assertCanWrite` and belong to no register with a
    // PermissionSet domain) were deliberately left in the census rather than
    // bound to an unrelated register's flag.
    //
    // Two of the five mirror their assert EXACTLY — `vendors.edit` and
    // `tests.execute` are the very expressions the policy helpers read, so
    // the caller set is unchanged for custom roles too. The other three
    // (both auditor rules and automation) mirror a ROLE-tier predicate onto
    // an appPermissions flag — the same coarse-to-granular swap the first
    // tranche made for assertCanAdmin, and the key choice for the auditor
    // pair specifically is argued in those route files.
    {
        path: new RegExp(`^${T}\\/audits\\/auditors\\/access$`),
        methods: ['POST', 'DELETE'],
        permission: 'admin.manage',
        note:
            'Granting / revoking one external auditor\'s access to one audit ' +
            'pack. assertCanManageAuditors admits OWNER+ADMIN only, which is ' +
            'the population admin.manage carries; audits.manage carries the ' +
            'same built-in roles but is the flag a tenant would grant an ' +
            'EDITOR-based custom role, which the ctx.role assert then refuses ' +
            'with no row — the hole this closes.',
    },
    // Step 3d (#3677) — internal audit's review of sampled workpapers. The
    // key decided in step 0e (`docs/agentic-iam-roadmap.md`, "Permission
    // keys"): audits.view, which every role holds, so an internal auditor on
    // the AUDITOR role (no audits.manage) is admitted. The usecase narrows
    // every verb to the ASSIGNED reviewer — a person, an ACTIVE third-line
    // member, not the auditor agent's owner — and audits each refusal.
    {
        path: new RegExp(`^${T}\\/audits\\/workpaper-reviews$`),
        methods: ['GET'],
        permission: 'audits.view',
        note:
            'Internal audit\'s queue of sampled workpapers (#3677). audits.view, ' +
            'held by every role, because an internal auditor is often an AUDITOR, ' +
            'which holds no audits.manage; listWorkpaperReviews returns every ' +
            'assignment read-only to internal audit (an ACTIVE third-line member who ' +
            'owns no auditor agent), only the caller\'s own to any other third-line ' +
            'member, and none to anybody else. Nothing here draws or assigns: the sweep does.',
    },
    {
        path: new RegExp(`^${T}\\/audits\\/workpaper-reviews\\/sample-rate$`),
        methods: ['PUT'],
        permission: 'audits.view',
        note:
            'Internal audit\'s sampling rate (#3677, owner decision 2026-10-19). The ' +
            'review page\'s key, because internal audit is often an AUDITOR and holds ' +
            'no admin key; setWorkpaperReviewSamplePercent admits only a person who is ' +
            'an ACTIVE third-line member and owns no auditor agent (403 + AUTHZ_DENIED ' +
            'with a named reason otherwise), and audits the change before and after. ' +
            'Ahead of the [^/]+ rule below, which would otherwise match this path.',
    },
    {
        path: new RegExp(`^${T}\\/audits\\/workpaper-reviews\\/[^/]+$`),
        methods: ['GET', 'POST'],
        permission: 'audits.view',
        note:
            'Reading and answering one sampled workpaper (#3677). Same key as the ' +
            'queue; the usecase admits only the assigned reviewer, a person, still ' +
            'ACTIVE and third-line, never the auditor agent\'s owner (403 + ' +
            'AUTHZ_DENIED with a named reason), and the answer is write-once.',
    },
    // Step 4d (#3681) — the agent-audit reliance pack. Assembling it freezes
    // it, so the key is the freeze population's, as for the auditor routes.
    {
        path: new RegExp(`^${T}\\/audits\\/cycles\\/[^/]+\\/reliance-pack$`),
        methods: ['POST'],
        permission: ['audits.manage', 'admin.manage'],
        mode: 'all',
        note:
            'Assembles and freezes the agent-audit reliance pack for one audit cycle: per ' +
            'control a library v1 procedure audits, the auditor agent\'s workpapers of the ' +
            'period, internal audit\'s sampling record of each and the agreement figures. ' +
            'audits.manage because it reads workpapers (the roadmap\'s key for that), and ' +
            'admin.manage because it freezes the pack and assertCanFreezePack admits ' +
            'OWNER+ADMIN by ctx.role, the population this key carries.',
    },
    {
        path: new RegExp(`^${T}\\/audits\\/auditors\\/[^/]+$`),
        methods: ['DELETE'],
        permission: 'admin.manage',
        note:
            'Account-level auditor revoke — REVOKED status plus every pack ' +
            'grant dropped in one call. Same assertCanManageAuditors, same ' +
            'admin.manage reasoning as the access sibling above. DELETE-only ' +
            'so the collection route one level up is untouched.',
    },
    {
        path: new RegExp(`^${T}\\/automation\\/rules\\/[^/]+$`),
        methods: ['PUT', 'PATCH', 'DELETE'],
        permission: 'admin.manage',
        note:
            'Archiving an automation rule silences a standing side-effect ' +
            'producer, and reconfiguring one redirects it. All three write ' +
            'verbs, not DELETE alone, because a gated DELETE beside an ungated ' +
            'PATCH is the mixed-module blind spot #2171 had to reopen seven ' +
            'files to close. assertCanManageAutomation reads ' +
            'ctx.permissions.canAdmin behind every one of them. GET is a ' +
            'canRead-tier read and stays at the usecase layer.',
    },
    {
        path: new RegExp(`^${T}\\/vendors\\/[^/]+\\/bundles\\/[^/]+$`),
        methods: ['POST', 'DELETE'],
        permission: 'vendors.edit',
        note:
            'Pulling an artefact out of a due-diligence bundle an auditor was ' +
            'pointed at, and the POST that adds one or FREEZES the bundle ' +
            'immutable. vendors.edit IS the flag assertCanManageVendorDocs ' +
            'reads behind both, so the caller set is provably unchanged. GET ' +
            'is a vendors.view read and stays at the usecase layer.',
    },
    {
        path: new RegExp(`^${T}\\/tests\\/runs\\/[^/]+\\/evidence\\/[^/]+$`),
        methods: ['DELETE'],
        permission: 'tests.execute',
        note:
            'Hard-deleting a control test run\'s evidence link, frozen hash and ' +
            'all. tests.execute IS the flag assertCanLinkTestEvidence reads, so ' +
            'route gate and usecase gate are the same predicate.',
    },

    // ── Business continuity + process maps, fifth tranche (#2197) ────
    // The residual the third tranche wrote down and could not take: these
    // gate on the coarse `assertCanWrite`, and `PermissionSet` had NO domain
    // whose population matched — so binding them to a neighbouring register's
    // flag would have changed the caller set for a reason unrelated to the
    // route. #2197 added the two missing domains instead.
    //
    // `continuity.edit` / `processes.edit` are defined TRUE for exactly
    // OWNER / ADMIN / EDITOR, which is `computePermissions(...).canWrite`
    // (role level >= 3) — the predicate `assertCanWrite` reads. So for every
    // built-in role, and for every stored custom role (whose blob predates the
    // domain and therefore inherits its baseRole default), the caller set is
    // unchanged and only the layer that RECORDS the refusal moves.
    //
    // The one population that does change is API keys: `appPermissions` for a
    // key comes from its scopes, not its role, so a key without a
    // `continuity:` / `processes:` scope no longer reaches these writes. That
    // is why both domains got scopes in the same diff — otherwise `*` would
    // have been the only grant that still worked.
    //
    // READS are deliberately NOT gated. `assertCanRead` is true for all five
    // roles and neither domain has a `view` flag, so there is no key to gate
    // them on; the `continuity` docstring in `@/lib/permissions` argues why.
    {
        path: new RegExp(`^${T}\\/business-continuity$`),
        methods: ['POST'],
        permission: 'continuity.edit',
        note:
            'Creating a Business Impact Analysis. Gated with its siblings so ' +
            'the register is wholly gated rather than half — every write verb ' +
            'on it reaches the same assertCanWrite. GET is a read and stays.',
    },
    {
        path: new RegExp(`^${T}\\/business-continuity\\/[^/]+$`),
        methods: ['PUT', 'DELETE'],
        permission: 'continuity.edit',
        note:
            'Deleting a whole Business Impact Analysis, and the PUT that ' +
            'rewrites one. Both verbs, not DELETE alone, so the module does ' +
            'not become the mixed shape #2171 reopened seven files to fix.',
    },
    {
        path: new RegExp(`^${T}\\/business-continuity\\/[^/]+\\/dependencies$`),
        methods: ['POST'],
        permission: 'continuity.edit',
        note:
            'Attaching a process / asset / vendor / risk dependency to a BIA — ' +
            'the edge the recovery-priority ranking is computed from.',
    },
    {
        path: new RegExp(`^${T}\\/business-continuity\\/[^/]+\\/dependencies\\/[^/]+$`),
        methods: ['DELETE'],
        permission: 'continuity.edit',
        note:
            'Detaching a BIA dependency — the destructive half of the pair ' +
            'above, and one of the three routes #2197 exists to close.',
    },
    {
        path: new RegExp(`^${T}\\/business-continuity\\/[^/]+\\/link-control$`),
        methods: ['POST'],
        permission: 'continuity.edit',
        note:
            'Linking a BIA to a control as continuity evidence — the edge that ' +
            'makes the control satisfy NIS2 Art.21(2)(c) in the coverage view.',
    },
    // ── The employee manager field (#2492) ──────────────────────────
    // `Employee.managerEmployeeId` had one writer, the HRIS sync, so a tenant
    // with no BambooHR/Workday feed could not give anyone a manager — and the
    // leaver mail therefore had no recipient on every disable. This is the
    // route that fixes that, and it is gated on the same key that creates the
    // employee row. Scoped to PUT and to the `/manager` leaf deliberately: the
    // /personnel collection route one level up is NOT covered by this map, and
    // widening this pattern to `personnel(\/.*)?` would claim coverage over
    // its `personnel.view` GET without gating it.
    {
        path: new RegExp(`^${T}\\/personnel\\/[^/]+\\/manager$`),
        methods: ['PUT'],
        permission: 'personnel.manage',
        note:
            'Setting or clearing one employee\'s manager — the same key ' +
            'createEmployee requires (OWNER + ADMIN), so the caller set is ' +
            'exactly the one that can already add the person. `status` is ' +
            'unreachable from this route by construction.',
    },
    {
        path: new RegExp(`^${T}\\/processes\\/[^/]+\\/snapshots\\/[^/]+\\/restore$`),
        methods: ['POST'],
        permission: 'processes.edit',
        note:
            'Rolling a process map back to an earlier snapshot — destructive ' +
            'because the CURRENT version is what it overwrites. processes.edit ' +
            'mirrors the assertCanWrite in restoreProcessMapSnapshot; the map ' +
            'DELETE stays on admin.manage, mirroring its own assertCanAdmin.',
    },
    // ── Access reviews (Step 5a) ─────────────────────────────────────
    // Every verb the campaign surface exposes, gated on the keys added to
    // `PermissionSet` in the same diff. The caller sets are UNCHANGED: see the
    // docblock on `access_reviews` in src/lib/permissions.ts for the mapping
    // from the old `assertCanRead`/`assertCanAdmin` pairs onto these four keys.
    //
    // ORDER IS LOAD-BEARING. `resolveRoutePermission` returns the FIRST rule
    // whose path matches, so each leaf below must precede the `[^/]+` detail
    // pattern that would otherwise swallow it — `/access-reviews/connected`
    // matches `^…/access-reviews/[^/]+$` perfectly well, and reaching the
    // detail rule first would gate a CREATE on a VIEW key.
    // ── Legacy reconciliation queue (Step 4b) ───────────────────────
    //
    // LEAVES FIRST. `resolveRoutePermission` returns the first rule whose path
    // matches, and while `^…/queue$` cannot swallow `…/queue/decide` today, a
    // later `^…/queue/[^/]+$` added above these would gate a WRITE on the VIEW
    // key. Ordering them this way makes that mistake impossible rather than
    // merely unlikely — the same reasoning the access-review block below states.
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/queue\\/decide$`),
        methods: ['POST'],
        permission: 'identity_reconciliation.confirm',
        note:
            'One reviewer decision. Durable: from then on the account resolves ' +
            'LINKED on every run and later steps act on it without anybody ' +
            'looking, so this follows access_reviews.close (OWNER + ADMIN) ' +
            'rather than .decide. Mirrors assertCanConfirmReconciliation, which ' +
            'reads the GRANULAR key so a custom role granting confirm over a ' +
            'READER base is not refused by the usecase after passing here.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/queue\\/bulk-confirm$`),
        methods: ['POST'],
        permission: 'identity_reconciliation.confirm',
        note:
            'Same key as a single decision — bulk is a convenience over the same ' +
            'path, not a weaker one. The narrowing that makes it safe is in the ' +
            'usecase: SUGGESTED rows only, above a margin derived from the ' +
            'scorer weights, capped, and re-checked row by row.',
    },
    {
        path: new RegExp(`^${T}\\/admin\\/legacy-access\\/queue$`),
        methods: ['GET'],
        permission: 'identity_reconciliation.view',
        note:
            'Reading the queue. The VIEW key rather than admin.manage: an ' +
            'auditor checking the queue is being worked needs exactly this, and ' +
            'a reviewer who may not decide may still need to see what is ' +
            'outstanding. Unlike the sibling mapping route, the response carries ' +
            'accounts and the engine evidence for them, not the customer schema.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/close$`),
        methods: ['POST'],
        permission: 'access_reviews.close',
        note:
            'Closing a campaign — executes REVOKE/MODIFY against live ' +
            'memberships, spawns deprovision tasks and seals the evidence ' +
            'PDF. Mirrors the assertCanAdmin in closeAccessReview and ' +
            'closeConnectedAccessReview: OWNER + ADMIN.',
    },
    {
        // BEFORE the decision pattern below, for readability rather than
        // necessity: `/decisions/X/revoke` cannot match
        // `^…/decisions/[^/]+$` because `[^/]+` admits no slash, so neither
        // swallows the other. Kept adjacent because they are one authority.
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/decisions\\/[^/]+\\/revoke$`),
        methods: ['POST'],
        permission: 'access_reviews.decide',
        note:
            'Resetting a recorded member verdict back to pending (#3269). The ' +
            'SAME key as recording, deliberately: revoking is the same authority ' +
            'as having been allowed to record, and the real narrowing is per ' +
            'CAMPAIGN — revokeDecision refuses anyone who is neither the assigned ' +
            'reviewer nor canAdmin. A narrower key here would read as a tightening ' +
            'while making a typo unfixable for exactly the non-admin reviewers the ' +
            'usecase exists for, returning them to the admin-plus-database path.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/decisions\\/[^/]+$`),
        methods: ['PUT'],
        permission: 'access_reviews.decide',
        note:
            'Recording a member verdict. The key is granted to all five ' +
            'roles because the real narrowing is per-CAMPAIGN, not per-role: ' +
            'submitDecision refuses anyone who is neither the assigned ' +
            'reviewer nor canAdmin, and that rule stays in the usecase.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/connected-decisions\\/[^/]+$`),
        methods: ['POST'],
        permission: 'access_reviews.decide',
        note:
            'Recording a connected-app verdict — same key and same reasoning ' +
            'as the member verdict above; submitConnectedDecision keeps the ' +
            'identical assigned-reviewer-or-admin refusal.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/connected-decisions$`),
        methods: ['GET'],
        permission: 'access_reviews.view',
        note:
            'Listing the frozen connected subjects and their verdicts. ' +
            'Mirrors the assertCanRead in listConnectedDecisions: all five ' +
            'roles, which is what reading a campaign has always required.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/evidence\\/regenerate$`),
        methods: ['POST'],
        permission: 'access_reviews.close',
        note:
            'Producing a CLOSED member campaign\'s evidence PDF again when it ' +
            'failed at close (#4130). The second half of closing, so the close ' +
            'key: OWNER + ADMIN, mirroring the assertCanAdmin in ' +
            'regenerateAccessReviewEvidence. It executes no decision.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/evidence$`),
        methods: ['GET'],
        permission: 'access_reviews.view',
        note:
            'Downloading the campaign evidence PDF. Read-shaped, so it ' +
            'carries the read key — it is the only access-review route that ' +
            'already asserted inline (assertCanRead), and the caller set is ' +
            'unchanged.',
    },
    // ── Agent recertification (step 3a, #3674) ────────────────────────
    // The roadmap's permission table: the existing access-review keys. Each
    // leaf precedes the `[^/]+` detail rule below for the ordering reason above.
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/agent-packs$`),
        methods: ['GET'],
        permission: 'access_reviews.view',
        note:
            'Reading an AGENT campaign\'s reviewer packs, narrowings, sample and ' +
            'recomputed evidence hash. Every role holds the key and a pack is ' +
            'register data, so getAgentReviewPacks narrows the read to the ' +
            'campaign\'s reviewer or a holder of admin.agent_registry.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/agent-packs$`),
        methods: ['POST'],
        permission: 'access_reviews.create',
        note:
            'Preparing an AGENT campaign\'s packs through the read-only pack ' +
            'workflow — the second half of creating it. Mirrors the ' +
            'assertCanAdmin in prepareAgentReviewPacks: OWNER + ADMIN.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/agent-narrowings\\/[^/]+$`),
        methods: ['POST'],
        permission: 'access_reviews.decide',
        note:
            'Accepting or rejecting a narrowing. Accepting deletes a grant, which ' +
            'only narrows, so it does not also need admin.agent_tool_exposure. ' +
            'decideAgentNarrowing keeps the assigned-reviewer-or-admin rule and ' +
            'refuses the agent\'s owner.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+\\/agent-samples\\/[^/]+$`),
        methods: ['POST'],
        permission: 'access_reviews.decide',
        note:
            'The second human\'s answer to a sampled agent decision — the key a ' +
            'first verdict takes. The usecase admits only a reader of the pack ' +
            '(reviewer or admin.agent_registry) who neither made the decision ' +
            'nor owns the agent.',
    },
    {
        // BEFORE the `[^/]+` detail rule below — see the ordering note above.
        path: new RegExp(`^${T}\\/access-reviews\\/agents$`),
        methods: ['POST'],
        permission: 'access_reviews.create',
        note:
            'Creating an AGENT campaign over the registered agents. Mirrors ' +
            'the assertCanAdmin in createAgentAccessReview: OWNER + ADMIN.',
    },
    {
        // BEFORE the `[^/]+` detail rule below — see the ordering note above.
        path: new RegExp(`^${T}\\/access-reviews\\/connected$`),
        methods: ['POST'],
        permission: 'access_reviews.create',
        note:
            'Creating a CONNECTED_APP campaign over a synced directory. ' +
            'Mirrors the assertCanAdmin in createConnectedAccessReview: ' +
            'OWNER + ADMIN.',
    },
    {
        // BEFORE the `[^/]+` detail rule below — see the ordering note above.
        path: new RegExp(`^${T}\\/access-reviews\\/legacy$`),
        methods: ['POST'],
        permission: 'access_reviews.create',
        note:
            'Creating a LEGACY_APP campaign from one legacy application\'s ' +
            'reconciled snapshot. Mirrors the assertCanAdmin in ' +
            'createLegacyAccessReview: OWNER + ADMIN.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+$`),
        methods: ['GET'],
        permission: 'access_reviews.view',
        note:
            'Reading one campaign and its activity. Mirrors the ' +
            'assertCanRead in getAccessReview / getAccessReviewWithActivity.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews\\/[^/]+$`),
        methods: ['PATCH'],
        permission: 'access_reviews.create',
        note:
            'Changing an open campaign\'s reviewer or due date (#4130), and ' +
            'nothing else. The key that names them at creation: OWNER + ADMIN, ' +
            'mirroring the assertCanAdmin in updateAccessReviewSettings. After ' +
            'every leaf above, like the GET: `[^/]+$` would swallow ' +
            '`/connected`, `/agents` and `/legacy`, whose only method is POST.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews$`),
        methods: ['GET'],
        permission: 'access_reviews.view',
        note: 'Listing campaigns. Mirrors the assertCanRead in listAccessReviews.',
    },
    {
        path: new RegExp(`^${T}\\/access-reviews$`),
        methods: ['POST'],
        permission: 'access_reviews.create',
        note:
            'Creating a member-scope campaign. Mirrors the assertCanAdmin ' +
            'in createAccessReview: OWNER + ADMIN.',
    },
    {
        // The in-product assistant. Both surfaces take the SAME key, and the
        // reason is worth stating: proposing is safe at reader level because a
        // proposal lands in the review queue as PENDING and creates nothing —
        // the route's own docblock makes that argument. So the gate is about
        // what the assistant may READ, which is `controls.view`.
        //
        // The streaming route must MATCH this, never loosen it: a transport
        // that is easier to reach than the POST it mirrors would be a privilege
        // escalation introduced by a change of transport.
        path: new RegExp(`^${T}\\/assistant\\/ask$`),
        methods: ['POST'],
        permission: 'controls.view',
        note:
            'Asks the assistant and returns a finished answer. Reader-level '
            + 'because every action it can take is queued as an agent-proposal '
            + 'for human approval, never committed.',
    },
    {
        path: new RegExp(`^${T}\\/assistant\\/stream$`),
        methods: ['POST'],
        permission: 'controls.view',
        note:
            'The same turn as /assistant/ask, streamed as SSE. Same key by '
            + 'design — see the note above; a streaming transport grants no '
            + 'additional read.',
    },
    {
        // Asking the workspace a question (#3869). SAME KEY as the assistant
        // above, and the argument for reader level is strictly stronger here:
        // `ad-hoc-question` declares `readOnly: true`, so the run is offered no
        // propose surface at all — where the assistant's note has to argue that
        // a proposal is harmless because it only queues, this one has nothing
        // to queue. ADR 0004 determined by test that the answer cannot reach
        // data the asker could not reach through the UI.
        //
        // An admin key here would be wrong rather than merely strict: it would
        // make the feature admin-only to guard against something that cannot
        // happen.
        path: new RegExp(`^${T}\\/agents\\/questions$`),
        methods: ['POST'],
        permission: 'controls.view',
        note:
            'Starts a read-only agent run that answers a typed question. '
            + 'Reader-level because the workflow withholds the propose surface '
            + 'entirely and the answer is bounded by the asker\'s own '
            + 'permissions.',
    },
    {
        // The result read. The ROUTE key is not the whole gate: the usecase
        // narrows to the asker's own directly-started runs unless the caller
        // holds the agent-inventory key. A route-level key cannot express "your
        // own row", so the row rule lives in the WHERE clause.
        path: new RegExp(`^${T}\\/agents\\/questions\\/[^/]+$`),
        methods: ['GET'],
        permission: 'controls.view',
        note:
            'Reads one question run: answer, ordered tool calls with outcome, '
            + 'model, token cost, and whether the catalogue was empty. Narrowed '
            + 'again in the usecase to the asker\'s own run, or any run for an '
            + 'agent-inventory reader.',
    },
] as const;

// ─── Resolver ───────────────────────────────────────────────────────

export interface ResolvedRoutePermission {
    rule: RoutePermissionRule;
    permission: PermissionKey | readonly PermissionKey[];
    mode: PermissionMode;
}

/**
 * Look up the permission rule that applies to a request path + method.
 * Returns `null` for routes the map doesn't cover — callers decide
 * whether to fall back to legacy guards (Epic C.1 scope) or to fail
 * closed (a future Epic C.3 enforcement-by-default mode).
 */
export function resolveRoutePermission(
    pathname: string,
    method: string,
): ResolvedRoutePermission | null {
    const upperMethod = method.toUpperCase() as HttpMethod;
    for (const rule of ROUTE_PERMISSIONS) {
        if (!rule.path.test(pathname)) continue;
        if (rule.methods && !rule.methods.includes(upperMethod)) {
            continue;
        }
        return {
            rule,
            permission: rule.permission,
            mode: rule.mode ?? 'all',
        };
    }
    return null;
}

/**
 * Quick membership test for guard / coverage tests. True iff the path
 * matches at least one rule (regardless of method).
 */
export function isRouteCovered(pathname: string): boolean {
    return ROUTE_PERMISSIONS.some((r) => r.path.test(pathname));
}
