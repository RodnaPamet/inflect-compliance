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

### The reference scanner and client estates

Step `4a` (#3678) built the scanner the ingest was waiting for, as the owner
decided on 2026-10-18: `packages/agent-harness-scanner`, a CLI that reads an
estate's sources, signs an `inflect-agent-harness/1` report with a key the
tenant registered, and posts it unchanged to the ingest. It reads two sources
behind one interface. `okta-app` is Okta's service apps and API tokens with
their owners, and `vault` is Azure Key Vault's secrets and certificates tagged
with the principal they belong to. Azure Key Vault is the only vault adapter.
Both are read-only by the shape of the wire: a source can only issue a GET, the
OAuth token exchange is the one POST, and every request the scanner can make is
declared in `scanner-surface.ts`, whose hash is the report's manifest hash. A
source that cannot be read is reported `INCOMPLETE` with the contract's reason,
including one whose credential is missing. The scanner checks its report with
the ingest's own schema and secret scan before it signs, and never reads a
register link from the estate's own labels: `registeredAgentId` is `null` from
both sources. The Entra, MCP and register sources and the container are #3686.

A tenant declares each client ESTATE it scans (`AgentHarnessEstate`): a name,
the registered scanner agent whose signed reports are the estate's, the cadence
a complete scan is expected at, and each source with a named owner who is an
active member. One estate per scanner, because a report cannot name an estate.
The harness tab on `/agents/reports` shows each estate's schedule health: the
last complete scan per estate and per source, and STALE once that scan is older
than one and a half cadences or there is none. A scan counts for an estate only
when it is complete, found agents, and read every declared source in full.
Declaring takes `admin.agent_registry`; reading the health takes the inventory
key, and the edge admits an AUDITOR to that read. No client estate is scheduled:
the owner schedules them as step `0e` names them, and the view is proven on
three fixture estates. Putting a client estate under the scanner, with the
labels it reads owners and principals from, is
[`docs/agent-harness-scanner-onboarding.md`](agent-harness-scanner-onboarding.md).

### The first IAM skills, on a declared workflow

Step `1d` (#3668) declared the two IAM skills, `harness-level-assessment` and
`nhi-ownership-attribution`, on the workflow `discovered-agent-review`
(`src/lib/agentic/workflows/discovered-agent-review.ts`). It is the only
workflow that declares a skill. It asks for the Flue engine and is read-only:
one read and one synthesis, no proposal and no checkpoint.

- **A run names one discovered agent.** `requiredInput` is
  `discoveredAgentId`, so a run without it, or with a blank or non-string
  value, is refused at admission before its row exists, on either engine.
- **The run mounts exactly the two skills.** A Flue run is pinned to both, by
  name, version and hash, through the mount gate and the committed evaluation
  records. A static run mounts none and records `[]`.
- **The agent's facts come from the scan.** The run's read step calls
  `get_discovered_agent`, an MCP read tool over `getDiscoveredAgentFacts`
  (`src/app-layer/usecases/agent-harness-facts.ts`). The tool returns where the
  scans found the agent, whether the register holds it, the owner its source
  records, the newest scan and whether that scan read every source in full, and
  that scan's per-criterion observations and tools, as reported. It returns no
  level. Like every read of the agent inventory, it takes the read-only
  `admin.agent_registry_view` (#3710), which a key reaches only through the
  named scope `admin:agent_registry_view`.
- **Each answer has an output contract.**
  `src/lib/agentic/iam-skill-outputs.ts` parses each skill's answer before
  anything may use it. In an assessment, every criterion, named by the ladder's
  own id, either cites an evidence reference or says it is not evidenced. A met
  verdict with no reference is refused rather than read as not met, and an
  answer that states a level is refused. An attribution's status is the
  reconcile engine's outcomes minus `LINKED` (`SUGGESTED`, `AMBIGUOUS` or
  `UNMATCHED`), so a confirmed or linked owner cannot be expressed, and the
  grade and the outcome are checked against the answer's own signals. The
  workflow engine does not apply the contracts to a run. The attribution
  contract has one consumer, the registration intake (below), which parses an
  answer a request carries and records it as provenance; nothing on `main`
  calls the assessment contract outside its tests.

#3710 closed the two gaps that kept a Flue run of the review from reading the
agent it names:

- **The model is given the run's input.** `runMessage`
  (`src/lib/agentic/flue/run-message.ts`) carries the definition's declared
  `requiredInput` values, read out of the sealed run context under verification,
  and nothing else from it. Each value is cleaned and neutralised, fenced as
  untrusted data, labelled with its provenance (`agent.run-input`,
  `THIRD_PARTY_INGESTED`) and followed by the data-only handling rule that tool
  results carry. The decision digest is taken over that message, input
  included. A context that does not verify, or a declared value that cannot be
  carried whole, refuses the run before anything is dispatched.
- **An agent's key can be offered the read tool.** The tool takes the inventory
  view key, and a key carrying `admin:agent_registry_view` and `mcp:read`, held
  by an agent granted `get_discovered_agent`, is offered it; neither `*` nor
  `admin:*` carries the scope.

Where a tenant's runs resolve to the static engine, a signed-in member holding
the inventory read runs the read and the synthesis, and no skill is mounted;
where they resolve to Flue, a signed-in person cannot start the review at all,
because a Flue run must be started by an active registered agent.

### Integration passport and A2A threat model

Two documents specify UC5's new parts.

- `docs/integration-passport.md` specifies the passport of every `mcp-server`
  connection: twelve fields, the table and column each is read from, and the
  drift rule applied to each, with who owns the resulting finding. Step 2d
  (#3672) built it. The weekly `integration-passport-sweep` (Sunday 05:45 UTC)
  assembles each passport from stored rows, compares it with the newest one
  emitted before this week after verifying that one against its digest, and
  raises a `Finding` for each change, assigned to the connection's accountable
  owner or, while it has none, owned by the tenant's OWNER role. The week's
  passports are emitted as Evidence on ASI04, ASI03, ISO/IEC 27001 A.5.19 and
  A.5.15, and SOC 2 CC9.1 and CC6.1, and that artefact is where next week's
  comparison reads its prior; a tenant with none of those controls is told so by
  a finding rather than left quiet. Both facts the specification listed as gaps
  now have a source: `IntegrationConnection.ownerUserId`, named under
  `admin.manage`, and `McpToolManifestPin.declaresWrite`, stored when a person
  accepts an external definition. An OWNER reads one connection's passport,
  live, on that connection's page under the integrations admin page.
- `docs/a2a-threat-model.md` models A2A traffic in both directions, hop by hop,
  naming for each hop the trust boundary, the STRIDE threats and the control.
  No A2A traffic exists on `main`. The model requires that A2A traffic pass
  through the existing funnel with no second authority model, and that a peer's
  agent card be pinned by hash so that a changed card refuses traffic until a
  person re-approves it; steps `2e` and `4b` build both. Each control is either
  on `main`, cited by file and symbol, or assigned to step `2e` or `4b`, and
  the residual risks list every assigned control with the step that closes it;
  the controls it assigned to `2d` are on `main`. On 2026-10-17 the owner
  accepted three of those controls as requirements on step `4b`: inbound A2A is refused for a tenant that has not set both
  `agentMonthlyTokenBudget` and `agentMaxConcurrentRuns` (R13); a run started
  by an inbound A2A task never dispatches an external write above
  `PROPOSE_ONLY` (R17); and a peer's agent card is re-checked before every
  message against a copy at most 15 minutes old (R18). Which permission key
  governs the peer register and pin routes (R3) the owner decided at step `2e`,
  on 2026-10-18: `admin.agent_registry`.

### A2A peer register and card pinning

Step `2e` (#3673) builds the record an A2A peer is admitted against, and
[`docs/a2a-mapping.md`](a2a-mapping.md) maps A2A tasks onto the funnel with no
second authority model. No task is exchanged on `main`; that is `4b`.

- `PeerAgent` holds admission facts only: an accountable owner, the supplier, a
  risk tier, the peer's Ed25519 signing key, the approved card pin and a status
  (RETIRED is one-way). Row-level security with `FORCE`, no `DELETE` for
  `app_user`, and one writer, `src/app-layer/usecases/peer-agents.ts`.
- There is no trust on first use. Registration records the card it saw and pins
  nothing. A person reads the live card and approves the hash they reviewed; the
  approval reads the card again and refuses when it moved, and an API key never
  approves one. The hash (`a2a-agent-card/v1`) covers the whole card, with
  component hashes for its text, its endpoint and the rest.
- `checkPeerAdmission` is the gate `4b` calls before every message: ACTIVE,
  owner still an ACTIVE member, tier scored, pinned, card readable and
  unchanged, or refused.
- The routes under `/api/t/:slug/admin/agents/peers` take
  `admin.agent_registry`, by owner decision (2026-10-18, R3).

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
internal audit is to approve its procedures and sample its workpapers. The
line-of-defence value, the auditor independence check and the workpaper record
are on `main` (step `3b`, below), and library v1 runs on the control-test runner
as the registered auditor agent (step `3c`, below). Each procedure's PwC
methodology reference is open: PwC supplies it, and it is recorded on #3663
when given.

### Agent retirement and ownership transfer

Retiring an agent (`DELETE /api/t/:slug/admin/agents/[agentId]`, under
`admin.agent_registry` alone) is one transaction that takes its authority apart
and records what it took: every `TenantApiKey` bound to the agent is revoked,
including keys already past their expiry, and so is every harness scanner
signing key it holds; its `RegisteredAgentTool` grants are deleted; its `PENDING`
proposals move to `EXPIRED`, unreviewed; its policy card is frozen, so no further
`AgentPolicyCardVersion` can be written while its history stays readable; an
open ownership transfer is closed — cancelled while it is live, marked expired
once it has lapsed; and its per-agent evidence artefacts for the month still
open are withdrawn. The status is written first and the audit
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

Evidence is withdrawn per agent, and only per agent (#3700). Beside the
tenant-wide monthly artefacts of receipts and decision records, the 06:30 UTC
emitter writes each agent's own: `AGENT_ACTION_RECEIPTS_PER_AGENT` on ASI02 and
ASI04 and `AI_DECISION_RECORDS_PER_AGENT` on ASI09 and EU AI Act Art. 12, the
same controls, cut from the same read, for every registered agent that is not
retired and has at least one attributed record of that kind in the month. A
receipt is attributed to the agent its submitting API key is bound to, never to
the agent the mediator's record names; a decision record to the agent stamped on
it at insert from the writing request's key, which the append-only trigger keeps
from changing. A record with neither is counted in the tenant-wide artefact
only. Retirement withdraws the agent's per-agent artefacts whose month is still
open, with reason `AGENT_RETIRED`, archiving their Evidence behind a dated
notice and deleting nothing; the summary row records how many and the basis
`PER_AGENT_OPEN_PERIODS`. Its artefacts for closed months stay as they are,
and no tenant-wide artefact is touched: a database CHECK refuses an
`AGENT_RETIRED` withdrawal on a row with no agent. Nothing is written current
for a retired agent again: the emitter plans no artefact for it, each
per-agent write locks the agent row before writing and refuses a retired agent,
a trigger refuses the same write from any writer, and a row withdrawn for
retirement is never revived. Retirements before #3700 recorded
`POPULATION_LEVEL_ONLY` and withdrew nothing, which was true of the artefacts
then. Agents retired before #3698 keep whatever keys and grants they held then.

An agent's owner moves only by a two-step transfer
(`…/admin/agents/[agentId]/ownership-transfer` and `…/ownership-transfer/complete`,
both a literal `requirePermission('admin.agent_ownership')`, and API-only: no
page calls them). Step one names the new owner, who must be an active OWNER, an
active `AI_ADMIN`, or an active ADMIN whose custom role carries
`admin.agent_ownership` — the routes sit under `/admin/`, where the edge admits
the ADMIN and OWNER built-in roles, and `AI_ADMIN` on the agent paths only;
step two is completed by that person and never
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

The recipient set was narrower until #3699: both routes took
`admin.tenant_lifecycle`, so an agent passed only to an OWNER, which the owner
accepted on 2026-10-18 as the interim state (decision 14 below). #3699 moved
both routes to their own key, `admin.agent_ownership`, which OWNER and the new
built-in `AI_ADMIN` role hold and ADMIN does not. The edge gate reads the
built-in role in the tenant being called, from the session's membership for
that tenant (#3701), so the recipient set is exactly what step two meets. Until
#3701 it read the primary — oldest — membership's role instead (decision 15
below).

### The owner-orphan pass and credential hygiene

When a person leaves, the agents they own are stopped (`2b`, #3670). The
`agent-owner-orphan-pass` job runs at 05:15 UTC, after the HRIS sync (04:00) and
the leaver (05:00), and finds the ACTIVE, non-placeholder agents whose
accountable owner has left. An owner has left when they hold no ACTIVE
membership in the tenant — DEACTIVATED, REMOVED, INVITED, or no row at all,
which is what the product's own Remove action leaves — or when the one
`Employee` whose `workEmail` matches their address by exact normalised email
(`emailKey`) is TERMINATED. Two employees sharing that key is recorded as
`HR_MATCH_AMBIGUOUS` and matches nobody; a name never matches. The rules are pure,
in `src/lib/agentic/owner-orphan.ts`.

What the pass does is the tenant's own mode, `TenantSecuritySettings.agentOrphanPassMode`,
on the identity ladder's shape and enum: DISABLED (the default), DRY_RUN,
AUTOMATIC, one rung per widen, seven days and one recorded pass at DRY_RUN before
leaving it, narrowing always allowed. It reuses `LADDER`, `isAboveClamp` and
`coerceStoredMode` from `src/lib/identity/write-ladder.ts` and the identity
policy's dwell constants. An OWNER sets it at
`PUT /api/t/:slug/admin/agents/owner-orphan-pass`, behind a literal
`requirePermission('admin.tenant_lifecycle')`; the same route's `GET` returns the
mode, the dwell state and the recorded passes. `ORPHAN_PASS_MAX_MODE` is a source
constant at AUTOMATIC, kept as the brake.

- At DRY_RUN the pass records each orphan, with its signals, on an
  `IntegrationExecution` row (`agentic.owner_orphan_pass`, status
  NOT_APPLICABLE) and rings `AGENT_OWNER_DEPARTED` to the workspace's ACTIVE
  OWNERs, never to the departed owner. It writes no kill, no suspension, no
  task and no credential change.
- At AUTOMATIC it engages each orphan's kill switch first and suspends it
  second, both as the system: `engageOwnerDepartedKill` writes the kill with
  `reasonCode = OWNER_DEPARTED` and `engagedByUserId = system:agent-owner-orphan-pass`,
  and `suspendAgentForOwnerDeparture` moves the agent from ACTIVE to SUSPENDED.
  Both refuse any context but the system principal at actor type JOB, so both
  audit rows carry no user and name no person. Where the departed owner's
  manager is known — their `Employee.managerEmployeeId`, matched to an ACTIVE
  member by the same email rule — the pass opens one ownership-transfer task
  for them per kill engagement.
- Every refusal writes a row naming its reason: `MODE_DISABLED`,
  `MODE_ABOVE_CLAMP`, `NO_ACTIVE_AGENTS`. A pass that threw writes an ERROR row.
  This differs from the identity leaver on purpose, whose two ladder refusals
  write no row.

An `OWNER_DEPARTED` kill is lifted only by the agent's new owner, with a reason,
after a two-step ownership transfer of the agent has COMPLETED after the kill.
`liftKillSwitch` refuses before that, and refuses a holder of the kill key who is
not the new owner. The database holds the same rule: a CHECK pins the code to
the system actor on an AGENT-scope row, so a person typing "OWNER_DEPARTED" as a
reason makes an ordinary kill, and a trigger makes the code immutable and
refuses the lift for any writer without the completed transfer. The incident
report counts these kills apart from incidents, under
`incidents.owner_departed_engagements` and `incidents.owner_departed_in_force_now`,
as it counts the drill canary's. Lifting the kill does not reactivate the agent:
reactivation is the register's ordinary act.

The `agent-credential-hygiene` job runs at 06:00 UTC and raises findings, and
writes nothing else: no credential is revoked, rotated, expired or rebound. Its
five rules, in `src/lib/agentic/credential-hygiene.ts`, read every live agent
credential and every `mcp-server` connection: a key unused for 30 days, a key
with no expiry, a key older than the rotation age, a key bound to no registered
agent, and a connection with an app-only grant and no named owner. An agent
credential is a key bound to an agent or one the `/api/mcp` capability gate
admits; an integration key with resource scopes only is not one, and fires
nothing. The rotation age is
the tenant's own `apiKeyRotationDays` on `TenantSecuritySettings` (#3708), 7 to
730 days and held there by a database CHECK, set by an OWNER or ADMIN on the
security settings page; a tenant that has set none gets the 90-day product
default. The row and each finding name the days applied and whether they are
the tenant's setting or the default, and a change of age moves findings through
the ordinary reconcile on the next pass: a key that no longer exceeds the age
has its finding resolved, a key that now does gets one, and a finding that keeps
firing is restated to name the age now applied. A connection's accountable owner is
`IntegrationConnection.ownerUserId` (passport field P11, step `2d`), counted only
while that person holds an ACTIVE membership, so an app-only connection fires
its rule until an owner who is still a member is named. Findings are
`OBSERVATION`s with `sourceKind = AGENT_CREDENTIAL_HYGIENE`, written through
`FindingRepository` and audited as a JOB; one closes only when a complete read
shows its rule no longer fires, and a connection whose secret will not decrypt
is held, neither raised nor resolved.

Both jobs emit outcome metrics (`agentic.owner_orphan_pass.*`,
`agentic.credential_hygiene.*`), and their execution rows are excluded from the
tenant-wide control-check list.

### The AI_ADMIN role

`AI_ADMIN` (#3699) is a built-in tenant role that runs the agent register and
can own and receive agents. It holds the eight agent keys
(`admin.agent_registry`, `agent_registry_view`, `agent_tool_exposure`,
`agent_policy_card`, `agent_kill_switch`, `agent_external_tools`,
`agent_harness_ingest` and `agent_ownership`) on top of READER's read access,
and none of the tenant-wide admin keys: no members, SSO, SCIM, billing or
security settings, tenant lifecycle, owner management, DSAR register or admin
console. Its coarse tier is READER's, and the agent usecases accept the agent
key as their floor, so it writes nothing outside the agent register. The view
key (#3710) opens `/agents/runs`, `/agents/proposals` and the governance pack
to it read-only: approving a proposal, starting or stopping a run and filing
the pack each ask the role-tier write or `evidence.edit`, which it does not
hold. The edge admits it to
`/api/t/:slug/admin/agents/**`, `/api/t/:slug/admin/mcp/quarantine` and the
agent redirect pages under `/t/:slug/admin` (`AI_ADMIN_ADMIN_PATH_PREFIXES` in
`src/lib/auth/guard.ts`) and refuses it on every other admin path.

It shipped in two deploys, for the same reason `UNCLASSIFIED` did: a running
container whose Prisma client predates a value fails every read of a row that
carries it. Deploy 1 added the value and taught every reader of a role to handle
it, with nothing writing it. Deploy 2 gave it exactly two writers (decision 16):

- **The members page.** An OWNER moves an EXISTING member into or out of the
  role (`updateTenantMemberRole`, `MEMBER_ROLE_CHANGE_ROLES`); both directions
  need `admin.owner_management`, as promoting to OWNER does, so an ADMIN can do
  neither. Nobody is invited straight into it: invite as another role, then
  promote.
- **An Entra group mapping**, at sign-in and on a SCIM Groups push
  (`ENTRA_MAPPABLE_ROLES`, `SCIM_GROUP_ASSIGNABLE_ROLES`). A mapping that yields
  the role is created, changed and removed by an OWNER only. In a tenant with
  mappings the mapping decides the role at sign-in, as for every other role. An
  equal-priority tie between `AI_ADMIN` and ADMIN, EDITOR or AUDITOR decides
  nothing and leaves the membership as it is; a tie with READER goes to
  `AI_ADMIN`, which contains READER (`TIE_DECIDABLE_AGAINST` in
  `src/lib/auth/entra-role-mapping.ts`).

An `AI_ADMIN` membership never carries a custom role, whose base role would
replace it at resolution: both orders are refused with the named reason
`BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`, on the members page and by the
group sync. Since #3720 the same rule holds for OWNER, on every writer, and a
database CHECK backs both roles. Every other membership-role writer still reads
`ASSIGNABLE_TENANT_ROLES` in `src/lib/roles.ts`, which excludes the role:
invites, the direct member add, an access review's MODIFY, the custom-role base,
SCIM's `roles[]` attribute and SSO JIT. `tests/unit/ai-admin-role-writers.test.ts`
holds the census.

### Registration intake from a shadow-agent finding

A person holding `admin.agent_registry` takes a `SHADOW_AGENT` finding into the
register with `POST /api/t/:slug/admin/agents/intake` (a literal
`requirePermission('admin.agent_registry')`; `registerShadowAgent` in
`src/app-layer/usecases/agent-registration-intake.ts`). One transaction creates
a provisional `AiSystem` entry at `UNCLASSIFIED` and a `RegisteredAgent` in
`DRAFT`, unscored, linked to it. This is deploy 2 of the `UNCLASSIFIED` tier:
the intake is the value's only writer, through
`AiSystemRepository.createProvisional`, which takes no tier parameter, and
`tests/guards/ai-risk-tier-unclassified-writers.test.ts` holds both facts. The
request declares the agent's name and its three exposure axes, because a scan
does not observe them, and carries no classification and no tier. Since #3712
the harness tab's shadow list calls it: each shadow row carries its finding id
and the intake row already made from the agent, and a person holding the
intake's own permission (`canRunRegistrationIntake`) gets a Register action on
a row with a finding and no intake row. The dialog's owner picker is the ACTIVE
roster, starts empty, and needs a confirmation that names the chosen person;
no exposure axis is pre-selected.

- **The owner is confirmed by a person.** The request names `ownerUserId`, who
  must be an `ACTIVE` member of the tenant, and sets `confirmOwner: true`.
  Without both it is refused, whatever else it carries. It may also carry the
  `nhi-ownership-attribution` answer. The intake parses that answer through the
  1d contract and records it in the agent's audit row as provenance: the signals
  it rested on, by kind and evidence pointer, and whether the confirmed owner is
  the person it suggested. The suggested person's reference is not recorded.
  The suggestion never supplies the owner.
- **One discovered agent, at most one register row.** The new row carries the
  discovered agent's id in `RegisteredAgent.intakeDiscoveredAgentId`, under a
  unique index on `(tenantId, intakeDiscoveredAgentId)`. A second intake is
  refused, and so is the loser of two racing intakes; the loser's AI-system
  entry rolls back with its transaction. An agent a scan has already linked to
  a live register row is refused too.
- **Each refusal is named** in `error.details.reason`: `FINDING_NOT_FOUND`,
  `NOT_A_SHADOW_AGENT_FINDING`, `DISCOVERED_AGENT_NOT_FOUND`,
  `ALREADY_REGISTERED`, `ALREADY_REGISTERED_BY_INTAKE`, `OWNER_NOT_CONFIRMED`,
  `OWNER_NOT_ACTIVE_MEMBER`, `SUGGESTION_INVALID` and
  `SUGGESTION_FOR_ANOTHER_AGENT`. Another tenant's finding is not found, and
  another tenant's member is not an active member here.
- **The finding and the discovered agent are not written.** The harness ingest
  is the only writer of `DiscoveredAgent`, so the new row is linked to the
  discovered agent by the next scan that sees it. A scan that reports the row's
  id links it as before. A scan that claims no register id (or one the register
  does not hold) links it by the register's own record,
  `intakeDiscoveredAgentId`, when that row is live and not RETIRED (#3712); a
  link made that way closes the `SHADOW_AGENT` finding only on a complete scan.
  A report that names a different live register row wins, and the disagreement
  is audited as `AGENT_INTAKE_LINK_CONFLICT` on the intake row. The rule is in
  the pure planner, `harness-findings.ts`. Until a scan links it the agent still
  appears on the shadow list. The intake writes an audit row on the finding
  naming the register row it became.
- **An intake agent cannot go into service until it is classified.**
  `activateRegisteredAgent` refuses `AI_SYSTEM_UNCLASSIFIED` while the agent's
  entry is `UNCLASSIFIED`, before it checks the score (`UNSCORED`). Both checks
  sit in the status writer for every move to `ACTIVE`. The entry is classified
  with `POST /api/t/:slug/ai-systems/:systemId/classification`
  (`classifyAiSystemEntry`, `assertCanWrite`, the gate for authoring an entry).
  It runs the same classifier over a questionnaire answered in full: each of the
  four answers is required, and `null` means "does not apply". It then links the
  tier's obligations. It moves an entry out of `UNCLASSIFIED` once and refuses
  an entry that is already classified. The AI-system detail page offers
  Classify on an `UNCLASSIFIED` entry to a caller who may write; every question
  starts unanswered, "Does not apply" is an explicit answer, and the form cannot
  submit until all four are answered (#3712).

### Agent recertification campaigns

An access review over registered agents is a campaign with the `AGENT` scope,
created at `POST /api/t/:slug/access-reviews/agents` under
`access_reviews.create` (step `3a`, #3674). Creation freezes one subject per
agent that can hold authority — `DRAFT`, `ACTIVE` or `SUSPENDED`, not deleted,
not the legacy placeholder — into `AccessReviewConnectedDecision`, with the
agent's owner at that moment stamped on the row, and refuses an empty
population (`NO_SUBJECTS`). The scope value reached the database enum in a first
deploy that only taught readers.

A campaign names the registered agent that prepares its packs, and may name a
second. Each is `ACTIVE`, risk-scored, not stopped by a kill switch or an open
breaker, and granted `get_agent_recertification_evidence`; each failing term is
refused by name, at creation and again at preparation. The first prepares every
pack but its own, so no agent prepares the pack it is reviewed by. Its own pack
is prepared by the second agent when one is named, and otherwise by the person
who starts the preparation, on the same static workflow with no agent bound, for
that one pack only; the pack records `PERSON_STATIC_SELF_PACK`, and the database
refuses an agent-free pack for any other subject. An admin starts the
preparation; the agents' runs are theirs: each is a workflow run attributed to
its agent, whose one read goes through the funnel under that agent's grants,
card and autonomy terms, so the admin's own permissions never widen what it
reads. A tenant with a single agent can run a campaign.

Each pack is prepared by the `agent-recertification-pack` workflow, a static
run of one READ step on the `get_agent_recertification_evidence` read tool and
one pure SYNTHESIS step, one run per 20 agents. The pack holds the
agent's grants with grantor and date, which granted tools it called in the 90
days before the campaign, its proposals and their outcomes per grant, its card
versions since its last closed campaign, its time-bounded grants and whether
each expired on time, guard flags, breaker trips, kill engagements and its
harness level and drift, with a `sha256:` hash of the sections, the run that
read them and the agent whose run it was. Packs are readable by the campaign's reviewer and by holders of
`admin.agent_registry`, as the subjects are.

A pack proposes a narrowing for each grant held for the whole window with no
recorded call in it. Accepting one (`…/agent-narrowings/[id]`, under
`access_reviews.decide`) deletes that grant and records that it did; nothing in
a campaign adds a grant or writes a card. A subject is decided after its pack
exists and its narrowings are decided, and never by the agent's owner, frozen or
current. Every decision, narrowing and sample answer is a one-way stamp the
database enforces.

The close (`…/close`, under `access_reviews.close`) requires a non-empty
population with every subject decided, a pack for each and no pending
narrowing. It raises a remediation task per `REVOKE` or `MODIFY`, draws a sample
of the decisions with the ASI09 sampler for a second person who neither made the
decision nor owns the agent (`…/agent-samples/[id]`), and files a JSON evidence
document against ISO/IEC 27001 A.5.18, SOC 2 CC6.1 and OWASP ASI03. The
document's hash is the SHA-256 of its stored bytes and recomputes from the
campaign's rows; the packs read shows whether it still does.

### Disabling a contained agent's service principal

When the owner-orphan pass contains an agent at AUTOMATIC, it also asks for the
agent's Entra service principal to be disabled (`2c`, #3671). The request goes
through the external write ladder, and nothing in the pass calls Microsoft
Graph. An agent's principal is the one the harness ingest reconciled to it: a
`DiscoveredAgent` whose `discoveredId` is `entra:sp:<objectId>` and whose
`registeredAgentId` is the agent. An agent reconciled to two principals is
refused as ambiguous. An agent counts as contained while an `OWNER_DEPARTED`
kill is in force for it.

The write goes to an outbound MCP endpoint, `POST /api/mcp/entra-service-principal`,
a sibling of the grant endpoint. It advertises two tools: `disable_service_principal`,
which sets `accountEnabled` to false and nothing else, and its paired prior-state
read, `read_service_principal_state`. The endpoint is reached only through an
`mcp-server` connection configured for it, so the disable has its own rung. It
takes the grant endpoint's per-connection token, refuses a token whose connection
names another endpoint, and writes `AUTHZ_DENIED` for every refusal it can
attribute to a tenant. It refuses to disable a principal that is already
disabled, the principal the Entra connection authenticates as, and a Microsoft
first-party principal.

The request finds the one connection whose `disable_service_principal` has a
nominated prior-state read, and acts on that connection's rung:

- DISABLED: nothing, not even the read.
- DRY_RUN: the paired read runs, and a `RECORDED_ONLY` journal row records it.
- PROPOSE_ONLY: an `EXTERNAL_WRITE` proposal carrying the prior state, for a person
  to approve. No agent is attributed to it.
- AUTOMATIC: a `PENDING` journal row carrying the prior state, under the one
  approved template whose only open field is `servicePrincipalId`, bounded to the
  `contained_orphan_agent_entra_service_principals` population — and only for a
  link a person has confirmed.

A person confirms the link before any unattended disable (owner decision,
2026-10-18). Someone holding `admin.agent_registry` confirms, through
`POST /api/t/:slug/admin/agents/:agentId/service-principal-link`, that a
discovered principal is the agent's own; `GET` on the same route lists the
agent's links and whether each is confirmed. The confirm refuses unless the
harness currently links that principal to that agent and to no other principal,
so it confirms the scanner's link and never makes one. The confirmation is an
`AgentServicePrincipalConfirmation` row recording who confirmed which discovered
agent and when. A database trigger refuses any rewrite of it. When a later scan
links the principal to another agent, or the agent to another principal, the
harness ingest invalidates the confirmation; a scan that moves the link back
does not revive it. At AUTOMATIC an unconfirmed link is refused
`LINK_UNCONFIRMED`, at the request and again at send, and the pass reports
PARTIAL. DRY_RUN and PROPOSE_ONLY act on the scanner's link, and the proposal
states whether the link is confirmed, so the approving person sees it.

A completed ownership transfer lifts the kill, and at every rung the dispatch
checks at send that the principal still belongs to a contained agent, so a
disable approved or opened before the transfer is not sent after it. A missing pairing, a failed prior-state read, or a read that answers about
another principal refuses the write. The external-write dispatch sends the
disable and settles it `ACCEPTED`. The reconcile promotes it to `APPLIED` only
when the paired read shows the principal disabled, where it showed it enabled
before the write. A write that the far end answers with an error result settles
`INDETERMINATE`.

The pass records each outcome on its decision by the `DiscoveredAgent` id, never
the principal's object id. An outcome that needs an operator makes the pass
PARTIAL; an agent with no principal, a tenant with no paired endpoint and a
connection at DISABLED do not. Each request emits
`agentic.owner_orphan_pass.service_principal_disable`.

The connection's Entra application holds `Application.Read.All` for the read and
`Application.ReadWrite.OwnedBy` for the disable (owner decision, 2026-10-18), not
`Application.ReadWrite.All`. `OwnedBy` writes only principals whose application
Inflect's application owns, so the Inflect application is added as an owner of
each agent's application. A principal it does not own is read, then the disable
is refused by Graph with `Authorization_RequestDenied`, and the journal row
settles `INDETERMINATE` for a person to finish in the customer's directory.

### Line of defence, auditor independence and workpapers

Step `3b` (#3675) carries decision 3: the second line owns and operates the
auditor agent, internal audit samples its workpapers, and the auditor is not the
auditee (rule 8).

- **A membership's line of defence.** `TenantMembership.lineOfDefence` is
  FIRST, SECOND, THIRD or NULL, and NULL means not declared, which never
  satisfies a check. It is set at
  `PUT /api/t/:slug/admin/members/:membershipId/line-of-defence`, behind a
  literal `requirePermission('admin.owner_management')` whose rule sits above
  the members catch-all. `setMembershipLineOfDefence` also requires the caller's
  built-in role to be OWNER, so a custom role carrying the key does not make an
  ADMIN an OWNER. It refuses an API key or agent context, and refuses a member
  setting their own line. Every change writes a hash-chained
  `MEMBER_LINE_OF_DEFENCE_CHANGED` row with the line before and after; setting
  the same value writes nothing. ADMIN and `AI_ADMIN` are refused, and no API
  key carries the key. Every membership-creating path leaves the line NULL. It
  is API surface only: the members page does not show it.
- **An auditor agent.** `RegisteredAgent.isAuditor` marks an agent that
  re-performs procedures. Every other agent that is not RETIRED and not
  soft-deleted is an audited agent, DRAFT and SUSPENDED included. An agent is
  refused as an auditor, with `details.reason` `AUDITOR_NOT_INDEPENDENT` and the
  failing terms in `details.independenceReasons`, unless its owner holds an
  ACTIVE membership, has a declared line, that line is SECOND, and owns no
  audited agent. The refusal is asked when the agent is registered as one
  (`registerAgent`), when an amend makes it one (`updateRegisteredAgent`), and on
  every move to ACTIVE (`assertActivatable`, the status writer). The trigger
  `registered_agent_auditor_independence` refuses the same rows for any writer
  that skips the usecase. The registration intake's schema is strict and has no
  such field, and `createRegisteredAgent` does not take it, so neither can make
  an auditor. Unmarking is never refused, and every workpaper keeps naming its
  author.
- **A later break raises a finding.** A completed ownership transfer,
  registering an agent (through any path, the intake included) to an auditor's
  owner, unmarking another auditor of the same owner, and an OWNER moving the
  owner's line each reconcile the ACTIVE auditors of the owner concerned. A
  break opens one HIGH `NONCONFORMITY` finding per auditor (`sourceKind`
  `AUDITOR_INDEPENDENCE`, `sourceRef` the agent id), or reopens a closed one. It
  does not suspend the auditor or refuse the change, and it closes nothing when
  the break is fixed: closing is a person's act. Every path that can make or
  break independence takes a per-tenant advisory lock first, and the trigger
  takes the same key, so a concurrent activation and registration serialise.
  An owner who leaves is the owner-orphan pass's case, not this one.
- **The workpaper record.** `AuditWorkpaper`, in
  `prisma/schema/audit-workflow.prisma`, holds what the catalogue says a
  workpaper records, as codes, identifiers and counts, with no free-text
  column; that is its encryption decision. `recordAuditWorkpaper` takes a job
  context or one that speaks for the auditor agent, never a person. The agent
  must be an ACTIVE, independent auditor of the tenant, and every evidence,
  proposal, finding and run reference must resolve in the tenant. CHECKs hold
  that a PASS needs a non-empty population, a drawn sample and no exception, and
  that a FAIL names an exception. A trigger refuses an author that is not an
  auditor, a row born reviewed, and a sample that differs from the first one
  drawn for the procedure and period, which is binding. Every column is fixed at
  insert apart from the review stamp, `reviewedAt` and `reviewedByUserId`, which
  `stampAuditWorkpaperReview` sets once. Only an ACTIVE SECOND- or THIRD-line
  member who does not own the auditor may set it (owner decision 2026-10-18,
  #3735; 3b shipped THIRD only). Which workpapers a reviewer is assigned stays
  internal audit's, in `3d`. A trigger refuses any other UPDATE from
  every role, and `app_user` holds no DELETE. Findings are linked through
  `AuditWorkpaperFinding`, which is insert-only, and nothing on the workpaper's
  path writes a finding. Reading workpapers takes `audits.manage`. The writer is
  the auditor agent's procedure handler (below); the review route is step
  `3d`'s (below), whose assigned reviewer sets the stamp when they answer.

### The auditor agent and audit procedure library v1

Step `3c` (#3676) runs library v1 — procedures 1 to 5 of the catalogue — on the
existing control-test runner, as the registered auditor agent. Library v1 is
proposed to internal audit and PwC, not approved or agreed by either:
`LIBRARY_V1_STATUS` in `src/lib/agentic/audit-procedure-library.ts` records
both as open, and every evidence row and finding proposal says so.

- **One runner.** A control-test plan of type INTEGRATION whose
  `automationConfig` names a `procedure` and an `auditorAgentId` runs it;
  the INTEGRATION handler dispatches `check` configs to the four agentic checks
  and `procedure` configs to `src/app-layer/services/audit-procedures/`. The
  plan carries the parameters (`leaverWindowHours`, `remediationWindowDays`), an
  optional larger sample and an optional pinned period; otherwise the run
  audits the latest month or quarter that has ended. Only a person who owns
  the named auditor sets, changes, pauses, archives, unschedules or deletes a
  procedure plan: every path that can stop one running refuses anyone else,
  an API key and an agent included, `AUDIT_PROCEDURE_PLAN_OWNER_ONLY`
  (`usecases/audit-procedure-plans.ts`), so the audited first line cannot
  switch off its own audit. A malformed config is a 400; a plan with no
  procedure is untouched by any of it.
- **It runs as the auditor.** Before reading anything the handler refuses —
  INCONCLUSIVE, with no workpaper and no proposal — unless the agent is
  registered, marked an auditor, ACTIVE, not stopped by a kill switch, holding
  only Inflect's read tools and `propose_finding`, and independent. Each
  proposal goes through the tool funnel under the auditor's identity, so its
  grant, card, kill switch, circuit breaker, autonomy ceiling and budgets
  apply; the principal is the auditor's owner, from that owner's own
  membership. Granting an auditor any other tool, marking an agent that holds
  one, and activating an auditor that holds one are refused
  `AUDITOR_REMIT_EXCEEDED`.
- **Re-performance.** Each procedure reads its population from raw rows, caps
  it at 5,000 units, freezes it, draws the keyed sample (or reuses the binding
  one) and judges each unit from raw rows. It never reads a check result, an
  execution result, a card or breaker count, a control-test verdict or an
  `executedAt` stamp; an ESLint block over the directory refuses those reads,
  and a finding write. An empty population is INCONCLUSIVE and does not stamp
  `Control.lastTested`.
- **One workpaper per run.** The workpaper is written in the runner's
  transaction, after the run's evidence, which carries the frozen id list.
  Each exception names the finding proposal it was raised as. A later run of
  the same procedure and period names the live proposal it already raised
  rather than raising it again, and links a finding a person created from it.
  The runner writes no Finding for a procedure run; nothing closes one.
- **Two readings of catalogue version 1**, recorded for internal audit and
  confirmed by the owner (2026-10-19): procedure 5 does not audit auditor
  agents' own windows (rule 8), and its A1 and A4 are asked at each recorded
  call in the hour. The check on the auditor is internal audit's sampling of
  its workpapers, step `3d`.
- **The pilot.** `leaverWindowHours` 24 and `remediationWindowDays` 14, agreed
  2026-10-19 for the pilot and entered on each plan; the library has no
  default. `scripts/audit-pilot-setup.ts --tenant=<slug> --owner=<email>`
  is how 3c's exit is met: a dry run by default, `--apply` to write, only
  through the usecases and as the owner. It registers the auditor, grants
  `propose_finding` alone, activates it once the owner has risk-assessed it,
  and schedules the five plans on the controls the catalogue's ISO/IEC
  27001:2022 identifiers map to, or on `--control` ids. A re-run writes
  nothing. Monthly procedures run on the 2nd at 06:17 UTC, quarterly ones on
  the 2nd of each quarter's first month.
- **The `iam-audit-procedures` skill** ships its evaluation set and no
  evaluation record, so no workflow declares it and no run mounts it. The
  auditor workflow, a workpaper read tool and the record are #3749.

### Internal audit's sampling of the workpapers

Step `3d` (#3677) is the check on the auditor that decision 3 and rule 8 call
for: internal audit re-performs the auditor agent's workpapers, and the rate at
which it agrees is a reported figure with its definition. The owner's decisions
of 2026-10-19 are on the issue.

- **The draw.** A scheduled sweep, `audit-workpaper-sample-review`, runs on the
  3rd of each month at 09:40 UTC, a day after the pilot's procedure plans run on
  the 2nd. It decides each workpaper not yet drawn with the ASI09 sampler's
  keyed score against the tenant's rate, `TenantSecuritySettings.workpaperReviewSamplePercent`:
  100 by default and in the pilot, a per-tenant setting so it can be lowered
  without a code change. The epoch is fixed by the workpaper's period
  (`audit-workpaper-review@<periodLabel>`), so the draw re-derives from the
  seed, the epoch, the workpaper and the rate; each row records the epoch, the
  seed's fingerprint and the rate. Each workpaper is decided on its own, so a
  later sweep never re-draws one it passed over at the same rate. One row per
  workpaper, `AuditWorkpaperSampleReview`, a Regulatory artefact the tenant
  purge keeps.
- **The assignment.** A keyed draw from the same epoch among the tenant's ACTIVE
  members whose line of defence is THIRD, minus the auditor agent's current
  owner, even when that owner is third-line. With nobody eligible the row is
  UNASSIGNED with a named reason (`NO_THIRD_LINE_MEMBER`,
  `ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR`, `AUDITOR_OWNER_UNKNOWN`). A later sweep
  re-draws only an unanswered row nobody can answer, never a valid assignment,
  and a trigger refuses an ineligible assignee for any writer.
- **The answer.** Only the assigned reviewer answers, a person, still ACTIVE and
  third-line, and not the auditor's current owner; each other caller is a 403
  with a named reason and an `AUTHZ_DENIED` row, and the trigger refuses the
  same answerer below the usecase. The answer is CONCURRED, DISSENTED or
  INDETERMINATE, once, with stable dissent codes pinned by a CHECK and no free
  text, and it sets the workpaper's review stamp. The page is
  `/t/:slug/audits/workpaper-reviews`: the reviewer's own queue and a sheet with
  the workpaper and an inline form, behind `audits.view`.
- **A dissent queues a finding proposal.** Each DISSENTED answer queues one
  FINDING proposal through `createAgentProposal`, under the reviewer's session
  with no agent, so the queue tiers it `HUMAN_AUTHOR` and a person decides it
  with the ordinary approval. It names the workpaper, the codes and the
  reviewer. A per-review lock, a write-once link on the review and the
  proposal's origin ref (`proposedBySessionRef`) raise it once across retries;
  the sweep raises one the answer could not.
- **The number.** Report 6 of the governance pack (`workpaper-review`), on
  `/agents/reports` and in the filed document: drawn, unassigned, awaiting,
  indeterminate and concluded counts, and the re-performance agreement and
  disagreement rates over concluded reviews only. A drawn but unreviewed
  workpaper is never agreement, INDETERMINATE and UNASSIGNED are excluded and
  shown beside the rates, and with nothing concluded both rates are
  NOT_ASSESSED, never 100%.

### Tenant-authored skills

Step `4c` (#3680) lets a tenant teach its own agents with a skill it wrote, which
is how third-party methodology, PwC's among it, enters the product: under the
author's licence and behind the lifecycle a repository skill has (decision 5).
`docs/agent-skill-standard.md` ("Tenant-authored skills") is the full rule set.

- **Models.** `TenantSkill` holds the name, unique in the tenant and never a
  repository skill's, and is append-only. `TenantSkillVersion` holds everything
  that reaches a model: the frontmatter fields, the instructions (encrypted at
  rest), the licence and source the author supplied, the workflows it mounts
  on, the content hash and the evaluation record. Both have row-level security
  with `FORCE`, and `app_user` deletes neither. The only writer is
  `src/app-layer/usecases/tenant-skills.ts`.
- **Review.** A version moves one way, `DRAFT` → `IN_REVIEW` → `APPROVED` →
  `RETIRED`, by trigger. Approval names the content hash the reviewer read, is
  refused for the version's author by the usecase and by a CHECK, and is refused
  for an API key. Every act takes `admin.agent_skill_review`. An edit is a new
  version at `DRAFT`; the approved version keeps serving until the new one is
  approved, and is then retired as superseded.
- **Evaluation.** The author attaches an evaluation record in the repository's
  format to the draft. It is stored only if it passes, recomputed from its raw
  answers, and recomputed again at submission, approval and every mount. The
  product does not run the model that answers the set (owner decision,
  2026-10-18).
- **Mounting.** A Flue run mounts its workflow's repository skills, then its
  own tenant's approved versions that name the workflow, through the same text
  scan and evaluation recomputation, plus a check that the decrypted text still
  hashes to the approved hash. The read is the run's own tenant only. The
  catalogue budget counts both kinds together, at approval and at every run.
  `WorkflowRun.mountedSkills` records a tenant skill with `origin: 'tenant'` and
  its version's id.
- **Surface.** The Skills tab lists the repository corpus read-only and the
  workspace's skills beside it, with authoring and review for holders of the
  key.

### What the six use cases stand on

| Area | Shipped on `main` | Not built |
|---|---|---|
| Register and funnel | Register with four scorer axes and a required owner; an unscored tier means deny. Deny-by-default grants, versioned and pinned policy cards, the autonomy ceiling, audience-scoped tokens, a registration gate on by default, credential and kill state re-read on every call. Seven separate agent admin keys, and a built-in `AI_ADMIN` role that holds them and no tenant-wide admin key, assigned by an OWNER on the members page or by an Entra group mapping an OWNER made (#3699). The AI-system risk tier has an `UNCLASSIFIED` value for a provisional entry, which every reader shows as not classified and never as `MINIMAL`. Its only writer is the registration intake, which registers a shadow agent in DRAFT through such an entry; activation refuses the agent until the entry is classified. The harness tab's shadow list offers the intake, the AI-system page classifies a provisional entry, and a scan that claims no register id links the agent to the row the intake registered. | Signed harness reports are ingested, levels derived and stored per scan, shadow and below-bar agents raised as findings, and shortfalls accepted for a bounded time. The harness matrix tab on `/agents/reports` renders the scans, their drift and the shadow list; owners accept shortfalls there; each month's scans are emitted as evidence against ASI10 and ASI03, `NEEDS_REVIEW` unless every trusted scanner's latest scan is complete and non-empty. The reference scanner reads Okta and Azure Key Vault, and a tenant declares the client estates it scans, with a schedule health view per estate and per source (#3678); its Entra, MCP and register sources and its container are #3686, so nothing scans the pilot estate and no client estate is scheduled. |
| Runs and communication | Four specialists reachable by delegation, depth one, fan-out capped per turn per tenant; tools and skills only narrowed. Delegation spans in the run ledger. Runtime-supplied tools reported. Run input scanned before the run exists. Automation rules invoke agents with named refusals. An integration passport per external connection, compared week on week, with drift raised as findings owned by the connection's accountable owner and the week's passports emitted as Evidence. | No task is exchanged with an A2A peer: peers are registered and their cards pinned, and the exchange is `4b`. |
| Skills | Nine original, licensed skills. Eight have a committed evaluation record that passes the mount gate; `iam-audit-procedures` ships its evaluation set and no record, and no workflow declares it (#3749). The two IAM skills are declared by one workflow, `discovered-agent-review`, which mounts exactly those two on the Flue engine; each skill's answer has an output contract its consumers parse it through. The loader enforces name, description, licence, byte budgets and the standard's optional metadata, and scans every skill's text at load: a refused skill is listed on the read-only Skills tab by rule id, and a run that declares it fails closed, as a run declaring an unknown skill does. Every shipped skill ships an evaluation set; the catalogue budget binds per workflow and per run. A run mounts a skill only with a passing evaluation record (the mount gate, refused before the run row exists), and every run pins each mounted skill's name, version and hash, write-once, shown on the run detail page. A tenant authors its own skills on the Skills tab under `admin.agent_skill_review`; a version mounts, in its own tenant only, once a person other than its author approves its hash with a passing record, and the run pin marks it `origin: 'tenant'`. The author attaches that record and the server recomputes it; the product does not run the set (owner decision, 2026-10-18). | No runtime check holds a run's answer to its output contract. |
| Writes and approvals | Propose-not-commit with the approver count pinned and four-eyes in the database; expiry, output guard, quarantine, ASI09 sample audits. Agent recertification campaigns (above): a frozen, non-empty population of registered agents, reviewer packs prepared by registered agents' read-only workflow runs — never an agent's own, which a second agent or a person prepares — narrowings that only delete a grant, the owner barred from deciding their own agent, one-way stamps in the database, evidence whose hash recomputes, and a sample for a second person. | Campaigns are started by hand; nothing schedules one. |
| External systems | MCP server and client, delegated and app-only grants, one outbound wire; external writes on a four-rung ladder with prior-state reads and a journal; Entra time-bounded access packages with verified expiry; Entra service-principal disable for contained agents, promoted to applied only on a read. | — |
| Assurance | Control-test runner with four agentic checks (an empty population is inconclusive); audit-prep workflow; auditor role, pack-scoped auditor accounts; a catalogue of eight audit procedures, adopted for this repository, proposing library v1 as five. A line of defence per membership, set only by an OWNER; the auditor independence check at registration, amend and activation, with a finding on a later break; the one-way workpaper record with a binding sample and a review stamp set once by the third line. Library v1 runs on the control-test runner as the registered auditor agent: five procedures re-performed from raw rows, one workpaper per run, every exception a finding proposal, an empty population inconclusive; only the auditor's owner sets or switches off a procedure plan; `scripts/audit-pilot-setup.ts` sets the pilot up with its agreed parameters. Internal audit samples the workpapers: a monthly keyed draw at the tenant's rate (100% in the pilot), each assigned to an ACTIVE third-line member who does not own the auditor or recorded UNASSIGNED with a reason, answered once in codes on `/audits/workpaper-reviews`, every dissent a finding proposal a person decides, and the re-performance agreement rate in the governance pack with its definition. | Internal audit's approval and PwC's agreement of the catalogue are open; procedures 6 to 8 have no handler; the auditor's skill has no evaluation record and no workflow declares it (#3749); nothing but the database sets a tenant's workpaper sampling rate. |
| Identity chain | Sync, HRIS, joiner, leaver in a fixed order with a dwell; every directory write journaled; legacy-application recertification campaigns. Retiring an agent revokes its keys, drops its grants, expires its pending proposals, freezes its card and withdraws its per-agent evidence for the open month; its owner moves only by a two-step transfer. When its owner leaves, the owner-orphan pass suspends it and engages an `OWNER_DEPARTED` kill that lifts only after a completed transfer, and requests the disable of its Entra service principal through the external write ladder; a daily hygiene pass raises findings for weak agent credentials, judged by the tenant's own key rotation age or a 90-day default. | — |

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
    routes, was decided at step `2e` on 2026-10-18: `admin.agent_registry`, as
    the model recommended, with `admin.agent_external_tools` kept for the call.
    (`2e`, `4b`)

### Decisions recorded by the owner on 2026-10-18

The owner made these while reviewing the retirement cascade and ownership
transfer of `2a` (#3698). They continue the numbering above, and none of them
changed what #3698 built; #3700 then built the step decision 13 called for.

13. **Retirement withdraws the agent's per-agent evidence for open periods, and
    nothing tenant-wide.** As decided with #3698, every `AgenticEvidenceArtefact`
    was a tenant-wide aggregate per period with no agent column, so the cascade
    withdrew none and recorded the basis `POPULATION_LEVEL_ONLY`. The owner chose
    the same day to add per-agent evidence that a retirement can withdraw, as its
    own step, and #3700 built it under that decision: two per-agent kinds with an
    agent column, per-agent emission against the same targets, and the reason
    `AGENT_RETIRED`, which the cascade applies to the agent's open-period
    per-agent artefacts. The basis it records is now `PER_AGENT_OPEN_PERIODS`.
    Closed periods keep their evidence, and tenant-wide artefacts are never
    withdrawn for a retirement. (`2a`, `2a-evidence`)
14. **Transfer recipients stay narrow for now.** An agent passes only to an
    OWNER, or to an ADMIN whose custom role carries `admin.tenant_lifecycle`.
    This is the accepted interim state. A new built-in `AI_ADMIN` role widens who
    can receive an agent, in its own pull request (#3699); the edge gate is not widened
    for the transfer paths in the meantime. (`2a`) Widened by #3699 deploy 1 on
    2026-10-18: both routes take a new key, `admin.agent_ownership`, held by
    OWNER and `AI_ADMIN`; the edge admits `AI_ADMIN` to the agent paths only.
    ADMIN does not hold the key — the default the issue named, kept pending the
    owner's confirmation.
15. **The edge gate's primary-membership limitation stays documented, not
    fixed, in `2a`.** The edge reads the role of the session's oldest
    membership, not the role in the tenant being called. It fails closed, and
    #3701 tracks the fix. (`2a`) Fixed by #3701 on 2026-10-18: the edge now
    reads the role in the tenant the URL names.
16. **`AI_ADMIN` holds all six agent keys and none of the tenant-wide admin
    keys.** It holds `admin.agent_external_tools` too, which the issue's list
    did not name. A call to an external tool still needs a pinned manifest a
    person approved, a grant on the agent and `EXTERNAL_EGRESS` reach.
    `admin.agent_ownership` is held by OWNER and `AI_ADMIN`; ADMIN does not
    hold it. Reading agent runs, proposals and the governance pack moved to the
    view key in #3710, which `AI_ADMIN` holds. Approving a proposal still
    needs write on the domain it changes, so `AI_ADMIN` does not approve. (`2a`,
    #3699) **Assignment (deploy 2, decided 2026-10-18):** an OWNER assigns the
    role to an existing member on the members page, and removes it; an ADMIN
    can do neither, and nobody is invited straight into it. No `AI_ADMIN`
    membership carries a custom role. A tenant may also map an Entra group to
    it; such a mapping is an OWNER's change, and it applies at sign-in and on a
    SCIM Groups push. SCIM's `roles[]` attribute, SSO JIT, invites, the custom-role
    base and an access review's MODIFY never produce it.
17. **The owner-orphan pass has no blast-radius breaker.** At AUTOMATIC it
    contains every orphaned agent it finds, however many. Stopping an unowned
    agent is the conservative direction, and it is reversible by transfer, lift
    and reactivation. The identity leaver's breaker exists because a directory
    disable acts on a customer's people. The orphan pass acts only on agents.
    The key rotation age is a per-tenant setting since #3708, with the 90-day
    product default for a tenant that sets none. (`2b`)
    *Note (2026-10-18):* with `2c` the pass can also open unattended directory
    writes, the disable of a contained agent's service principal. The owner
    re-confirmed this decision for those writes: no breaker; the existing
    AUTOMATIC cap of 50 writes per connection per hour bounds a mass departure,
    and each write needs a person-confirmed link. (`2c`, #3671)
18. **The agent inventory gets a view key.** `admin.agent_registry_view` is
    read-only and has an API-key scope, so an agent granted
    `get_discovered_agent` can read the discovered agent it reviews. It also
    gates reading agent runs, proposals and the governance pack. `AI_ADMIN` and
    AUDITOR hold it, and the DPIA names the model as a reader of the source
    owner reference. (`1d`, #3710) Shipped by #3710. Neither `*` nor `admin:*`
    carries the scope, so no key issued before it changes. Filing the pack into
    the evidence library is a write and stays on `admin.agent_registry` and
    `evidence.edit`, so `AI_ADMIN` and AUDITOR read the pack and do not file it.
    The DPIA's condition 12 is closed by the owner's decision of 2026-10-18: the
    external model provider's sub-processor row names this data, with no code
    gate.
19. **A registered agent prepares each reviewer pack, and never its own; a
    person may prepare the preparer's own.** An agent campaign names an ACTIVE,
    scored agent granted `get_agent_recertification_evidence`; the person who
    asks only starts its runs, which read through the funnel under the agent's
    own terms. Every agent able to prepare is in the frozen population, so it
    prepares every pack but its own. Its own pack is prepared by a second named
    agent when the campaign names one, and otherwise by a person on the static,
    agent-free path, for that one pack only, recorded as
    `PERSON_STATIC_SELF_PACK`. This relaxes the first half for that one pack and
    leaves the auditor-is-not-the-auditee rule whole, and it lets a tenant with
    a single agent run a campaign. (`3a`, #3674)
20. **Narrowings and the decision sample are their own models.**
    `AccessReviewAgentNarrowing` and `AccessReviewDecisionSampleAudit`, not
    `AgentProposal`: a proposal kind would be another two-deploy enum, and the
    queue's expiry and four-eyes rules are not a recertification's. The closing
    evidence is filed against SOC 2 CC6.1 in place of CC6.3, which neither SOC 2
    representation carries, as the legacy campaign substitutes CC6.1 for CC6.2.
    Creation is `POST /access-reviews/agents` under `access_reviews.create`.
    (`3a`, #3674)

### Permission keys

Decided in step `0e` (#3664) and signed with it (decision 9). This covers every
privileged route the step issues plan through Phase 4, and records the routes
of `1a` that #3688 shipped as they are on `main`. The key for the A2A peer
register and pin routes of `2e`, the one row left open here (decision 12), was
decided by the owner at step `2e` on 2026-10-18. Every route below carries a literal `requirePermission` and
a rule in `src/lib/security/route-permissions.ts`, except the two endpoints
under [Token-gated endpoints](#token-gated-endpoints), which say why. Key names
follow `PERMISSION_SCHEMA` in `src/lib/permissions.ts`.

**Four keys of the `admin` domain**: the sixth agent key, which `1a` shipped,
the seventh, which #3699 shipped, the inventory view key, which #3710 shipped,
and one new key:

| Key | Gates | Granted by role | Bearer tokens |
|---|---|---|---|
| `admin.agent_harness_ingest` | Submitting a signed report, `POST /api/t/:slug/admin/agents/harness-scans` (`1a`, shipped in #3688), and the scanner's read of the register (`1a`, below) | OWNER, ADMIN | The `admin:harness_ingest` scope grants it and nothing else (`SCOPE_ACTION_MAP` in `src/lib/auth/api-key-auth.ts`). `*` carries it too: `*` is ADMIN's set minus the four agent-governance flags, and ADMIN holds it |
| `admin.agent_ownership` | Proposing, reading, cancelling and completing an agent ownership transfer, `…/admin/agents/[agentId]/ownership-transfer` and `…/complete` (`2a`, shipped in #3699; `admin.tenant_lifecycle` until then) | OWNER, AI_ADMIN. Not ADMIN, which holds `admin.agent_registry`: an agent's accountable owner must not be movable by the role that owner is accountable to. An OWNER can grant it to an ADMIN through a custom role | Not carried by `*` (ADMIN's set, which lacks it), and no scope maps to it |
| `admin.agent_registry_view` | READING the agent inventory (#3710): the register list and one agent's row (`GET …/admin/agents`, `GET …/admin/agents/[agentId]`), the harness scans and the matrix (`GET …/admin/agents/harness-scans`, `/agents/reports?tab=harness`), the client estates' schedule health (`GET …/admin/agents/harness-estates`, #3678), one discovered agent's facts (`get_discovered_agent`), and the governance pack (`GET …/admin/agents/reports`, `/agents/reports`). Also agent runs and proposals (`/agents/runs`, `/agents/proposals`, and the run routes `…/agent-runs/[id]/stream` and `…/checkpoint`), with `admin.view` as the other key that opens them. Every inventory read also admits `admin.agent_registry`, so nobody who read the inventory before the split lost it. Read-only: filing the pack, every register write, scanner keys, peers, intake, acceptances and estate declarations stay on `admin.agent_registry` | OWNER, ADMIN, AI_ADMIN, AUDITOR. A custom role may carry it | The `admin:agent_registry_view` scope grants it and nothing else. Neither `*` nor `admin:*` carries it (`WILDCARD_EXCLUDED_ACTIONS` in `src/lib/auth/api-key-auth.ts`), so every key issued before it resolves as it did, and an agent reads the inventory only through a key minted for that read |
| `admin.agent_skill_review` | Authoring, evaluating, submitting, approving, rejecting and retiring a tenant skill, `…/admin/agents/skills/tenant/**` (`4c`, shipped in #3680) | OWNER, ADMIN, AI_ADMIN. AI_ADMIN because it holds every agent key (decision 16), and #3680 classified this one as an agent key | Not carried by `*` (subtracted explicitly, because ADMIN holds it), and no scope maps to it |

- **Reading scans takes the inventory view key.** `GET …/admin/agents/harness-scans`
  lists scans under `admin.agent_registry_view` or `admin.agent_registry`, and
  `listHarnessScans` in `src/app-layer/usecases/agent-harness-scans.ts` refuses
  a caller with neither (`mayReadAgentInventory` in `src/lib/agent-inventory-read.ts`).
  #3687 builds the harness matrix and the shadow list as a tab on
  `/agents/reports` through `listHarnessScans`, behind the same read; the
  scanner-key register on that tab stays on `admin.agent_registry`, and a
  reader without that key is offered no shortfall action. `4a`'s scan health
  reads the same scans under the same key. `1d`'s MCP read tool
  `get_discovered_agent` (#3668) takes the view key as well, through the named
  scope. The view-key question this section used to leave open — an auditor's
  read of the inventory, which the `agent_registry` docstring named and left
  undone — was closed by the owner on 2026-10-18 (#3710): AUDITOR holds the key,
  and the edge admits an AUDITOR to a GET of exactly the inventory routes
  (`AUDITOR_ADMIN_READ_PATHS` in `src/lib/auth/guard.ts`): the four #3710 named,
  and `…/harness-estates` since #3678 (owner decision, 2026-10-19).
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
- **The scanner reads the register by its ingest key.** The human register
  read takes the inventory view key, which a key reaches only through
  `admin:agent_registry_view` (#3710), and that read returns the whole
  inventory. The scanner reads the register only to reconcile what it ingests,
  so `1a`'s read tool is authorized on `admin.agent_harness_ingest` and is served by
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
  by the version's author, as does a CHECK below it (#3680). `*` does not
  carry it, for the reason it does not
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
| Read scans, the harness matrix and the shadow list (`1a`) | `admin.agent_registry_view`, or `admin.agent_registry` | Shipped in #3688 for `GET …/admin/agents/harness-scans` under the register key; #3687 reads the matrix through `listHarnessScans` (above); #3710 moved both to the inventory read. |
| Add, list or revoke a trusted scanner key (`1a`) | `admin.agent_registry` | Shipped in #3688 at `…/admin/agents/harness-scanner-keys` and `…/harness-scanner-keys/[keyId]`. It decides whose reports the tenant believes (above). |
| Record, renew or list an `AgentHarnessAcceptance` (`1a`) | `admin.agent_registry`, held by the agent's owner | Shipped in #3688 at `…/admin/agents/harness-acceptances` (`GET`, `POST`). The route takes `admin.agent_registry`, and `acceptHarnessShortfall` in `src/app-layer/usecases/agent-harness-acceptance.ts` refuses anyone but the registered agent's owner, because accepting a risk is the act of the person accountable for it. A shadow agent has no owner, so it is registered before its shortfall can be accepted. There is no separate approval: a renewal is a new acceptance, of at most 365 days, that revokes the one in force. No API key carries `admin.agent_registry`, so no bearer token records an acceptance. |
| Registration intake from a `SHADOW_AGENT` finding (`2a`) | `admin.agent_registry` | Shipped at `POST …/admin/agents/intake` (#3669). It creates a DRAFT register row and its provisional AI-system entry. The usecase re-asserts the key, and the owner is the person the caller confirms. |
| Classify a provisional AI-system entry (`2a`) | no admin key: the usecase's `assertCanWrite` | Shipped at `POST /api/t/:slug/ai-systems/:systemId/classification` (#3669). It is the act `createAiSystem` already performs when it authors an entry, under the same gate, and the answers decide the tier. It is not under `/admin/`, so it is not a layer-1 privileged route; layer 2 finds `assertCanWrite` through the call graph. |
| Retire an agent, with its cascade (`2a`) | `admin.agent_registry` | The existing `DELETE /api/t/:slug/admin/agents/[agentId]`. See the cascade table below. |
| Propose, and complete, an agent ownership transfer (`2a`) | `admin.agent_ownership` | Decided as `admin.tenant_lifecycle` in 0e, the key whose docstring lists "transfer ownership"; #3699 gave it its own key so the built-in `AI_ADMIN` role can hold it without holding tenant lifecycle. ADMIN holds neither. |
| Set the orphan pass's mode (`2b`) | `admin.tenant_lifecycle` | The key `/admin/identity-write-policy` carries for the identity ladder: the mode decides whether a scheduled job stops agents unattended. Shipped by `2b` (#3670) at `…/admin/agents/owner-orphan-pass` (`GET`, `PUT`), with its rule above the register's catch-all. |
| Lift an `OWNER_DEPARTED` kill (`2b`) | `admin.agent_kill_switch` | The existing kill-switch route. The completed transfer is a precondition in the usecase, not a second key. Shipped by `2b` (#3670): the usecase also requires the lifter to be the agent's new owner, and a trigger holds both rules below it. |
| Show a connection's passport (`2d`) | `admin.manage` | The view sits on the integrations admin page, and `/admin/integrations(/.*)?` resolves to `admin.manage`, the key of the integration settings beside it. Passports are derived (#3672), so the view writes nothing. |
| Register an A2A peer, approve its card pin, re-approve a changed card (`2e`) | `admin.agent_registry` (owner decision, 2026-10-18; decision 12) | Registering and pinning decide which other organisation's agent the tenant talks to, which is configuration, and the register already approves tenant-wide external tool definitions. #3673 had proposed `admin.agent_external_tools`; that key stays the one for the call itself (`4b`), so the authority that acts never configures whom it talks to. Decision 4 has a person approve each pin, so the approval also refuses a caller whose context carries an `apiKeyId`. |
| Create, decide, close and read an `AGENT` campaign (`3a`) | `access_reviews.create`, `.decide`, `.close`, `.view` | The existing access-review routes and keys. |
| Read an `AGENT` campaign's reviewer packs (`3a`) | `access_reviews.view` | Every role holds it, and a pack carries register data, so the usecase narrows the read to the campaign's assigned reviewer or a holder of `admin.agent_registry`, as `decide` narrows to the assigned reviewer. |
| Accept or reject a narrowing in a campaign (`3a`) | `access_reviews.decide` | The effect is a grant delete, which only narrows, so it does not also need `admin.agent_tool_exposure`. |
| Set a membership's line of defence (`3b`) | `admin.owner_management` | OWNER-only; see below. Shipped by `3b` (#3675) at `PUT …/admin/members/[membershipId]/line-of-defence`, with its rule above the members catch-all. |
| Register or activate an auditor agent (`3b`) | `admin.agent_registry` | The existing routes. The independence check is a refusal inside `registerAgent` and `activateRegisteredAgent`. Shipped by `3b` (#3675), which also asks it of an amend that makes an agent an auditor (`PATCH …/admin/agents/[agentId]`, `isAuditor`). |
| Read workpapers (`3b`, `3c`) | `audits.manage` | `3b` (#3675) ships the read usecases (`listAuditWorkpapers`, `getAuditWorkpaper`) under this gate and no route. A workpaper on leaver timeliness or privileged access lists exceptions about named people's access, and `audits.view` is held by every role, READER included (`src/lib/permissions.ts`). OWNER and ADMIN hold `audits.manage`. A THIRD-line reviewer reads the workpapers assigned to them through `3d`'s review route, and the external auditor reads them in a pack (`4d`). An internal-audit member who needs every workpaper gets a custom role carrying `audits.manage`. `3b` places `AuditWorkpaper` in `prisma/schema/audit-workflow.prisma`, beside `Audit`. |
| Read and record the outcome of a sampled workpaper (`3d`) | `audits.view` | Shipped in #3677 at `GET …/audits/workpaper-reviews` and `GET`/`POST …/audits/workpaper-reviews/[reviewId]`, with `audits/workpaper-reviews` a root of `PRIVILEGED_ROOTS`. Every role holds it, so the usecase admits only the workpaper's assigned reviewer, who must be an ACTIVE THIRD-line member and must not own the auditor agent, as `decide` narrows to the assigned reviewer. Requiring `audits.manage` would shut out an internal auditor on the AUDITOR role, which does not hold it; the edge's AUDITOR rules apply only under `/admin/`, so nothing there is widened. The draw and the assignment are a scheduled sweep, with no route. |
| Show the scan health per estate and per source (`4a`) | `admin.agent_registry_view`, or `admin.agent_registry` | It reads scans, under the key their list takes. Shipped by #3678 at `GET …/admin/agents/harness-estates` and as a card on the harness tab. |
| Declare, change or remove a client estate (`4a`) | `admin.agent_registry` | Which scanner covers which estate, at what cadence and with whom accountable for each source, is the register's decision and never the scanner's: the ingest key cannot reach it. Shipped by #3678 at `POST …/admin/agents/harness-estates` and `PATCH`/`DELETE …/harness-estates/[estateId]`. |
| Kill an A2A peer, and lift the kill (`4b`) | `admin.agent_kill_switch` | The key that stops an agent stops a peer: there is no second authority model (decision 4). `*` does not carry it. |
| Author, approve or retire a tenant skill (`4c`) | `admin.agent_skill_review` | Shipped in #3680 at `…/admin/agents/skills/tenant/**`; see above. |
| Assemble a reliance pack, give the external auditor access, record the auditor's conclusion (`4d`) | The existing gates, and `audits.manage` for workpapers | No new route. Packs go through the pack usecases behind `assertCanManageAuditPacks`, which admits EDITOR; putting workpapers into a pack reads them, so that part also requires `audits.manage`, which EDITOR does not hold. Auditor accounts and pack access go through `/audits/auditors/*`, where account creation sits behind `assertCanManageAuditors` (OWNER and ADMIN) and the grant and revoke behind `admin.manage`. The conclusion is recorded as `Evidence` through the existing evidence routes. |

Steps `1b`, `1c`, `1d`, `3c` and `4e` plan no route of their own. `1b` extends
the run detail page that the existing run routes serve, and `3c`'s handlers run
on the control-test runner as the registered auditor agent, under that agent's
grants.

#### Token-gated endpoints

Two endpoints take no `requirePermission`, because no session or role stands
behind the caller, and nothing in the permission system can express who it is.
The first shipped in `2c` (#3671); the second is planned:

| Endpoint (step) | Gate | Why |
|---|---|---|
| `read_service_principal_state` and `disable_service_principal`, on the sibling route `/api/mcp/entra-service-principal` (`2c`, shipped) | The per-connection token, as on the grant endpoint, and the token's connection must be configured for this endpoint | The only client is Inflect's own external-write dispatch. The header of `src/app/api/mcp/entra-grant/route.ts` sets the precedent: the gate is the token, and every refusal that can be attributed to a tenant writes the `AUTHZ_DENIED` row `requirePermission` would have written. A sibling rather than the grant endpoint, because the rung is per connection. |
| The inbound A2A task endpoint (`4b`) | The pinned peer's signature over the task, checked against its approved card before the body is read | The caller is another organisation's agent, and its reach is the receiving agent's grants (decision 4), not a key of its own. Every refusal that can be attributed to a tenant writes `AUTHZ_DENIED`. |

Each is triaged into the `PROTOCOL_CREDENTIAL` class of
`tests/guardrails/api-route-has-some-authorization.test.ts`, where `/api/mcp`,
`/api/mcp/entra-grant`, `/api/mcp/entra-service-principal` and `/api/mcp/token`
sit. A new route fails that test until it is triaged.

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
| Cancel its open ownership transfer | `AgentOwnershipTransfer.status` moved from `PENDING` to `CANCELLED`, by the retiring actor; a lapsed one to `EXPIRED`, with no actor (added by `2a`, #3698: a retired agent can never be completed into) | `admin.agent_ownership` (`admin.tenant_lifecycle` until #3699), at `/admin/agents/[agentId]/ownership-transfer` |
| Withdraw its evidence artefacts | Its per-agent artefacts (`AGENT_ACTION_RECEIPTS_PER_AGENT`, `AI_DECISION_RECORDS_PER_AGENT`) whose period is still open move to `WITHDRAWN` with reason `AGENT_RETIRED`, their Evidence archived with a notice; closed periods and every tenant-wide artefact are untouched, and nothing is deleted (`2a-evidence`, #3700, following decision 13). The summary audit row records the count and the basis `PER_AGENT_OPEN_PERIODS`; #3698's retirements recorded `POPULATION_LEVEL_ONLY` | No key: only the emission usecase writes the table (`withdrawRetiredAgentEvidenceInTx` in `src/app-layer/usecases/agentic-evidence-emission.ts`), called by the cascade |

`2a` shipped the cascade (#3698): `retireRegisteredAgent` no longer refuses while
a proposal is `PENDING`, and its docstring records why the old refusal went.

**Agent ownership transfer.** Both steps of `transferAgentOwnership` carry a
literal `requirePermission('admin.agent_ownership')` (#3699; 0e decided
`admin.tenant_lifecycle`, which the rest of this paragraph records), and the
second step
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
see decision 14. Widened by #3699: the key is now `admin.agent_ownership`, held
by OWNER and `AI_ADMIN`, and the edge admits `AI_ADMIN` to the agent paths.)

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
| `AgentHarnessEstate` (`4a`) | Configuration | One client estate: the scanner whose reports describe it and the cadence they are expected at. A declaration of what should be scanned, never evidence that it was; removing one leaves its scans, which reference the scanner (#3678). |
| `AgentHarnessEstateSource` (`4a`) | Configuration | One source an estate's scanner reads and its accountable owner, by user id, which its row names DSAR-relevant. Replaced as a set when the estate's sources change (#3678). |
| `AgentOwnershipTransfer` (`2a`) | Business record | Who handed an agent's accountability to whom, and when. Kept as long as `RegisteredAgent`, which is long-lived for the same incident-review question. |
| `AgentServicePrincipalConfirmation` (`2c`) | Business record | A person's one-way confirmation that a discovered Entra service principal is a registered agent's own, invalidated when a scan re-links either side. Kept as long as `RegisteredAgent`, for the same incident-review question. Added by #3671 under the owner's 2026-10-18 decision that an unattended disable needs a confirmed link. Everything else `2c` writes goes to existing tables: `ExternalWriteJournal` rows, `EXTERNAL_WRITE` proposals, and an OWNER-nominated `ExternalToolPriorStateRead` pairing. |
| `PeerAgent` (`2e`) | Business record | An A2A peer registered as a principal: an owner, an endpoint, a signing-key reference, and a pinned card hash with who approved it and when. The class `RegisteredAgent` has, for the same reason: an incident review months later asks which peers agents could reach and who was accountable. |
| `AuditWorkpaper` (`3b`) | Regulatory artefact | The auditor agent's re-performance of one procedure for one period, with a one-way review stamp. An audit relies on it, so it is not pruned by age. |
| `AuditWorkpaperFinding` (`3b`) | Regulatory artefact | Added by `3b` (#3675), which this table did not plan: one finding a workpaper links, insert-only. Kept as long as its workpaper, because which findings a workpaper raised is part of the record. The finding is a plain id, bound at insert, so the link outlives a purged finding and nothing retained cascades from a table the purge deletes. |
| `AuditWorkpaperSampleReview` (`3d`) | Regulatory artefact | One row per sampled workpaper: the reviewer's outcome and stable dissent codes, with no free text. `AgentProposalSampleAudit` is the pattern; it cannot be reused, because every row of it requires a proposal. It is classed Business record since 2026-10-18 because it cascades from its proposal and goes with it in a tenant purge, so this review keeps the regulatory class only while nothing it cascades from is purged — and as built (#3677) it cascades only from its workpaper and the tenant, both retained; the finding proposal a dissent raises is a plain id. Kept as long as the workpaper it judges, because a disagreement rate whose history can be pruned cannot be trended. |
| The A2A task receipt, sent and received (`4b`) | Regulatory artefact | Signed evidence of an agent action, the class `AgentActionReceipt` has. That model holds receipts from an external mediator and fits neither a receipt Inflect signs nor a peer's, so `4b` either adds a model under this class or states why it reuses one. |
| `TenantSkill` (`4c`) | Configuration | The head of one tenant skill, the class `AgentPolicyCard` has. As built (#3680) it holds only the skill's name and creator and is append-only: which version is in service is that version's status, held to one per skill by a partial unique index, so the head has nothing to update. |
| `TenantSkillVersion` (`4c`) | Business record | One immutable version, with its content hash, its evaluation record and its approver. Planned as a regulatory artefact; #3680 classed it a business record instead, and the owner kept that class (2026-10-18), for two reasons. Its text is the tenant's, often a third party's methodology held only under the tenant's licence, which a tenant purge must not keep. And the runs whose pins name it are operational and purged with the tenant. A version is still never edited, and the hash-chained `TENANT_SKILL_*` audit rows, which carry its content hash, survive the purge. |

Planned changes that add no model:

- `WorkflowRun.mountedSkills` (`1b`) takes its model's class, Operational. A
  prune of runs, if one is built, takes their pins with them.
- `TenantMembership`'s line-of-defence column (`3b`) takes its model's class,
  Configuration.
- Step `2b` writes execution rows, findings, notifications and tasks to existing
  tables. Its mode is a column on an existing model and takes that model's
  class, and so does the kill's reason code, a column on `AgentKillSwitch`
  (shipped in #3670).
- Step `2d` stores no passport: passports are derived and emitted as `Evidence`
  (#3672).
- Step `3a` reuses `AccessReview` and `AccessReviewConnectedDecision`, as the
  `LEGACY_APP` campaigns do. It persists the pack (`AccessReviewAgentPack`),
  the narrowings (`AccessReviewAgentNarrowing`, not `AgentProposal`: a new
  proposal kind would be a second two-deploy enum, and the queue's expiry and
  four-eyes rules are not a recertification's) and the decision sample
  (`AccessReviewDecisionSampleAudit`) as models of their own, each a Regulatory
  artefact kept with its campaign.
- Step `3c` writes `AuditWorkpaper` rows and finding proposals.
- Step `3d`'s sampling rate is a column on `TenantSecuritySettings` and takes
  its class, Configuration. Its finding proposals go to the existing queue.
- Step `4a`'s scan health reads `AgentHarnessScan`, and its estates are
  `AgentHarnessEstate` and `AgentHarnessEstateSource`, both Configuration
  (above).
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
| `mcp` | Yes | MCP servers. Decision 10 does not say which, and the repository cannot tell: #3686 reads every configured MCP server. The repository shows two kinds. Inflect serves its own: `/api/mcp`, read tools and propose tools behind the registration gate, `/api/mcp/entra-grant`, a server whose intended client is Inflect's own dispatch job, and `/api/mcp/entra-service-principal`, its two-tool sibling for the `2c` disable, all in the `app` service (`/api/mcp/token` is the token exchange, not a server). And a tenant can connect external MCP servers, through the `mcp-server` and `legacy-mcp` integration providers; which ones Inflect's own tenant has connected is production data the repository cannot read. | Decision 10; `src/app/api/mcp/route.ts`, `src/app/api/mcp/entra-grant/route.ts`, `src/app/api/mcp/entra-service-principal/route.ts`, `src/app/api/mcp/token/route.ts`, `src/app-layer/integrations/providers/mcp-server-provider.ts`, `src/app-layer/integrations/providers/legacy-mcp/index.ts` | Not named |
| `cicd` | Yes | GitHub Actions, 15 workflows on `main`. One calls a model: `skills-evaluate.yml` (#3690), run on manual dispatch, calls the Anthropic API with the repository secret `ANTHROPIC_API_KEY` (decision 8). The `flue` job in `ci.yml` runs the agent loop against a scripted fake provider, with no credential and no network. Three non-human identities act: the per-run `GITHUB_TOKEN` that every job receives, a GitHub App release identity minted from `RELEASE_APP_ID` and the secret `RELEASE_APP_PRIVATE_KEY` (`release.yml`), and the `ANTHROPIC_API_KEY` of `skills-evaluate.yml`. `ghcr-publish.yml` publishes the image the VM runs. | Decision 10; `.github/workflows/*.yml` | Not named |
| `inflect-register` | Yes, always | The `RegisteredAgent` rows of Inflect's own tenant. Which tenant that is, and what its register holds, is production data the repository cannot read. | Decision 10; `prisma/schema/agentic.prisma` `RegisteredAgent` | Not named |
| `vault` | No | Inflect has no secrets vault. CLAUDE.md names a host environment file on the VM as where production secrets live, and an environment file is not an inventory the scanner can read. | Decision 10; CLAUDE.md, "Production VM" | Not named |
| `okta-app` | No | Not named by the owner, and no repository file names an Okta org of Inflect's. | Decision 10 | Not named |
| `runtime` | No | Agent runtimes were not named by the owner. Listed as inventory only: the Compose stack runs `postgres`, `pgbouncer`, `redis`, `clamav`, `app`, `worker`, `watchtower` and `caddy`; `app` and `worker` run one image, `ghcr.io/rodnapamet/inflect-compliance:latest`; agentic runs execute as the `agent-run-execute` job; and `watchtower` pulls new `app` and `worker` images, a non-human principal with no model loop. | Decision 10; `deploy/docker-compose.prod.yml`, `src/app-layer/jobs/executor-registry.ts`, CLAUDE.md | Not named |

What this means for Phase 1:

- **Three of the scanner's four sources are in the pilot.** The scanner reads
  `entra-sp`, one vault, `mcp` and `inflect-register`: #3686 adds the first,
  the third and the fourth to `packages/agent-harness-scanner` with its
  container, and the vault reader is #3678's Azure Key Vault reader (owner
  decision, 2026-10-19, which dropped #3686's own vault item). Inflect has
  no vault, so the recommendation on #3664 that the pilot sit on Entra with a
  vault and an internal MCP server is met for Entra and MCP and not for the
  vault. `1a`'s exit can be met on the sources the estate has when the vault reader is
  proven on the fake scanner's fixtures alone, the pilot scan lists only the
  sources it read, and the #3686 pull request names the vault reader as the one
  with no pilot population rather than reading as a pilot of all four. That
  reader's first real population is a later client estate of step `4a`. Step
  `4a` built the vault reader for Azure Key Vault, the only vault product
  (owner decision, 2026-10-18), proven on fixtures.
- **Okta and runtime readers have no pilot population either.** Neither kind
  is in the pilot. Step `4a` (#3678) built an Okta reader and no step builds a
  `runtime` reader; a reader for either is proven on fixtures only, because
  Inflect's estate has none named.
- **`cicd` is in the pilot and no step builds its reader.** #3686 reads the
  four kinds above and #3678 built the Okta and Azure Key Vault readers, so the pilot scan
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
| 2 Own and connect (#3657) | Jan–Mar 2027 | `2a` intake, retirement cascade, ownership transfer (#3669; cascade and transfer shipped in #3698, the intake under #3669 itself) · `2a-evidence` per-agent evidence that retirement withdraws (#3700) · `2b` orphan pass and hygiene (#3670, shipped; per-tenant key rotation age #3708) · `2c` service-principal disable (#3671, shipped) · `2d` integration passport (#3672) · `2e` A2A peers and card pinning (#3673) |
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
