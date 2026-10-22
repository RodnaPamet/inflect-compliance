/**
 * EVERY AGENTIC ROUTE HAS SOMETHING THAT LINKS TO IT.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * The agent DETAIL page shipped with no inbound link at all: `grep -rn
 * 'admin/agents/\${' src/` returned only the page's own docstring, so the
 * policy card, the tool pins, the ASI coverage, the circuit breaker and the
 * kill switch were reachable by typing a URL and by nothing else. The ASI09
 * review-quality report shipped the same way, and stayed that way for longer
 * because it also had no permission gate and no behavioural test — the exact
 * combination.
 *
 * A route with no inbound link is not a feature with a discoverability problem.
 * It is a feature nobody can use, and it looks identical in CI to one that
 * works.
 *
 * ── WHAT COUNTS AS AN INBOUND LINK ──────────────────────────────────────────
 *
 * Four kinds, and the list is deliberately not "any occurrence of the path":
 *
 *   · a NAV SECTION entry (`SidebarNav`)
 *   · a HUB CARD or in-page link (`href={…}` / `tenantHref('…')`)
 *   · a COMMAND PALETTE entry
 *   · a ROW ACTION (`router.push('…')` from a table row)
 *
 * The ViewsMenu satisfies four of the five children on its own, which is the
 * point of folding them into one menu rather than five scattered links.
 *
 * ── WHAT IS DELIBERATELY NOT COUNTED ────────────────────────────────────────
 *
 * A route's OWN files. A page that names its own path in a docstring, a
 * breadcrumb or a `redirect()` is not linked from anywhere — and a scan that
 * accepted self-references would have passed the detail page on the strength of
 * the very docstring that recorded its unreachability.
 *
 * A REDIRECT SHIM's target also does not count as that shim being linked: the
 * shims exist for bookmarks, and requiring an inbound link to a compatibility
 * path would mean linking users at the slow way round. They are excluded by
 * name, with the reason.
 *
 * Population from `repoFiles()` — git's own file list — never a `readdirSync`
 * walk. `tests/guardrails/source-scan-population.test.ts` has no allowlist.
 *
 * ── AND THE POPULATION ITSELF IS PINNED ───────────────────────────────────
 *
 * Two registries live here, and the second half of the file asserts each is a
 * complete census rather than a sample: `AGENTIC_ROUTES` (+ `REDIRECT_SHIMS`)
 * for the pages, `AGENTIC_API_ROUTES` for the routes under `src/app/api/`.
 * Neither can grow without somebody writing the new entry down, which is what
 * makes "this phase ships no new surface" a claim CI can refuse rather than
 * one a plan can only assert. See
 * `docs/implementation-notes/2026-09-23-phase1-surface-reconciliation.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const APP = 'src/app/t/[tenantSlug]/(app)';
const API = 'src/app/api';

/**
 * The repo root, computed HERE rather than imported. A guard that reads source
 * must fold its own root constant; an imported one lands every assertion below
 * in the un-analysable set.
 */
function repoRoot(): string {
    return path.resolve(__dirname, '../..');
}

/**
 * The agentic routes under `(app)/`, as a user types them.
 *
 * Written out rather than derived from the directory tree, and that is the
 * whole design of this guard: a derived list would grow silently when somebody
 * added an unreachable page, which is precisely the event it exists to catch.
 * A new agentic route fails the completeness check below until it is added
 * here AND linked from somewhere.
 */
const AGENTIC_ROUTES: readonly string[] = [
    '/agents',
    '/agents/[agentId]',
    '/agents/proposals',
    '/agents/runs',
    '/agents/runs/[runId]',
    '/agents/receipts',
    '/agents/quarantine',
    '/agents/review-quality',
    '/agents/reports',
    // The EU AI Act record, readable. Linked from the Views menu's Assurance
    // group beside the other read-only surfaces.
    '/agents/decisions',
    // #3124 — a tool's SAVED ARGUMENTS and the approval a change to one needs.
    // Linked from the external-tool catalogue page rather than the Views menu,
    // because a set is scoped to a tool on a connection and the catalogue is
    // where that connection is already selected — the placement the
    // external-write ladder already uses. The route it drives shipped in #2906
    // and had no caller of any kind until this page, which is the state this
    // guard exists to refuse.
    '/agents/parameter-sets',
    // The external-tool catalogue: approve a definition, grant it to an agent.
    // Linked from the Views menu's OPERATE group, because both are acts
    // somebody performs rather than a record they audit. Gated on
    // `admin.agent_registry` like its siblings — and unreachable by any API
    // key, since that flag is subtracted from even a `*` credential.
    '/agents/external-tools',
    // #3301 — the one surface that accepts an INTENT rather than reviewing
    // output. Linked from the Views menu's OPERATE group, beside the other
    // two acts somebody performs: an operator fills an approved template's
    // open fields and gets a proposal, never a dispatch. `admin.view` to see
    // it and `canWrite` to submit — the lower bar of the two deliberately,
    // because requiring approve-authority to compose would turn four eyes
    // into two.
    '/agents/compose',
    // #3679 — A2A peers and the tenant's own signing key. Linked from the
    // Views menu's ASSURANCE group beside external tools; a peer's own page is
    // linked from the list's rows.
    '/agents/peers',
    '/agents/peers/[peerId]',
    // #3807 — the owner-orphan pass's mode and its recorded passes. Linked from
    // the Views menu's OPERATE group for an OWNER, the only role its route
    // admits (`admin.tenant_lifecycle`).
    '/agents/owner-orphan-pass',
    // #3807 — the pilot auditor's set-up (step 3c). Linked from the Views
    // menu's ASSURANCE group for a holder of `admin.agent_registry`, its key.
    '/agents/audit-pilot',
    // #3870 — ASK, the asking surface. Linked from the SIDEBAR rather than the
    // Views menu, and that is the point of the difference: it is the only
    // agentic page gated on a content key (`controls.view`) rather than an
    // admin one, so the Views menu — which lives on admin-gated pages — would
    // have been an inbound link its own audience could never follow.
    '/agents/ask',
] as const;

/**
 * Compatibility shims. Present as routes, deliberately UNLINKED.
 *
 * Each is a `redirect()` one-liner kept for bookmarks and for the old
 * `/admin/mcp` hub cards' outbound links. Linking to one would send a user the
 * long way round to a page the product can reach directly.
 */
const REDIRECT_SHIMS: readonly string[] = [
    '/admin/agents',
    '/admin/agents/[agentId]',
    '/admin/agents/review-quality',
    '/admin/mcp/agent-receipts',
    '/admin/mcp/quarantine',
    '/agent-proposals',
    '/agent-runs',
] as const;

/**
 * WHAT COUNTS AS THE AGENTIC SURFACE — one definition, used by both halves.
 *
 * Widening this widens the page population AND the API population together. A
 * needle that drifted between them would leave a gap exactly where the two
 * meet, which is where a page and the route it calls land in the same PR.
 */
const IS_AGENTIC = /agent|mcp/i;

/**
 * The agentic API surface, as route files under `src/app/api/`.
 *
 * ── WHY THIS LIST EXISTS ────────────────────────────────────────
 *
 * The Flue integration plan's point 01 says of phase 1: "Nothing else — phase
 * 1 ships no new surface." Phase 1 then shipped two agentic API routes
 * (`admin/agent-driver`, `agent-proposals/bulk/reject`), each compelled by a
 * later plan bullet and neither contradicted by anything that could go red.
 *
 * The PAGE half of that claim was already enforced: the completeness check
 * below refuses a new `(app)/agents/*` page until somebody writes it down.
 * The API half had nothing of the kind. What a new route DID hit was
 * `tests/contracts/api-schemas.test.ts` — and that is a CHECKSUM, not a
 * registry: the route walker publishes every route as a stub, so regenerating
 * `public/openapi.json` turns the red green without anybody deciding that new
 * agentic surface was intended. A checksum notices an addition; it cannot
 * refuse one.
 *
 * So this list is the decision seam. A route added here is a route someone
 * declared to be agentic surface, in the same file as the pages, where a claim
 * that a phase ships none of it is visibly contradicted.
 *
 * Paths are relative to `src/app/api/`, which is why the untenanted (`mcp/`)
 * and platform (`admin/agent-kill-switch`) routes sit beside the per-tenant
 * ones: the surface is what is CALLABLE, not what is tenant-scoped.
 */
const AGENTIC_API_ROUTES: readonly string[] = [
    // Platform scope — no tenant, behind PLATFORM_ADMIN_API_KEY.
    'admin/agent-kill-switch/route.ts',
    // The MCP transport itself, and the credential exchange in front of it.
    'mcp/route.ts',
    'mcp/token/route.ts',
    // A SECOND MCP server, and the reason it is second rather than two more
    // tools on the first (#3297). `mcp/route.ts` is AGENT-FACING: an agent
    // authenticated there calls `tools/call` and the tool executes. The grant's
    // rails — template and bounds approval, the population re-resolved at send,
    // the PENDING journal row, the prior-state pairing — all live on the
    // OUTBOUND path in `external-write-dispatch`, so a grant tool on the
    // agent-facing server would be a grant tool with the rails stripped off.
    //
    // This endpoint's only intended client is our own dispatch, reaching it
    // over HTTPS because `safeFetch` refuses loopback. An agent arrives only
    // through the external-tools funnel, which is the door with the approval
    // machinery behind it. OWNER-only (`admin.tenant_lifecycle`), two tools,
    // and the tenant is authenticated from the path rather than asserted in an
    // argument.
    'mcp/entra-grant/route.ts',
    // #3671, agentic IAM 2c — the grant endpoint's SIBLING for disabling a
    // contained agent's Entra service principal: `disable_service_principal`
    // and its paired prior-state read. Outbound for the same reason the grant
    // is: its only intended client is the external-write dispatch, which holds
    // the rung, the pairing and the journal row. A sibling rather than two more
    // tools on the grant endpoint because the rung is per CONNECTION, and the
    // disable must climb its own ladder; the route refuses a token whose
    // connection is configured for a different endpoint. No page: the orphan
    // pass is its only requester, through the ladder.
    'mcp/entra-service-principal/route.ts',
    // PHASE 1, point 01's third bullet — the per-tenant driver toggle. The
    // column shipped with a reader, a default and no writer; a gate whose
    // customer half cannot be moved through the product is a constant wearing
    // a switch's name. The NOTE that used to sit here — "no page calls this
    // route today, so it is API surface without a user-facing page" — is now
    // STALE: `FlueEngineCard` on Admin → Integrations reads the wiring state
    // and PUTs this route's mode. It stayed true for as long as it did
    // because a toggle that is one of SIX terms tells an operator almost
    // nothing on its own, so there was nothing coherent to put on a page
    // until the other five could be shown beside it.
    // #3330 — mints the grant endpoint's bearer token. Discovered by
    // IS_AGENTIC because the path carries "mcp", and genuinely agentic: the
    // credential it issues is the one our own dispatch presents to the grant
    // endpoint. OWNER-only, and a sibling of admin/integrations rather than
    // nested under it, for the first-match-wins reason its own note gives.
    't/[tenantSlug]/admin/mcp-server-token/[connectionId]/route.ts',
    't/[tenantSlug]/admin/agent-driver/route.ts',
    // The read half of that card: which of the six terms are satisfied and
    // which one blocks. Read-only, same tenant-lifecycle key.
    't/[tenantSlug]/admin/flue-wiring/route.ts',
    // #3484 — the SECOND capacity axis beside the monthly token budget. The
    // budget bounds spend over a month and cannot express simultaneity, so a
    // tenant inside its budget could start runs until the shared worker pool
    // was the limit.
    't/[tenantSlug]/admin/agents/concurrency/route.ts',
    // #3777 — the FIRST capacity axis, the monthly token budget, which had a
    // reader and no writer. Set beside the cap on the register page.
    't/[tenantSlug]/admin/agents/budget/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/circuit-breaker/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/coverage/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/policy-card/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/risk-assessment/complete/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/risk-assessment/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/status/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/tools/route.ts',
    // #3698 — the two-step agent ownership transfer. API-only until its panel on
    // the agent overview ships (propose, the pending banner, accept or decline
    // for the person named). It is the ONLY way an agent's owner moves after
    // registration: the register's PATCH refuses `ownerUserId`.
    't/[tenantSlug]/admin/agents/[agentId]/ownership-transfer/complete/route.ts',
    't/[tenantSlug]/admin/agents/[agentId]/ownership-transfer/route.ts',
    // #3671 (2c) — a person confirms which discovered Entra service principal
    // is the agent's own, the condition for an UNATTENDED disable of it (owner
    // decision, 2026-10-18). API-only like the transfer: the confirmation is
    // read and made by an operator holding admin.agent_registry, and no page
    // drives it yet.
    't/[tenantSlug]/admin/agents/[agentId]/service-principal-link/route.ts',
    't/[tenantSlug]/admin/agents/kill-switch/route.ts',
    // #3670 — the owner-orphan pass's mode and its recorded passes. API-only
    // until a page renders them, like the ownership transfer it hands its
    // orphans to; the pass itself runs on a schedule and needs no page to act.
    't/[tenantSlug]/admin/agents/owner-orphan-pass/route.ts',
    // #3676 / #3807 — the pilot auditor's set-up, run as the signed-in owner:
    // a dry run, then the writes, through the usecases the product already
    // has. The `/agents/audit-pilot` page calls it; `scripts/audit-pilot-setup.ts`
    // calls the same usecase from the command line.
    't/[tenantSlug]/admin/agents/audit-pilot/route.ts',
    // #3669 — the registration intake: a SHADOW_AGENT finding becomes a DRAFT
    // register row through a provisional UNCLASSIFIED AI-system entry. Since
    // #3712 the harness tab's shadow list calls it: each shadow row carries its
    // finding id, and the Register dialog reads the owner picker's ACTIVE
    // roster and the vendor list itself. The describe at the end of this file
    // pins the caller.
    't/[tenantSlug]/admin/agents/intake/route.ts',
    // #3665 — the harness ingest. `harness-scans` is MACHINE surface: a
    // scanner POSTs a signed report with an API key scoped to
    // `admin:harness_ingest` and nothing else, so no page calls it and none
    // should — the harness tab reads scans server-side through the usecases.
    // The other three are the register's half, and since #3687 the harness
    // tab on `/agents/reports` calls them: POST `harness-acceptances` (the
    // owner's accept and renew), POST `harness-scanner-keys` (register a key)
    // and DELETE `harness-scanner-keys/[keyId]` (revoke one). Their GETs stay
    // API surface, because the tab reads the same rows server-side. The
    // describe at the end of this file pins both halves of that.
    't/[tenantSlug]/admin/agents/harness-acceptances/route.ts',
    // #3678 — client estates. API-only in step 4a: the owner schedules the
    // client estates when 0e names them, an operator declares each one, and the
    // harness tab reads the health server-side through the usecase, as it reads
    // the scans.
    't/[tenantSlug]/admin/agents/harness-estates/[estateId]/route.ts',
    't/[tenantSlug]/admin/agents/harness-estates/route.ts',
    't/[tenantSlug]/admin/agents/harness-scanner-keys/[keyId]/route.ts',
    't/[tenantSlug]/admin/agents/harness-scanner-keys/route.ts',
    't/[tenantSlug]/admin/agents/harness-scans/route.ts',
    // #3673 — the A2A peer register and card pinning. API-only in step 2e,
    // which builds the record and the pin and no exchange: the pilot peer is
    // registered and pinned by an operator, and a page belongs with the
    // traffic it would govern (4b).
    't/[tenantSlug]/admin/agents/peers/[peerId]/card/approve/route.ts',
    't/[tenantSlug]/admin/agents/peers/[peerId]/card/route.ts',
    't/[tenantSlug]/admin/agents/peers/[peerId]/route.ts',
    't/[tenantSlug]/admin/agents/peers/route.ts',
    // #3679 — A2A messaging: an operator issues the peer's inbound credential,
    // engages or lifts a kill on it, and reads the signed receipts, from the
    // peer page at /agents/peers/[peerId]; the tenant's own signing key is read
    // and rotated from /agents/peers.
    't/[tenantSlug]/admin/agents/a2a-signing-key/route.ts',
    // #3742 — the tenant's published A2A agent card, untenanted under `/api/a2a`
    // beside the inbound endpoints it names. A PEER reads it, not a page: it is
    // fetched to be pinned, before the peer holds a credential, and the
    // operator meets its URL on the peer page as the identity it hands over.
    'a2a/[tenantSlug]/agent-card.json/route.ts',
    // #3862 — the HOST-CONSUMER card, at the two well-known filenames a host
    // composes from the per-tenant base. Also read by a machine rather than a
    // page, and by one that has never talked to us: SAP's Joule toolkit asks
    // for `agent.json`, the current spec for `agent-card.json`, and both serve
    // the same bytes. The operator meets neither URL on a page — a host
    // consumer is configured from the admin host-consumers surface, which
    // hands over the base URL that these hang off.
    'a2a/[tenantSlug]/.well-known/agent.json/route.ts',
    'a2a/[tenantSlug]/.well-known/agent-card.json/route.ts',
    't/[tenantSlug]/admin/agents/peers/[peerId]/inbound-credential/route.ts',
    't/[tenantSlug]/admin/agents/peers/[peerId]/kill/route.ts',
    't/[tenantSlug]/admin/agents/peers/[peerId]/messages/route.ts',
    't/[tenantSlug]/admin/agents/reports/export/route.ts',
    't/[tenantSlug]/admin/agents/reports/route.ts',
    't/[tenantSlug]/admin/agents/review-quality/route.ts',
    't/[tenantSlug]/admin/agents/route.ts',
    // #3470 — the Flue skill corpus behind the Skills tab. Tenant-scoped
    // but not tenant-specific: the six documents ship with the product and
    // are identical everywhere. It is gated because WHO MAY SEE what an
    // agent is taught is a tenant question, and the list exists to answer
    // "what did the agent know" for an assessor.
    't/[tenantSlug]/admin/agents/skills/route.ts',
    // #3680 — tenant-authored skills, driven by the Skills tab's workspace
    // section for holders of admin.agent_skill_review.
    't/[tenantSlug]/admin/agents/skills/tenant/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/versions/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/versions/[versionId]/approve/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/versions/[versionId]/evaluation/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/versions/[versionId]/reject/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/versions/[versionId]/retire/route.ts',
    't/[tenantSlug]/admin/agents/skills/tenant/[skillId]/versions/[versionId]/submit/route.ts',
    't/[tenantSlug]/admin/agents/tool-manifests/route.ts',
    // #2860 — saved arguments for an external MCP tool, and the approval a
    // change to one needs. Same tenant-wide class as the manifest pin above:
    // a set is keyed by (tenant, tool, label) and not by agent, so it governs
    // every agent granted that tool.
    't/[tenantSlug]/admin/agents/parameter-sets/route.ts',
    // #3051 step 5b — ONE human's signature on a proposed edit to a bounded
    // template, which is a third privileged act beside propose and approve and
    // so gets its own path rather than a discriminator in a shared body. It
    // promotes nothing: the database refuses the promotion until two
    // signatures from humans other than the proposer are on file.
    't/[tenantSlug]/admin/agents/parameter-sets/signatures/route.ts',
    // An external server's catalogue and the approval that makes one of its
    // tools grantable. Under /admin/agents rather than /admin/integrations
    // because accepting a tool DESCRIPTION is agent governance, not credential
    // wiring — and that placement is what earns it admin.agent_registry.
    't/[tenantSlug]/admin/agents/external-tools/route.ts',
    // #2912 — the Entra consent flow for an MCP server connection. The start
    // is tenant-scoped and admin-gated; the callback is tenant-AGNOSTIC because
    // one registered redirect URI serves every tenant, and it re-authorises
    // through getTenantCtx rather than trusting the URL it was called with.
    't/[tenantSlug]/admin/integrations/[connectionId]/mcp-consent/route.ts',
    'integrations/mcp-server/callback/route.ts',
    't/[tenantSlug]/admin/mcp/quarantine/route.ts',
    't/[tenantSlug]/admin/security-settings/agent-enforcement/route.ts',
    't/[tenantSlug]/agent-proposals/[id]/approve/route.ts',
    't/[tenantSlug]/agent-proposals/[id]/reject/route.ts',
    // PHASE 1, point 03 — bulk reject on the review queue. A queue too slow to
    // clear is a queue people stop reading, which is the automation-bias
    // problem the queue exists to resist arriving from the other side.
    't/[tenantSlug]/agent-proposals/bulk/reject/route.ts',
    't/[tenantSlug]/agent-proposals/route.ts',

    // #3301 — the intent surface. A human fills an approved template's open

    // fields and gets a PROPOSAL, never a dispatch, so it belongs beside the

    // queue it feeds rather than on a sibling path that would imply a second

    // kind of proposal. Authorization is the usecase's `assertCanWrite` —

    // deliberately the LOWER bar, because requiring approve-authority to

    // compose would turn four eyes into two.

    't/[tenantSlug]/agent-proposals/compose/route.ts',
    // REMOVED 2026-10-14 (#3528): the TYPED-PHRASE compose route. The intent
    // layer behind it had never run in production — `AI_LOCAL_BASE_URL` was
    // never set, so every call refused `LOCAL_GATEWAY_NOT_CONFIGURED` — and the
    // owner retired it rather than stand up a gateway for it. The form-driven
    // sibling above is the live path and is unchanged.
    't/[tenantSlug]/agent-proposals/sample-audits/[id]/route.ts',
    't/[tenantSlug]/agent-proposals/sample-audits/route.ts',
    't/[tenantSlug]/agent-receipts/[id]/export/route.ts',
    't/[tenantSlug]/agent-receipts/route.ts',
    't/[tenantSlug]/agent-runs/[id]/abort/route.ts',
    't/[tenantSlug]/agent-runs/[id]/resume/route.ts',
    't/[tenantSlug]/agent-runs/[id]/route.ts',
    // #3472 — REPLAY, in two shapes, beside the unpaged `[id]/route.ts` rather
    // than replacing it.
    //
    // `[id]/route.ts` returns the run with EVERY step, which is what the
    // server-rendered timeline wants and what a canvas scrubber must not ask
    // for. `steps` is the bounded page, cursor-exact over an append-only
    // ledger; `stream` is the live tail of the same projection for a run that
    // can still produce steps.
    //
    // `stream` is the second `text/event-stream` route in the app and the only
    // one under `/api/t/`. It polls the ledger rather than subscribing to the
    // in-process bus the notification bell uses, because a Flue run executes in
    // the BullMQ WORKER and this is served by the WEB tier — a bus here would
    // see nothing a run ever wrote.
    // #3472 — what the agent nodes on a process canvas are doing. Agentic
    // surface because it follows `WorkflowRun.parentExecutionId` (#3537) into
    // the run ledger; a SIBLING of `executions/live` rather than a widening of
    // it, because `MonitorTab` reads that response too and would carry a
    // payload it discards on every poll.
    't/[tenantSlug]/automation/executions/agent-runs/route.ts',
    't/[tenantSlug]/agent-runs/[id]/steps/route.ts',
    't/[tenantSlug]/agent-runs/[id]/stream/route.ts',
    // #3472 — one run's OPEN HUMAN CHECKPOINT: the PENDING proposals it
    // queued, each with a server-computed diff, for the canvas's inline
    // approve/reject. Agentic surface because it reads the proposal queue
    // through a run.
    //
    // A READ, and the only route in this family whose gate is load-bearing
    // rather than documentary: a proposal diff carries the current values of a
    // risk, control, policy or finding, so it takes `/agents/proposals`' own
    // `admin.view`. The DECISION is not here — it posts to the proposals
    // routes, which is the plan's "no second approval path" — and
    // `vr6-execution-overlay` asserts this file exports GET and nothing else.
    't/[tenantSlug]/agent-runs/[id]/checkpoint/route.ts',
    't/[tenantSlug]/agent-runs/route.ts',
    // #3674 (step 3a) — agent recertification. An access review whose subjects
    // are registered agents, driven from the access-review detail page
    // (`AccessReviewDetailClient` / `AccessReviewsClient`), not from `/agents`:
    // create, prepare the reviewer packs through the read-only pack workflow,
    // decide a narrowing (an ACCEPT deletes one grant — the only authority
    // change a campaign makes), and the second person's answer to a sampled
    // decision. Keys are the existing access-review ones the roadmap names.
    't/[tenantSlug]/access-reviews/agents/route.ts',
    't/[tenantSlug]/access-reviews/[reviewId]/agent-packs/route.ts',
    't/[tenantSlug]/access-reviews/[reviewId]/agent-narrowings/[narrowingId]/route.ts',
    't/[tenantSlug]/access-reviews/[reviewId]/agent-samples/[sampleId]/route.ts',
    // #3869 — asking the workspace a question, and reading what came back. The
    // only agentic routes NOT under `admin/`, and deliberately so: ADR 0004
    // determined by test that the answer cannot reach data the asker could not
    // reach through the UI, so the feature is reader-level (`controls.view`,
    // the assistant's key) rather than admin-only. Putting them under `admin/`
    // would also put them behind the edge gate, which refuses any session whose
    // built-in role in the tenant is not ADMIN or OWNER — i.e. it would refuse
    // every person the feature exists for.
    //
    // API-only for now: M3 (#3870) is the asking surface.
    't/[tenantSlug]/agents/questions/route.ts',
    't/[tenantSlug]/agents/questions/[runId]/route.ts',
] as const;

/** Every `.ts`/`.tsx` file under `src/`, comment-stripped, by repo-relative path. */
const SOURCES: ReadonlyArray<{ rel: string; code: string }> = repoFiles({
    under: 'src',
    extensions: ['.ts', '.tsx'],
}).map((abs) => ({
    rel: repoRelative(abs),
    // COMMENTS STRIPPED. A docstring naming a path is the exact evidence the
    // detail page's unreachability was recorded in, so prose must not count as
    // a link.
    code: codeOf(fs.readFileSync(abs, 'utf8')),
}));

/**
 * The directory a route's own files live in — the self-reference exclusion.
 *
 * `/agents/[agentId]` lives under `(app)/agents/[agentId]/`, so the register's
 * own `AgentsClient.tsx` is NOT self and DOES count as the inbound link. That
 * asymmetry is deliberate: the register linking to the detail page is exactly
 * the fix #2422 landed.
 */
function ownDir(route: string): string {
    return `${APP}${route}/`;
}

/**
 * Files that NAME a route without linking to it, and must not count.
 *
 * This exclusion is the difference between a guard and a grep, and leaving it
 * out was measured: with `src/lib/nav/**` in the population, DELETING the
 * review-quality entry from the ViewsMenu left the route still "linked" — by
 * `page-segregation.ts` and `canonical-parents.ts`, which are DECLARATIVE
 * REGISTRIES. Every route in the product is listed in both by construction, so
 * they make the inbound-link question unanswerable: the guard would go green
 * for a page with no way in, which is the one thing it exists to refuse.
 *
 * The redirect shims are excluded for the sibling reason: each one's
 * `redirect()` names its target, so a shim would vouch for the page it forwards
 * to. A shim is a bookmark's landing, not a route into the product.
 */
const NOT_A_LINK: readonly string[] = [
    // Route CLASSIFICATION (main vs subpage) and back-affordance fallbacks.
    'src/lib/nav/page-segregation.ts',
    'src/lib/nav/canonical-parents.ts',
    // Every shim's own redirect target.
    ...REDIRECT_SHIMS.map((r) => `${APP}${r}/page.tsx`),
];

/**
 * Does anything OUTSIDE the route's own directory link to it?
 *
 * The needle is the route with its dynamic segment replaced by a template
 * hole, because that is how a link to a detail page is actually written:
 * `` router.push(`/t/${tenantSlug}/agents/${row.original.id}`) ``.
 */
function inboundLinkers(route: string): string[] {
    const own = ownDir(route);
    const needles = route.includes('[')
        ? // A dynamic route: the literal prefix followed by an interpolation.
          [route.replace(/\/\[[^\]]+\]$/, '') + '/${']
        : // A static route: the path, followed by a quote or a template close.
          [`${route}'`, `${route}"`, '${' + `}${route}`, `${route}\``];

    return SOURCES.filter(({ rel, code }) => {
        if (rel.startsWith(own)) return false;
        if (NOT_A_LINK.includes(rel)) return false;
        return needles.some((n) => code.includes(n));
    }).map(({ rel }) => rel);
}

describe('the scan has a population and a needle that work at all', () => {
    it('git lists the source tree', () => {
        // Without this, every "has an inbound link" result below could be
        // vacuous over an empty file list.
        expect(SOURCES.length).toBeGreaterThan(500);
    });

    it('the needle finds a link that is KNOWN to exist', () => {
        // Positive control: the sidebar links `/agents`. If this stops
        // matching, the detector is broken rather than the product.
        expect(inboundLinkers('/agents')).toContain(
            'src/components/layout/SidebarNav.tsx',
        );
    });

    it('the needle does NOT match a path that is only in prose', () => {
        // Negative control, planted rather than found: comment-stripping is
        // what makes the whole guard mean anything, and a guard that had
        // silently stopped stripping would pass every case above.
        const commented = codeOf(`
            /** See /t/:slug/agents/nowhere for the rationale. */
            export const x = 1;
        `);
        expect(commented).not.toContain('/agents/nowhere');
    });
});

describe('every agentic route under (app)/ has at least one inbound link', () => {
    it.each(AGENTIC_ROUTES.map((r) => [r] as const))('%s is linked from somewhere', (route) => {
        const linkers = inboundLinkers(route);
        if (linkers.length === 0) {
            throw new Error(
                `${route} has NO inbound link from anywhere outside its own directory.\n\n` +
                    `A route nothing links to is reachable by typing a URL and by nothing ` +
                    `else — the shape the agent detail page and the review-quality report ` +
                    `both shipped in. Add a nav entry, a hub card, a command-palette entry ` +
                    `or a row action.`,
            );
        }
        expect(linkers.length).toBeGreaterThanOrEqual(1);
    });

    it('the ViewsMenu is what links four of the five children', () => {
        // Named, not counted. The point of folding the secondary navigation
        // into ONE labelled menu is that these four arrive together; a future
        // change that scattered them again would still pass the per-route
        // assertions above, and would lose the reason they are discoverable.
        const menu = `${APP}/agents/AgentsViewsMenu.tsx`;
        for (const route of [
            '/agents/proposals',
            '/agents/runs',
            '/agents/receipts',
            '/agents/quarantine',
            '/agents/review-quality',
            '/agents/reports',
        ]) {
            expect(inboundLinkers(route)).toContain(menu);
        }
    });

    it('the REGISTER is linked from the sidebar AND the command palette', () => {
        const linkers = inboundLinkers('/agents');
        expect(linkers).toContain('src/components/layout/SidebarNav.tsx');
        expect(linkers).toContain('src/components/command-palette/use-palette-commands.ts');
    });

    it('the RUN DETAIL page is linked from the run list’s row', () => {
        // The step ledger was served by `GET /agent-runs/:id` from the day the
        // engine shipped and read by nothing — the same unreachable shape the
        // agent detail page had, one surface along. `AgentRunsClient` is
        // outside `(app)/agents/runs/[runId]/`, so it counts.
        expect(inboundLinkers('/agents/runs/[runId]')).toContain(
            `${APP}/agents/runs/AgentRunsClient.tsx`,
        );
    });

    it('the DETAIL page is linked from the register’s row action', () => {
        // The one that shipped unreachable. `AgentsClient` is outside
        // `(app)/agents/[agentId]/`, so it counts — see `ownDir`.
        expect(inboundLinkers('/agents/[agentId]')).toContain(
            `${APP}/agents/AgentsClient.tsx`,
        );
    });
});

describe('the agentic API surface is declared, not discovered', () => {
    /** Every `route.ts` under `src/app/api/` whose path mentions agents or mcp. */
    function discoveredAgenticApiRoutes(): string[] {
        return repoFiles({ under: API, extensions: ['.ts'] })
            .filter((abs) => path.basename(abs) === 'route.ts')
            .map((abs) => path.relative(path.join(repoRoot(), API), abs))
            .map((r) => r.replace(/\\/g, '/'))
            .filter((r) => IS_AGENTIC.test(r));
    }

    it('the scan finds an agentic API surface at all', () => {
        // Positive control. Every assertion below is satisfied by an EMPTY
        // discovery, so without a floor a scan that had silently stopped
        // matching would read as a clean bill of health.
        expect(discoveredAgenticApiRoutes().length).toBeGreaterThan(20);
    });

    it('every discovered agentic API route is registered', () => {
        const unlisted = discoveredAgenticApiRoutes().filter(
            (r) => !AGENTIC_API_ROUTES.includes(r),
        );
        if (unlisted.length > 0) {
            throw new Error(
                'New agentic API surface landed unregistered:\n' +
                    unlisted.map((r) => `  - ${r}`).join('\n') +
                    '\n\nAdd it to AGENTIC_API_ROUTES with the reason it exists. ' +
                    'Regenerating public/openapi.json is NOT the same thing: the ' +
                    "route walker stubs every route, so the spec's drift check " +
                    'goes green on a regenerate without anybody deciding the ' +
                    'surface was intended.',
            );
        }
        expect(unlisted).toEqual([]);
    });

    it('every registered agentic API route still exists', () => {
        // The other direction. A stale entry is a line nobody has to satisfy,
        // and it makes the list stop being a census of what is callable.
        const missing = AGENTIC_API_ROUTES.filter(
            (r) => !fs.existsSync(path.join(repoRoot(), API, r)),
        );
        expect(missing).toEqual([]);
    });

    it('the registry names each route once', () => {
        expect(new Set(AGENTIC_API_ROUTES).size).toBe(AGENTIC_API_ROUTES.length);
    });
});

describe('the route list is complete — a new agentic page cannot land unlisted', () => {
    /** Every `page.tsx` under `(app)/` whose route mentions agents or mcp. */
    function discoveredAgenticRoutes(): string[] {
        return repoFiles({ under: APP, extensions: ['.tsx'] })
            .filter((abs) => path.basename(abs) === 'page.tsx')
            .map((abs) => '/' + path.relative(path.join(repoRoot(), APP), path.dirname(abs)))
            .map((r) => r.replace(/\\/g, '/'))
            .filter((r) => IS_AGENTIC.test(r));
    }

    it('classifies every discovered agentic page as a route or a shim', () => {
        const known = new Set<string>([
            ...AGENTIC_ROUTES,
            ...REDIRECT_SHIMS,
            // The MCP credential panel. NOT an agentic ROUTE in this guard's
            // sense: it is an admin settings page reached from the admin
            // landing pill, and prompt 2/4 merges its panel into
            // /admin/api-keys. Listed so the completeness check is exhaustive
            // rather than filtered.
            '/admin/mcp',
        ]);
        const unlisted = discoveredAgenticRoutes().filter((r) => !known.has(r));
        expect(unlisted).toEqual([]);
    });

    it('every listed route and shim actually exists', () => {
        // The other direction. A stale entry is an entry nobody has to satisfy
        // — and the inbound-link assertions above would pass it by matching
        // some leftover string.
        for (const route of [...AGENTIC_ROUTES, ...REDIRECT_SHIMS]) {
            const page = path.join(repoRoot(), APP, route, 'page.tsx');
            expect(fs.existsSync(page)).toBe(true);
        }
    });

    it('every shim is a redirect and nothing else', () => {
        // What justifies excluding them from the inbound-link requirement. A
        // shim that grew real content would need a link like anything else.
        //
        // The SUBJECT of each assertion is a list of ROUTES, not a file's text.
        // Two reasons, and the first is the test's own quality: a failure names
        // which shim broke rather than which of six iterations threw. The
        // second is `assertion-needle-uniqueness-ratchet` — a `toContain`
        // against `codeOf(readFileSync(…))` is a whole-file read wearing a
        // transform the analyser cannot follow, so it lands in that ratchet's
        // CAPPED un-analysable bucket. Filtering first moves the claim off the
        // file text entirely.
        const shimCode = (route: string) =>
            codeOf(fs.readFileSync(path.join(repoRoot(), APP, route, 'page.tsx'), 'utf8'));

        const notRedirects = REDIRECT_SHIMS.filter((r) => !shimCode(r).includes('redirect('));
        expect(notRedirects).toEqual([]);

        // No JSX at all — the tell that it renders nothing, and therefore that
        // it has no content anybody needs a link to.
        const withJsx = REDIRECT_SHIMS.filter((r) => /return\s*\(/.test(shimCode(r)));
        expect(withJsx).toEqual([]);
    });
});

describe('the harness register half is called from the tab; the machine surface is not (#3687, #3712)', () => {
    /**
     * Which files under `(app)/agents/` CALL a path, by a needle that only a
     * call writes: the path closed by a quote, or followed by an interpolated
     * id. Comments are stripped, so a docstring naming the route does not count.
     * Asserted on arrays of paths, not on file text.
     */
    const callers = (needle: string): string[] =>
        SOURCES.filter((s) => s.rel.startsWith(`${APP}/agents/`) && s.code.includes(needle)).map((s) => s.rel);
    const HARNESS = `${APP}/agents/reports/harness`;

    it('the owner\'s accept and renew POST harness-acceptances from the accept dialog', () => {
        expect(callers("/admin/agents/harness-acceptances'")).toContain(`${HARNESS}/AcceptShortfallModal.tsx`);
    });

    it('a key is registered from the register dialog, and revoked from the key card', () => {
        expect(callers("/admin/agents/harness-scanner-keys'")).toContain(`${HARNESS}/RegisterScannerKeyModal.tsx`);
        expect(callers('/admin/agents/harness-scanner-keys/${')).toContain(`${HARNESS}/ScannerKeysCard.tsx`);
    });

    it('a shadow agent is registered from the shadow list\'s Register dialog (#3712)', () => {
        expect(callers("/admin/agents/intake'")).toEqual([`${HARNESS}/RegisterShadowAgentModal.tsx`]);
    });

    it('no page calls the scan ingest — it is a scanner\'s, behind its own API-key scope', () => {
        const pageCallers = SOURCES.filter(
            (s) => s.rel.startsWith(APP) && s.code.includes('/admin/agents/harness-scans'),
        ).map((s) => s.rel);
        expect(pageCallers).toEqual([]);
    });
});
