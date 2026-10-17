# Agentic AI for identity and access management

> **Status: living design** — six use cases that let an IAM practice govern
> autonomous agents the way it already governs people, and the five-phase plan
> that builds them on Inflect. The **Current state** section is true today. The
> **Roadmap** section is the plan; its steps are tracked as issues under #3654,
> one pull request each. If the code contradicts a fact here, the code wins and
> the pull request that finds it corrects this document.

Autonomous agents are a new population of principals. They hold credentials,
call tools, read and write enterprise data, delegate to other agents and load
packaged knowledge at run time. The controls an IAM function already runs —
joiner, mover and leaver; least privilege; recertification; privileged access;
independent assurance — were not written with them in mind. Each use case below
extends one of those controls to agents. Agents do the preparation; people do
the deciding; and the agent doing the governing is itself a governed principal.

| | Use case | The IAM control it extends to agents |
|---|---|---|
| UC1 | Harness assurance scanner | Inventory of principals |
| UC2 | Non-human identity lifecycle | Joiner, mover, leaver |
| UC3 | Entitlement broker and recertification | Least privilege, periodic review |
| UC4 | Agentic auditor | Independent assurance |
| UC5 | Agentic integration harness | Authority on every hop |
| UC6 | Compliant agentic skill design | The knowledge supply chain |

## Current state (true today)

### What a harness is, and the ladder that scores one

An agent is a model plus a loop that decides what to call next. Its **harness**
is everything around that loop: what it may call, what it was taught, with which
credential, under whose accountability, how it is observed and how it is
stopped. The harness is the governable part, and it is the part IAM owns.

`src/lib/agentic/harness-ladder.ts` defines the **harness ladder**, H0 to H5,
with a stable id for every criterion on every rung:

| Rung | Name | Requires (all, with evidence) |
|---|---|---|
| H0 | Shadow | nothing: an agent found but not registered, or with no accountable owner |
| H1 | Registered | register row, owner, declared axes, a scored and fresh risk tier |
| H2 | Bounded | bound credentials with a declared grant kind, allowlisted tools, audience-scoped tokens, a policy card |
| H3 | Guarded | pinned manifests, guarded payloads, propose-not-commit, prior-state reads, declared skills, narrowing delegation |
| H4 | Observed and stoppable | ledger with a baseline, receipts, a drilled kill switch, a token budget |
| H5 | Evidenced | ASI coverage, evidence at the controls, evaluated skills, sample-audit quality, an independent audit |

Three rules hold in that module:

- **Unanswered counts as no.** A rung is met only when every criterion on it and
  below it is met *with an evidence reference*. A criterion reported as met
  without evidence is not met, and a criterion reported twice is judged on its
  least favourable answer.
- **Order lives in one place** and comparison is ordinal (`levelAtLeast`), the
  shape `src/lib/identity/write-ladder.ts` established.
- **The ladder is report-only.** A level raises findings and never gates an
  activation or a tool call. `eslint.config.mjs` refuses an import of the module
  from the authority funnel's files.

### The scanner's report contract

`docs/agent-harness-contract.md` defines `inflect-agent-harness/1`, the signed
report a scanner returns from a client environment. The schemas are
`src/lib/agentic/harness-contract.ts` and the executable reference is
`tests/helpers/agent-harness-fake-scanner.ts`. The verifier checks size, then
JSON, then the Ed25519 signature by a trusted key, and only then the schema. A
report cannot state its own level, cannot carry a credential value, and cannot
declare completeness: completeness is derived from its sources.

### The harness ingest

A tenant registers a scanner's public key against the registered agent that is
the scanner, and the scanner posts signed reports with an API key scoped to
`admin:harness_ingest` alone (`docs/agent-harness-contract.md`, Transport).
`src/app-layer/usecases/agent-harness-scans.ts` is the only writer of the scan,
the discovered agents and the per-agent items. What a verified report means is
decided by the pure planner `src/lib/agentic/harness-findings.ts`: the level is
derived, the register decides whether an agent is shadow, and a finding closes
only on positive evidence. A shortfall below the bar (H3 for an agent that can
write or whose reach is unknown, H2 for a read-only one) is a finding that never
gates the agent; its owner may accept it for at most a year, and the nightly
exception expiry monitor reopens it when the acceptance lapses.

The data protection impact assessment for the scanner and the ingest is
[`docs/agentic-harness-scanner-dpia.md`](agentic-harness-scanner-dpia.md). It
names the conditions step `1a` must meet for the assessment to hold, and which
issue or pull request owns each, and it records that the scanner introduces no
sub-processor. The owner's merge of the pull request that carries it is its
signature (decision 9).

### Integration passport and A2A threat model

Two documents specify UC5's new parts.

- `docs/integration-passport.md` specifies the passport of every `mcp-server`
  connection: twelve fields, the table and column each is read from on `main`,
  and the drift rule step 2d applies to each, with who owns the resulting
  finding. Two facts have no source today and are listed as gaps: the
  connection's accountable owner, and whether each pinned tool declares a write.
  No passport is built on `main`.
- `docs/a2a-threat-model.md` models A2A traffic in both directions, hop by hop,
  naming for each hop the trust boundary, the STRIDE threats and the control.
  No A2A traffic exists on `main`. The model requires that A2A traffic pass
  through the existing funnel with no second authority model, and that a peer's
  agent card be pinned by hash so that a changed card refuses traffic until a
  person re-approves it; steps `2e` and `4b` build both. Each control is either
  on `main`, cited by file and symbol, or assigned to step `2d`, `2e` or `4b`,
  and the residual risks list every assigned control with the step that closes
  it. On 2026-10-17 the owner accepted three of those controls as requirements
  on step `4b`: inbound A2A is refused for a tenant that has not set both
  `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns` (R13); a run started
  by an inbound A2A task never dispatches an external write above
  `PROPOSE_ONLY` (R17); and a peer's agent card is re-checked before every
  message against a copy at most 15 minutes old (R18). Which permission key
  governs the peer register and pin routes (R3) is the model's recommendation,
  open for step `2e`.

### Audit procedure catalogue

`docs/agentic-audit-procedures.md` is catalogue version 1 of the agentic
auditor's procedures: leaver timeliness, recertification completeness,
time-bounded access expiry, privileged access, agent authority conformance, stop
control, approval quality and evidence sufficiency. Each names its control
identifiers, its population as a table and filter with inclusions and
exclusions, a keyed sample with a stated epoch, the attributes tested, the raw
rows its re-performance recomputes, its exception and what makes it
INCONCLUSIVE; an empty population is never a pass. It proposes library v1 as the
first five. The repository owner's merge of its pull request is the repository
owner's sign-off and adopts version 1 for this repository. The merge does not
supply internal audit's approval or PwC's agreement: neither is recorded on
#3663, each is recorded there when given, and while both are open library v1 is
proposed to them, not approved or agreed. The catalogue records the ownership
rule of decision 3: the second line is to own and operate the auditor agent, and
internal audit is to approve its procedures and sample its workpapers. No
auditor agent, workpaper or line-of-defence value exists on `main`, no handler
runs any procedure, and each procedure's PwC methodology reference is open: PwC
supplies it, and it is recorded on #3663 when given.

### Agent retirement and ownership transfer

Retiring an agent (`DELETE /api/t/:slug/admin/agents/[agentId]`, under
`admin.agent_registry` alone) is one transaction that takes its authority apart
and records what it took: every `TenantApiKey` bound to the agent is revoked,
including keys already past their expiry, and so is every harness scanner
signing key it holds; its `RegisteredAgentTool` grants are deleted; its `PENDING`
proposals move to `EXPIRED`, unreviewed; its policy card is frozen, so no further
`AgentPolicyCardVersion` can be written while its history stays readable; and an
open ownership transfer is closed — cancelled while it is live, marked expired
once it has lapsed. The status is written first and the audit
rows last: an `AGENT_RETIRED` summary carrying every count, then one row per
effect that changed something. `RETIRED` is terminal: the status write matches
no retired row, and a trigger refuses any move out of it from any writer. More
triggers refuse, for a retired agent, a `PENDING` proposal, a card version, a
new ownership transfer, an unrevoked API key or scanner signing key, and a tool
grant. Each takes a share lock on the agent row, so a write in flight at the
moment of retirement either commits first and is taken apart by the cascade, or
waits for the retirement and is refused: nothing attaches to the agent after
the retirement commits, whether the agent wrote it or a person did. The retire dialog previews
the live keys, grants and pending proposals the cascade will change.

No evidence artefact is withdrawn. Every `AgenticEvidenceArtefact` is a
tenant-wide monthly aggregate over all agents' receipts or decisions, keyed
`(tenant, control, kind, period)` with no agent column, so none is attributable
to one agent; the summary row records `evidenceArtefactsWithdrawn: 0` and the
basis `POPULATION_LEVEL_ONLY`. Withdrawing none is the owner's decision of
2026-10-18 (decision 13 below), not a gap: per-agent evidence that a retirement
could withdraw is its own step, #3700. Agents retired before this change
keep whatever keys and grants they held then.

An agent's owner moves only by a two-step transfer
(`…/admin/agents/[agentId]/ownership-transfer` and `…/ownership-transfer/complete`,
both a literal `requirePermission('admin.tenant_lifecycle')`, and API-only: no
page calls them). Step one names the new owner, who must be an active OWNER, or
an active ADMIN whose custom role carries `admin.tenant_lifecycle` — the routes
sit under `/admin/`, where the edge admits only the ADMIN and OWNER built-in
roles; step two is completed by that person and never
by the one who started it, and re-checks that the agent is not retired or
removed, is still owned by the person it was proposed away from, and that the
completer is still an active member holding the key. A proposal lasts seven
days and is marked `EXPIRED` by the next request that finds it lapsed; the
initiator, the recipient or another holder of the key can cancel it. The
`AgentOwnershipTransfer` table backs every rule: CHECKs make a completion by
anyone but the recipient unrepresentable, a partial unique index admits one
`PENDING` transfer per agent, a row that has left `PENDING` is immutable, and
`app_user` cannot delete one. The register's `PATCH` refuses `ownerUserId` by
name, and the amend dialog shows the owner read-only.

That recipient set is narrow on purpose, and the owner accepted it on
2026-10-18 as the interim state (decision 14 below). The edge gate reads the
session's primary — oldest — membership role rather than the role in the tenant
being called, so an OWNER here whose oldest membership elsewhere is READER is
refused on every admin route, these two included. That limitation fails closed
and is documented, not fixed, by this change (decision 15 below).

### What the six use cases stand on

| Area | Shipped on `main` | Not built |
|---|---|---|
| Register and funnel | Register with four scorer axes and a required owner; an unscored tier means deny. Deny-by-default grants, versioned and pinned policy cards, the autonomy ceiling, audience-scoped tokens, a registration gate on by default, credential and kill state re-read on every call. Five separate admin rights. The AI-system risk tier has an `UNCLASSIFIED` value for a provisional entry, which every reader shows as not classified and never as `MINIMAL`, and which nothing writes until `2a`'s intake (#3669). | Signed harness reports are ingested, levels derived and stored per scan, shadow and below-bar agents raised as findings, and shortfalls accepted for a bounded time. No scanner ships yet, so nothing discovers agents outside Inflect; no page renders the scans. |
| Runs and communication | Four specialists reachable by delegation, depth one, fan-out capped per turn per tenant; tools and skills only narrowed. Delegation spans in the run ledger. Runtime-supplied tools reported. Run input scanned before the run exists. Automation rules invoke agents with named refusals. | No integration passport; no A2A peers. |
| Skills | Eight original, licensed skills, two of them for IAM and declared by no workflow. The loader enforces name, description, licence, byte budgets and the standard's optional metadata, and scans every skill's text at load: a refused skill is listed on the read-only Skills tab by rule id, and a run that declares it fails closed, as a run declaring an unknown skill does. Every shipped skill ships an evaluation set; the catalogue budget binds per workflow and per run. A run mounts a skill only with a passing evaluation record (the mount gate, refused before the run row exists), and every run pins each mounted skill's name, version and hash, write-once, shown on the run detail page. | No committed evaluation records, so the gate refuses every skill; no workflow declares a skill. |
| Writes and approvals | Propose-not-commit with the approver count pinned and four-eyes in the database; expiry, output guard, quarantine, ASI09 sample audits. | No agent recertification campaign. |
| External systems | MCP server and client, delegated and app-only grants, one outbound wire; external writes on a four-rung ladder with prior-state reads and a journal; Entra time-bounded access packages with verified expiry. | — |
| Assurance | Control-test runner with four agentic checks (an empty population is inconclusive); audit-prep workflow; auditor role, pack-scoped auditor accounts; a catalogue of eight audit procedures, adopted for this repository, proposing library v1 as five. | Internal audit's approval and PwC's agreement of the catalogue are open; no handler for any audit procedure, no workpapers, no auditor independence check. |
| Identity chain | Sync, HRIS, joiner, leaver in a fixed order with a dwell; every directory write journaled; legacy-application recertification campaigns. Retiring an agent revokes its keys, drops its grants, expires its pending proposals and freezes its card; its owner moves only by a two-step transfer. | Offboarding a person does nothing to the agents they own; no registration intake from a shadow-agent finding. |

## Roadmap (future direction)

### The six use cases

**UC1 — Harness assurance scanner.** A read-only scanner in the client's
environment enumerates agent-shaped principals (IdP registrations and service
principals, secrets inventories, MCP servers, runtimes, CI/CD, the Inflect
register), scores each on the ladder and returns a signed report. Inflect
verifies and ingests it, reconciles it against the register, and raises
SHADOW_AGENT, UNPINNED_WRITE_TOOL, LEVEL_DROP and HARNESS_SHORTFALL findings. The
scanner never calls a tool, never records content, never moves a secret, and
never claims completeness it did not establish.

**UC2 — Non-human identity lifecycle.** Joiner: no credential before a register
row. Mover: authority widens one rung at a time and ownership moves only by a
two-step transfer. Leaver, two directions: retiring an agent cascades (keys
revoked, grants dropped, proposals expired, evidence withdrawn); and when a
person leaves, an orphan pass suspends and kills the agents they owned. A daily
hygiene pass raises findings for weak agent credentials.

**UC3 — Entitlement broker and recertification.** The broker is the funnel that
already decides every call as an intersection of narrowing terms. The new half
is recertification over agents: an agent prepares each reviewer pack (grants,
observed use, proposals, card history, time-bounded grants, incidents, harness
level), proposes the narrowing the evidence supports, and a person decides.

**UC4 — Agentic auditor.** An auditor agent runs audit procedures continuously,
re-performs each from raw rows, writes a workpaper per procedure and period, and
raises every exception as a finding proposal. It can read and propose, never
change. Internal audit samples its workpapers.

**UC5 — Agentic integration harness.** Every agent-to-tool and agent-to-agent
hop carries an attributed principal, narrows authority, keeps content as data,
uses pinned definitions, leaves through one wire and records its consequences.
New: an integration passport per connection with drift findings, and A2A peers.

**UC6 — Compliant agentic skill design.** A standard for skills — a skill
teaches and never grants; declared, not ambient; bounded; licensed and sourced;
reviewed as code; output discipline; evaluated before mounted; pinned on the
run; injection-safe text — and the lifecycle that enforces it.

### Decisions (settled with the owner on 2026-10-17)

1. **Registration without a classification.** The AI-system link stays required.
   Intake creates a provisional entry at a new `UNCLASSIFIED` risk tier, added in
   two deploys; the agent cannot become ACTIVE until classified. (`2a`)
2. **The harness bar is report-only.** Below H3 for an agent with a write-capable
   or external tool, below H2 for a read-only agent, is a shortfall finding that
   closes on a fix or a time-limited risk acceptance. (`1a`)
3. **The auditor agent** is owned and operated by the second line; internal
   audit approves its procedures and samples its workpapers. Memberships gain a
   line-of-defence value set only by an OWNER. (`0d`, `3b`–`3d`, `4d`)
4. **Peers use A2A from the start**, through the existing funnel, with each
   peer's agent card pinned and re-approved on change. (`0c`, `2e`, `4b`)
5. **Skills** stay repository-reviewed through Phase 3; tenant-authored skills
   arrive in Phase 4 behind the same lifecycle. The repository corpus stays
   Inflect-original. (`0b`, `1b`, `1d`, `4c`)
6. **The orphan pass** suspends and kills with reason `OWNER_DEPARTED` as a system
   actor; a lift needs a completed ownership transfer. (`2b`)

### Decisions recorded by the owner on 2026-10-17

The owner made and recorded these in the working session of 2026-10-17 that
drafted steps `0c`, `0d`, `0e`, `1a` and `1b`. They continue the numbering
of decisions 1 to 6 above.

7. **A harness-shortfall risk acceptance lives on a sibling model**,
   `AgentHarnessAcceptance`, with `ControlException`'s shape and watched by the
   same expiry monitor (`exception-expiry-monitor` in
   `src/app-layer/jobs/schedules.ts`), so there is one expiry mechanism. A
   `ControlException` is per control and a shortfall is per agent, which is why
   the row is a sibling and not a reuse. Shipped in #3688. (`1a`)
8. **Skill evaluation records are produced by the CI workflow
   `.github/workflows/skills-evaluate.yml`**, with the `ANTHROPIC_API_KEY`
   repository secret. The workflow is on `main` (#3690); it runs on manual
   dispatch and uploads the records as an artifact, which a person or an agent
   commits. This decision does not settle when the mount gate of #3689
   begins to enforce. (`1b`)
9. **Governance sign-off is the owner's merge.** For the governance documents
   of steps `0c`, `0d` and `0e`, the owner's merge of the pull request that
   carries the document is the sign-off, and auto-merge on green is the owner's
   standing authorisation for that merge. The owner re-confirmed this on
   2026-10-17 when asked directly, choosing auto-merge on green over holding the
   pull request for sign-off. The merge does not supply an external party's
   act, such as internal audit's approval, PwC's agreement or the security
   owner's review: each is stated as recorded on the step issue when given, and
   never as given before then. For `0e`, the signature covers
   [the DPIA](agentic-harness-scanner-dpia.md) as written, with its two
   [lawful-basis questions](agentic-harness-scanner-dpia.md#lawful-basis) open.
   (`0c`, `0d`, `0e`)
10. **The pilot estate is Inflect's own.** Its sources are an Entra tenant (its
    service principals and app registrations), MCP servers and CI/CD
    pipelines, and the Inflect register is always in scope. Inflect has no
    secrets vault. Okta and agent runtimes were not named, so neither is in
    the pilot. No owner has been named for any source. See [Pilot](#pilot).
    (`0e`)
11. **Harness scans are Business records, not regulatory artefacts.**
    `AgentHarnessScan` and `AgentHarnessScanItem` are purged with the tenant;
    the hash-chained `AGENT_HARNESS_SCAN_INGESTED` audit row, carrying the
    report digest and the signer, is what survives. `DiscoveredAgent` and
    `AgentHarnessAcceptance` are Business records too, matching
    `docs/data-retention.md` on `main`. Scan items and acceptances reference
    `DiscoveredAgent` with `ON DELETE NO ACTION`, implemented by #3692 (forward
    migration `20261017215000_harness_discovered_agent_no_cascade`), which
    replaced the `ON DELETE CASCADE` that #3688 shipped.
    See [Retention classes](#retention-classes). (`0e`, `1a`)
12. **Three rules of the A2A threat model are requirements on step `4b`.** R17:
    a run started by an inbound A2A task never dispatches an external write
    above `PROPOSE_ONLY`. R13: inbound A2A is refused unless the tenant has set
    both `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns`. R18: a peer's
    agent card is re-checked before every message against a copy at most 15
    minutes old. R3, which permission key governs the peer register and pin
    routes, stays an open recommendation for step `2e`. (`2e`, `4b`)

### Decisions recorded by the owner on 2026-10-18

The owner made these while reviewing the retirement cascade and ownership
transfer of `2a` (#3698). They continue the numbering above, and none of them
changed what #3698 built.

13. **Retirement withdraws no evidence artefact.** Every
    `AgenticEvidenceArtefact` is a tenant-wide aggregate per period with no agent
    column, so the cascade withdraws none and its summary audit row records the
    basis `POPULATION_LEVEL_ONLY`. Per-agent evidence that a retirement can
    withdraw — an agent-attributable artefact kind, per-agent emission and a
    withdrawal reason for it — is its own roadmap step, #3700. (`2a`)
14. **Transfer recipients stay narrow for now.** An agent passes only to an
    OWNER, or to an ADMIN whose custom role carries `admin.tenant_lifecycle`.
    This is the accepted interim state. A new built-in `AI_ADMIN` role widens who
    can receive an agent, in its own pull request (#3699); the edge gate is not widened
    for the transfer paths in the meantime. (`2a`)
15. **The edge gate's primary-membership limitation stays documented, not
    fixed, in `2a`.** The edge reads the role of the session's oldest
    membership, not the role in the tenant being called. It fails closed, and
    #3701 tracks the fix. (`2a`)

### Permission keys

Decided in step `0e` (#3664) and signed with it (decision 9). This covers every
privileged route the step issues plan through Phase 4, and records the routes
of `1a` that #3688 shipped as they are on `main`. One row is a proposal rather
than a decision: the key for the A2A peer register and pin routes of `2e` is
open (decision 12). Every route below carries a literal `requirePermission` and
a rule in `src/lib/security/route-permissions.ts`, except the two endpoints
under [Token-gated endpoints](#token-gated-endpoints), which say why. Key names
follow `PERMISSION_SCHEMA` in `src/lib/permissions.ts`.

**Two keys of the `admin` domain**: the sixth agent key, which `1a` shipped,
and one new key:

| Key | Gates | Granted by role | Bearer tokens |
|---|---|---|---|
| `admin.agent_harness_ingest` | Submitting a signed report, `POST /api/t/:slug/admin/agents/harness-scans` (`1a`, shipped in #3688), and the scanner's read of the register (`1a`, below) | OWNER, ADMIN | The `admin:harness_ingest` scope grants it and nothing else (`SCOPE_ACTION_MAP` in `src/lib/auth/api-key-auth.ts`). `*` carries it too: `*` is ADMIN's set minus the four agent-governance flags, and ADMIN holds it |
| `admin.agent_skill_review` | Authoring, approving and retiring a tenant skill (`4c`) | OWNER, ADMIN | Not carried by `*`, and no scope maps to it |

- **Reading scans takes the register key.** `GET …/admin/agents/harness-scans`
  lists scans under `admin.agent_registry`, and `listHarnessScans` in
  `src/app-layer/usecases/agent-harness-scans.ts` refuses a caller without it.
  #3687 builds the harness matrix and the shadow list as a tab on
  `/agents/reports` through `listHarnessScans`, and that page refuses anyone
  without `admin.agent_registry`
  (`src/app/t/[tenantSlug]/(app)/agents/reports/page.tsx`). `4a`'s scan health
  reads the same scans under the same key. AUDITOR does not hold
  `admin.agent_registry`, so it reads none of them. A view key split from
  `admin.agent_registry` for an auditor's read of the inventory is the case the
  `agent_registry` docstring names and leaves undone; whether to add one is
  open.
- **Submitting is a key of its own.** The other five agent keys are held by the
  people who govern agents; the ingest key is held by the scanner, through its
  API key, and nothing else that key carries should let it do more (the
  `agent_harness_ingest` docstring). Folding it into `admin.agent_registry`
  would hand every scanner the switch that admits agents.
- **The key never vouches for a report; the signature does.** The ingest
  refuses a report not signed by a scanner key the tenant registered
  (`UNTRUSTED_SIGNER`), and registering one at `…/admin/agents/harness-scanner-keys`
  takes `admin.agent_registry`, never the ingest key. A credential that can
  push a report cannot add its own signer. That is also what limits a `*`
  key: it carries the ingest key, and it does not carry `admin.agent_registry`.
- **A signing key speaks for one scanner.** Each scanner key belongs to one
  registered agent. The ingest refuses a report whose `scan.scanner.agentId` is
  not that agent (`SCANNER_MISMATCH`), and, when the API key that posts it is
  bound to an agent (`TenantApiKey.agentId`), a key bound to any other agent
  (`SUBMITTER_MISMATCH`). A credential bound to no agent, such as a person
  uploading a report by hand, is held to the signature alone.
- **The scanner reads the register by its ingest key.** No API-key scope maps
  to `admin.agent_registry`, the key behind the human register read, so an MCP
  read tool that mirrored that key could be reached by no key at all. The
  scanner reads the register only to reconcile what it ingests, so `1a`'s read
  tool is authorized on `admin.agent_harness_ingest` and is served by
  `/api/mcp` only to an agent granted it under `admin.agent_tool_exposure`. It
  returns only what the report's `inflect-register` source carries. No MCP tool
  returns `RegisteredAgent` rows today (see [Pilot](#pilot)). Two points about
  that tool are open: `/api/mcp` also requires the `mcp:read` capability scope
  (`src/lib/mcp/auth.ts`), while the contract's Transport section says a
  scanner key needs no scope but `admin:harness_ingest`; and a tool's
  `resourceScope` names an action of `read`, `write` or `admin`
  (`ScopeAction` in `src/lib/mcp/tools/types.ts`), which cannot name
  `admin:harness_ingest`.
- **A tenant skill's reviewer is never its author.** Step `4c` (#3680) asks for
  "a new skill-review right", and `admin.agent_skill_review` is it. One key
  gates authoring and approval, because #3680 gives the authoring surface on
  the Skills tab to holders of the right, and the usecase refuses an approval
  by the version's author. `*` does not carry it, for the reason it does not
  carry the four agent-governance flags: a skill is text mounted into an
  agent's context, and a key held by an agent that could approve skill text
  could teach itself.
- **Workpaper routes need a privileged root.** A workpaper route that `3b` or
  `3d` places under `/api/t/:slug/audits/` sits under no entry of
  `PRIVILEGED_ROOTS` in `tests/guardrails/api-permission-coverage.test.ts`,
  whose only `audits` entries are the leaf roots `audits/auditors/access` and
  `audits/auditors/[auditorId]`, so each step adds its directory there. Without
  it, layer 1 checks nothing about the route. The `1a` routes need no new root:
  they sit under `src/app/api/t/[tenantSlug]/admin`, the first entry of
  `PRIVILEGED_ROOTS`.

**Every other planned route, by step:**

| Route (step) | Key | Why this key |
|---|---|---|
| Read scans, the harness matrix and the shadow list (`1a`) | `admin.agent_registry` | Shipped in #3688 for `GET …/admin/agents/harness-scans`; #3687 reads the matrix through `listHarnessScans` (above). |
| Add, list or revoke a trusted scanner key (`1a`) | `admin.agent_registry` | Shipped in #3688 at `…/admin/agents/harness-scanner-keys` and `…/harness-scanner-keys/[keyId]`. It decides whose reports the tenant believes (above). |
| Record, renew or list an `AgentHarnessAcceptance` (`1a`) | `admin.agent_registry`, held by the agent's owner | Shipped in #3688 at `…/admin/agents/harness-acceptances` (`GET`, `POST`). The route takes `admin.agent_registry`, and `acceptHarnessShortfall` in `src/app-layer/usecases/agent-harness-acceptance.ts` refuses anyone but the registered agent's owner, because accepting a risk is the act of the person accountable for it. A shadow agent has no owner, so it is registered before its shortfall can be accepted. There is no separate approval: a renewal is a new acceptance, of at most 365 days, that revokes the one in force. No API key carries `admin.agent_registry`, so no bearer token records an acceptance. |
| Registration intake from a `SHADOW_AGENT` finding (`2a`) | `admin.agent_registry` | It creates a DRAFT register row and its AI-system entry. |
| Retire an agent, with its cascade (`2a`) | `admin.agent_registry` | The existing `DELETE /api/t/:slug/admin/agents/[agentId]`. See the cascade table below. |
| Propose, and complete, an agent ownership transfer (`2a`) | `admin.tenant_lifecycle` | Ownership transfer sits under tenant lifecycle, the key whose docstring already lists "transfer ownership". |
| Set the orphan pass's mode (`2b`) | `admin.tenant_lifecycle` | The key `/admin/identity-write-policy` carries for the identity ladder: the mode decides whether a scheduled job stops agents unattended. |
| Lift an `OWNER_DEPARTED` kill (`2b`) | `admin.agent_kill_switch` | The existing kill-switch route. The completed transfer is a precondition in the usecase, not a second key. |
| Show a connection's passport (`2d`) | `admin.manage` | The view sits on the integrations admin page, and `/admin/integrations(/.*)?` resolves to `admin.manage`, the key of the integration settings beside it. Passports are derived (#3672), so the view writes nothing. |
| Register an A2A peer, approve its card pin, re-approve a changed card (`2e`) | Open for `2e` (decision 12). Proposed here: `admin.agent_external_tools` | #3673 names it: a peer is a destination agents act towards, and this key already decides whether an agent may act outside the platform. `*` carries it (`scopesToPermissions` subtracts only the four agent-governance flags, deliberately), and decision 4 and #3673 have a human approve each pin, so the pin approval also refuses a caller whose context carries an `apiKeyId`. |
| Create, decide, close and read an `AGENT` campaign (`3a`) | `access_reviews.create`, `.decide`, `.close`, `.view` | The existing access-review routes and keys. |
| Read an `AGENT` campaign's reviewer packs (`3a`) | `access_reviews.view` | Every role holds it, and a pack carries register data, so the usecase narrows the read to the campaign's assigned reviewer or a holder of `admin.agent_registry`, as `decide` narrows to the assigned reviewer. |
| Accept or reject a narrowing in a campaign (`3a`) | `access_reviews.decide` | The effect is a grant delete, which only narrows, so it does not also need `admin.agent_tool_exposure`. |
| Set a membership's line of defence (`3b`) | `admin.owner_management` | OWNER-only; see below. |
| Register or activate an auditor agent (`3b`) | `admin.agent_registry` | The existing routes. The independence check is a refusal inside `registerAgent` and `activateRegisteredAgent`. |
| Read workpapers (`3b`, `3c`) | `audits.manage` | A workpaper on leaver timeliness or privileged access lists exceptions about named people's access, and `audits.view` is held by every role, READER included (`src/lib/permissions.ts`). OWNER and ADMIN hold `audits.manage`. A THIRD-line reviewer reads the workpapers assigned to them through `3d`'s review route, and the external auditor reads them in a pack (`4d`). An internal-audit member who needs every workpaper gets a custom role carrying `audits.manage`. `3b` places `AuditWorkpaper` in `prisma/schema/audit-workflow.prisma`, beside `Audit`. |
| Read and record the outcome of a sampled workpaper (`3d`) | `audits.view` | Every role holds it, so the usecase admits only the workpaper's assigned reviewer, who must be THIRD-line and must not own the auditor agent, as `decide` narrows to the assigned reviewer. Requiring `audits.manage` would shut out an internal auditor on the AUDITOR role, which does not hold it. The draw and the assignment are a scheduled sweep, with no route. |
| Show the scan health per estate and per source (`4a`) | `admin.agent_registry` | It reads scans, under the key their list takes. |
| Kill an A2A peer, and lift the kill (`4b`) | `admin.agent_kill_switch` | The key that stops an agent stops a peer: there is no second authority model (decision 4). `*` does not carry it. |
| Author, approve or retire a tenant skill (`4c`) | `admin.agent_skill_review` | New; see above. |
| Assemble a reliance pack, give the external auditor access, record the auditor's conclusion (`4d`) | The existing gates, and `audits.manage` for workpapers | No new route. Packs go through the pack usecases behind `assertCanManageAuditPacks`, which admits EDITOR; putting workpapers into a pack reads them, so that part also requires `audits.manage`, which EDITOR does not hold. Auditor accounts and pack access go through `/audits/auditors/*`, where account creation sits behind `assertCanManageAuditors` (OWNER and ADMIN) and the grant and revoke behind `admin.manage`. The conclusion is recorded as `Evidence` through the existing evidence routes. |

Steps `1b`, `1c`, `1d`, `3c` and `4e` plan no route of their own. `1b` extends
the run detail page that the existing run routes serve, and `3c`'s handlers run
on the control-test runner as the registered auditor agent, under that agent's
grants.

#### Token-gated endpoints

Two planned endpoints take no `requirePermission`, because no session or role
stands behind the caller, and nothing in the permission system can express who
it is:

| Endpoint (step) | Gate | Why |
|---|---|---|
| `read_service_principal_state` and `disable_service_principal`, on `/api/mcp/entra-grant` or a sibling route under `src/app/api/mcp/` (`2c`) | The per-connection token, as on the grant endpoint | The only client is Inflect's own external-write dispatch. The header of `src/app/api/mcp/entra-grant/route.ts` sets the precedent: the gate is the token, and every refusal that can be attributed to a tenant writes the `AUTHZ_DENIED` row `requirePermission` would have written. |
| The inbound A2A task endpoint (`4b`) | The pinned peer's signature over the task, checked against its approved card before the body is read | The caller is another organisation's agent, and its reach is the receiving agent's grants (decision 4), not a key of its own. Every refusal that can be attributed to a tenant writes `AUTHZ_DENIED`. |

Each is triaged into the `PROTOCOL_CREDENTIAL` class of
`tests/guardrails/api-route-has-some-authorization.test.ts`, where `/api/mcp`,
`/api/mcp/entra-grant` and `/api/mcp/token` already sit. A new route fails that
test until it is triaged.

**The retirement cascade is one act under one key.** Retirement takes
`admin.agent_registry` alone. It does not also ask for the keys that gate each
effect on its own, because every effect takes authority away (rule 2), and a
holder of a narrower key keeps the standalone verb they hold today.

| Cascade verb (`2a`) | Effect | Gate for the same verb on its own today |
|---|---|---|
| Revoke every key bound to the agent | `TenantApiKey.revokedAt` set where `agentId` is the agent | `admin.manage`, at `/admin/api-keys/[keyId]` |
| Drop its tool grants | `RegisteredAgentTool` rows deleted | `admin.agent_tool_exposure`, at `/admin/agents/[agentId]/tools` |
| Expire its open proposals | `AgentProposal` rows moved from `PENDING` to `EXPIRED` | No key: the `agent-proposal-expiry` job expires them, and a person rejects one at `/agent-proposals/[id]/reject` behind `assertCanWrite` and no key |
| Freeze its policy card | No further `AgentPolicyCardVersion` | `admin.agent_policy_card`, at `/admin/agents/[agentId]/policy-card` |
| Revoke its harness scanner signing keys | `AgentHarnessScannerKey.revokedAt` set where `agentId` is the agent (added by `2a`, #3698: an unrevoked key keeps verifying reports after its scanner is retired) | `admin.agent_registry`, at `/admin/agents/harness-scanner-keys/[keyId]` |
| Cancel its open ownership transfer | `AgentOwnershipTransfer.status` moved from `PENDING` to `CANCELLED`, by the retiring actor; a lapsed one to `EXPIRED`, with no actor (added by `2a`, #3698: a retired agent can never be completed into) | `admin.tenant_lifecycle`, at `/admin/agents/[agentId]/ownership-transfer` |
| Withdraw its evidence artefacts | None attributable, so none withdrawn (amended by `2a`, #3698, and settled by decision 13). Every `AgenticEvidenceArtefact` is a tenant-wide aggregate per period, and the agent's past actions stay correctly counted in `CURRENT` artefacts; the summary audit row records `evidenceArtefactsWithdrawn: 0` and the basis. Per-agent evidence a retirement can withdraw is #3700 | No key: only the emission usecase withdraws (`src/app-layer/usecases/agentic-evidence-emission.ts`) |

`2a` shipped the cascade (#3698): `retireRegisteredAgent` no longer refuses while
a proposal is `PENDING`, and its docstring records why the old refusal went.

**Agent ownership transfer.** Both steps of `transferAgentOwnership` carry a
literal `requirePermission('admin.tenant_lifecycle')`, and the second step
cannot be performed by the first actor. The person who completes step two must
therefore hold the key as well: with the built-in roles an agent passes only to
an OWNER, or to a member an OWNER has given a custom role carrying the key.
Registration accepts any active member as owner (`assertOwnerInTenant`), so
this narrows who can receive an agent by transfer, and the owner accepts that
narrowing in signing. (Amended by `2a`, #3698: the custom-role case holds only
on an ADMIN membership. Both steps sit under `/api/t/:slug/admin/`, where the
edge middleware refuses any session whose BUILT-IN role is not ADMIN or OWNER
before the route's `requirePermission` runs, and a custom role does not change
the built-in role. A READER, EDITOR or AUDITOR given a custom role carrying the
key would pass the route and never reach it, so step one refuses them.
Admitting them would mean widening the edge gate for these paths, which is a
separate decision. The owner accepted the narrow set as the interim state on
2026-10-18; a new built-in `AI_ADMIN` role widens it in its own pull request —
see decision 14.)

**A membership's line of defence is OWNER-only.** The route takes
`admin.owner_management`, which `getPermissionsForRole` grants to OWNER and
denies ADMIN explicitly, and no API key carries it: `scopesToPermissions`
builds `*` from ADMIN's set, and no scope maps to it. A custom role can carry
the key when an OWNER authors it (`assertGrantWithinOwnAuthority` in
`src/app-layer/usecases/custom-roles.ts`), and decision 3 has an OWNER set the
value, so the usecase also requires the caller's built-in role,
`TenantMembership.role`, to be OWNER. No member sets the line of their own
membership: the independence check reads the value, and a line its holder
declared is a claim, not a control. A tenant with one OWNER therefore cannot
declare that OWNER's line; it adds a second OWNER, or another member owns the
auditor agent. Every change writes an audit row. A NULL value means not
declared and never satisfies the independence check.

**Rule order.** `ROUTE_PERMISSIONS` is first-match-wins. The line-of-defence
rule precedes `/admin/members(/.*)?`, which resolves to `admin.members`, and
the transfer rule precedes `/admin/agents(/.*)?`, which resolves to
`admin.agent_registry`. So does any `2e` peer rule or `4c` skill rule placed
under `/admin/agents/`, as the `POST` rule for `/admin/agents/harness-scans`,
which resolves to `admin.agent_harness_ingest`, does on `main` (#3688). ADMIN holds both of those keys, so a rule placed below
its catch-all would record a different gate from the one the handler enforces.

### Retention classes

Decided in step `0e` and signed with it (decision 9), using the seven categories
of [`docs/data-retention.md`](data-retention.md). Each model gets its inventory
row in that document in the pull request that adds it, which
`tests/guardrails/retention-policy-coverage.test.ts` enforces. That row follows
this table. A step that classifies a model otherwise amends this table in the
same pull request and gives its reason. Periods for a regulatory artefact stay
a legal decision, as that document records.

| Model (step) | Class | Reason |
|---|---|---|
| `AgentHarnessScan` (`1a`) | Business record | The signed record of what one scan saw and who signed it: an inventory of the client's own agents, which a tenant deletion asks Inflect to remove, so it is purged with the tenant and is not a regulatory artefact (decision 11). The hash-chained `AGENT_HARNESS_SCAN_INGESTED` audit row, carrying the report digest and the signer, is what survives. No sweep deletes a scan by age. |
| `AgentHarnessScanItem` (`1a`) | Business record | One agent's derived level and verdicts in one scan. The matrix, `LEVEL_DROP` and the shortfall all read it, so it is kept with its scan, deleted with it and purged with the tenant (decision 11). |
| `DiscoveredAgent` (`1a`) | Business record | The current inventory, updated in place by every ingest and never deleted by age (decision 11). What any one scan saw is kept on its scan items, and nothing kept with a scan may be deleted with this row: scan items and acceptances reference it with `ON DELETE NO ACTION`, implemented by #3692, which replaces the `ON DELETE CASCADE` that #3688 shipped. |
| `AgentHarnessAcceptance` (`1a`) | Business record | A time-limited risk acceptance with an expiry and renewal lineage, classed with `ControlException`, whose shape it has (decision 7). It names people by user id, and its row says so ([DPIA](agentic-harness-scanner-dpia.md), condition 7). |
| `AgentHarnessScannerKey` (`1a`) | Configuration | One public key the tenant trusts to sign harness reports, bound to one registered scanner agent; public material only. Kept as long as the scans it verified, because a scan's signature is checkable only against the key that verified it. Shipped in #3688 with this class in `docs/data-retention.md`. |
| `AgentOwnershipTransfer` (`2a`) | Business record | Who handed an agent's accountability to whom, and when. Kept as long as `RegisteredAgent`, which is long-lived for the same incident-review question. |
| `PeerAgent` (`2e`) | Business record | An A2A peer registered as a principal: an owner, an endpoint, a signing-key reference, and a pinned card hash with who approved it and when. The class `RegisteredAgent` has, for the same reason: an incident review months later asks which peers agents could reach and who was accountable. |
| `AuditWorkpaper` (`3b`) | Regulatory artefact | The auditor agent's re-performance of one procedure for one period, with a one-way review stamp. An audit relies on it, so it is not pruned by age. |
| The sampled-workpaper review (`3d`) | Regulatory artefact | One row per sampled workpaper: the reviewer's outcome and stable dissent codes, with no free text. `AgentProposalSampleAudit` is the pattern and has this class; it cannot be reused, because every row of it requires a proposal. Kept as long as the workpaper it judges, because a disagreement rate whose history can be pruned cannot be trended. |
| The A2A task receipt, sent and received (`4b`) | Regulatory artefact | Signed evidence of an agent action, the class `AgentActionReceipt` has. That model holds receipts from an external mediator and fits neither a receipt Inflect signs nor a peer's, so `4b` either adds a model under this class or states why it reuses one. |
| `TenantSkill` (`4c`) | Configuration | The mutable head of one tenant skill: its status and which version is current. The class `AgentPolicyCard` has, for the same shape. |
| `TenantSkillVersion` (`4c`) | Regulatory artefact | One immutable version, with its content hash, its evaluation record and its approver. `WorkflowRun.mountedSkills` pins the hash a run mounted, so a version is kept and never edited, as `AgentPolicyCardVersion` is. Its instructions are encrypted at rest (#3680). |

Planned changes that add no model:

- `WorkflowRun.mountedSkills` (`1b`) takes its model's class, Operational. A
  prune of runs, if one is built, takes their pins with them.
- `TenantMembership`'s line-of-defence column (`3b`) takes its model's class,
  Configuration.
- Step `2b` writes execution rows, findings, notifications and tasks to existing
  tables. Its mode is a column on an existing model and takes that model's
  class.
- Step `2c` writes `ExternalWriteJournal` and prior-state rows to the existing
  external-write tables.
- Step `2d` stores no passport: passports are derived and emitted as `Evidence`
  (#3672).
- Step `3a` reuses `AccessReview` and `AccessReviewConnectedDecision`, as the
  `LEGACY_APP` campaigns do, and `AgentProposal` for narrowings. A pack that
  `3a` persists as a model of its own is a Regulatory artefact, kept with its
  campaign.
- Step `3c` writes `AuditWorkpaper` rows and finding proposals.
- Step `4a`'s scan health reads `AgentHarnessScan`. If `4a` gives an estate a
  model of its own, it is Configuration.
- Step `4d` uses `AuditPack`, `AuditorAccount` and `AuditorPackAccess`, and
  records the auditor's conclusion as `Evidence`.

### Pilot

The pilot client is Inflect, and the estate is Inflect's own (decision 10): the
production deployment, which is the Compose stack on the GCP VM
`inflect-compliance` in project `hazel-design-419410`, zone `europe-west1-b`
(CLAUDE.md, "Production VM"); Inflect's Entra tenant; MCP servers; the
GitHub workflows that build and release it; and
Inflect's own tenant on that deployment, where the report is pushed. Which
source kinds are in the pilot is decision 10. The rest of each row is derived
from repository files, and where the repository cannot tell, the row says so.

**No source has a named owner.** The owner has named no person for any of them
(decision 10) and the repository names none, so every Owner cell reads "Not
named" and the `0e` hardening item for named owners stays unticked. The gap is
tracked on #3664.

| Source kind | In the pilot | What it is | Evidence | Owner |
|---|---|---|---|---|
| The pilot as a whole | Yes | Inflect's own estate, reported into Inflect's own tenant | Decision 10; CLAUDE.md, "Production VM" | Not named |
| `entra-sp` | Yes | Inflect's Entra tenant: its service principals and app registrations. The repository shows that the product has an Entra app registration, because the Entra consent callback serves every tenant from one registered redirect URI; which directory holds that registration it does not say. | Decision 10; `src/app/api/integrations/mcp-server/callback/route.ts` | Not named |
| `mcp` | Yes | MCP servers. Decision 10 does not say which, and the repository cannot tell: #3686 reads every configured MCP server. The repository shows two kinds. Inflect serves its own: `/api/mcp`, read tools and propose tools behind the registration gate, and `/api/mcp/entra-grant`, a two-tool server whose intended client is Inflect's own dispatch job, both in the `app` service (`/api/mcp/token` is the token exchange, not a server). And a tenant can connect external MCP servers, through the `mcp-server` and `legacy-mcp` integration providers; which ones Inflect's own tenant has connected is production data the repository cannot read. | Decision 10; `src/app/api/mcp/route.ts`, `src/app/api/mcp/entra-grant/route.ts`, `src/app/api/mcp/token/route.ts`, `src/app-layer/integrations/providers/mcp-server-provider.ts`, `src/app-layer/integrations/providers/legacy-mcp/index.ts` | Not named |
| `cicd` | Yes | GitHub Actions, 15 workflows on `main`. One calls a model: `skills-evaluate.yml` (#3690), run on manual dispatch, calls the Anthropic API with the repository secret `ANTHROPIC_API_KEY` (decision 8). The `flue` job in `ci.yml` runs the agent loop against a scripted fake provider, with no credential and no network. Three non-human identities act: the per-run `GITHUB_TOKEN` that every job receives, a GitHub App release identity minted from `RELEASE_APP_ID` and the secret `RELEASE_APP_PRIVATE_KEY` (`release.yml`), and the `ANTHROPIC_API_KEY` of `skills-evaluate.yml`. `ghcr-publish.yml` publishes the image the VM runs. | Decision 10; `.github/workflows/*.yml` | Not named |
| `inflect-register` | Yes, always | The `RegisteredAgent` rows of Inflect's own tenant. Which tenant that is, and what its register holds, is production data the repository cannot read. | Decision 10; `prisma/schema/agentic.prisma` `RegisteredAgent` | Not named |
| `vault` | No | Inflect has no secrets vault. CLAUDE.md names a host environment file on the VM as where production secrets live, and an environment file is not an inventory the scanner can read. | Decision 10; CLAUDE.md, "Production VM" | Not named |
| `okta-app` | No | Not named by the owner, and no repository file names an Okta org of Inflect's. | Decision 10 | Not named |
| `runtime` | No | Agent runtimes were not named by the owner. Listed as inventory only: the Compose stack runs `postgres`, `pgbouncer`, `redis`, `clamav`, `app`, `worker`, `watchtower` and `caddy`; `app` and `worker` run one image, `ghcr.io/rodnapamet/inflect-compliance:latest`; agentic runs execute as the `agent-run-execute` job; and `watchtower` pulls new `app` and `worker` images, a non-human principal with no model loop. | Decision 10; `deploy/docker-compose.prod.yml`, `src/app-layer/jobs/executor-registry.ts`, CLAUDE.md | Not named |

What this means for Phase 1:

- **Three of the scanner's four sources are in the pilot.** The scanner of
  #3686 reads `entra-sp`, one vault, `mcp` and `inflect-register`. Inflect has
  no vault, so the recommendation on #3664 that the pilot sit on Entra with a
  vault and an internal MCP server is met for Entra and MCP and not for the
  vault. `1a`'s exit can be met on the sources the estate has when the vault reader is
  proven on the fake scanner's fixtures alone, the pilot scan lists only the
  sources it read, and the #3686 pull request names the vault reader as the one
  with no pilot population rather than reading as a pilot of all four. That
  reader's first real population is a later client estate of step `4a`.
- **Okta and runtime readers have no pilot population either.** Neither kind
  is in the pilot. Step `4a` (#3678) adds an Okta reader and no step builds a
  `runtime` reader; a reader for either is proven on fixtures only, because
  Inflect's estate has none named.
- **`cicd` is in the pilot and no step builds its reader.** #3686 reads the
  four kinds above and #3678 adds Okta and a second vault, so the pilot scan
  does not read the three CI/CD identities in the table. Which step builds a
  `cicd` reader is open.
- **The register has no read for the scanner.** No tool in
  `src/lib/mcp/tools/` and no resource in `src/lib/mcp/resources.ts` returns
  `RegisteredAgent` rows, so `1a` builds the read its scanner uses, under the
  ingest key, `admin.agent_harness_ingest` ([Permission keys](#permission-keys)).
- **The scanner is registered first.** `scan.scanner.agentId` names the scanner
  in the register (rule 1), so the pilot scanner is a registered agent in
  Inflect's tenant before the first scan.
- **The GCP project's own service accounts are not covered.** They are
  agent-shaped principals, and no kind in `SOURCE_KINDS` reads them, so no
  planned step scans them.

### Phases and steps

| Phase | When | Steps |
|---|---|---|
| 0 Mobilise (#3655) | Oct–Nov 2026 | `0a` ladder and contract (#3660) · `0b` skill standard (#3661) · `0c` passport spec and A2A threat model (#3662) · `0d` audit procedures (#3663) · `0e` DPIA, keys, retention, pilot (#3664) |
| 1 See and teach (#3656) | Nov 2026–Jan 2027 | `1a` scanner and ingest (#3665) · `1b` skill evaluation gate and run pins (#3666) · `1c` skill text scan (#3667) · `1d` first IAM skills (#3668) |
| 2 Own and connect (#3657) | Jan–Mar 2027 | `2a` intake, retirement cascade, ownership transfer (#3669; cascade and transfer shipped in #3698) · `2b` orphan pass and hygiene (#3670) · `2c` service-principal disable (#3671) · `2d` integration passport (#3672) · `2e` A2A peers and card pinning (#3673) |
| 3 Decide and assure (#3658) | Mar–Jun 2027 | `3a` agent recertification (#3674) · `3b` workpapers and independence (#3675) · `3c` auditor agent (#3676) · `3d` workpaper sampling (#3677) |
| 4 Scale and certify (#3659) | Jul–Oct 2027 | `4a` more estates and sources (#3678) · `4b` A2A pilot (#3679) · `4c` tenant-authored skills (#3680) · `4d` external reliance (#3681) · `4e` methodology hand-over (#3682) |

### Rules every step obeys

1. The governing agent is a registered agent.
2. Authority only ever narrows; widening is a human act.
3. Every hop narrows and is attributable.
4. A skill teaches; it never grants.
5. No write without a proposal; no external write without prior state.
6. Third-party content is untrusted.
7. Fail closed, never silently; zero is never complete.
8. The auditor is not the auditee.
9. Evidence is append-only and withdrawn, not deleted.
10. A stop control is proven, not assumed.
