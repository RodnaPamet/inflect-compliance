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

### What the six use cases stand on

| Area | Shipped on `main` | Not built |
|---|---|---|
| Register and funnel | Register with four scorer axes and a required owner; an unscored tier means deny. Deny-by-default grants, versioned and pinned policy cards, the autonomy ceiling, audience-scoped tokens, a registration gate on by default, credential and kill state re-read on every call. Five separate admin rights. | Signed harness reports are ingested, levels derived and stored per scan, shadow and below-bar agents raised as findings, and shortfalls accepted for a bounded time. No scanner ships yet, so nothing discovers agents outside Inflect; no page renders the scans. |
| Runs and communication | Four specialists reachable by delegation, depth one, fan-out capped per turn per tenant; tools and skills only narrowed. Delegation spans in the run ledger. Runtime-supplied tools reported. Run input scanned before the run exists. Automation rules invoke agents with named refusals. | No integration passport; no A2A peers. |
| Skills | Eight original, licensed skills, two of them for IAM and declared by no workflow. The loader enforces name, description, licence, byte budgets and the standard's optional metadata, and scans every skill's text at load: a refused skill is listed on the read-only Skills tab by rule id, and a run that declares it fails closed, as a run declaring an unknown skill does. The two IAM skills ship evaluation sets; the catalogue budget binds per workflow and per run. | No evaluation records and no mount gate; no skill hash pinned on runs; no workflow mounts the IAM skills. |
| Writes and approvals | Propose-not-commit with the approver count pinned and four-eyes in the database; expiry, output guard, quarantine, ASI09 sample audits. | No agent recertification campaign. |
| External systems | MCP server and client, delegated and app-only grants, one outbound wire; external writes on a four-rung ladder with prior-state reads and a journal; Entra time-bounded access packages with verified expiry. | — |
| Assurance | Control-test runner with four agentic checks (an empty population is inconclusive); audit-prep workflow; auditor role, pack-scoped auditor accounts. | No IAM audit procedures, no workpapers, no auditor independence check. |
| Identity chain | Sync, HRIS, joiner, leaver in a fixed order with a dwell; every directory write journaled; legacy-application recertification campaigns. | Offboarding a person does nothing to the agents they own; retiring an agent only flips its status. |

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

### Phases and steps

| Phase | When | Steps |
|---|---|---|
| 0 Mobilise (#3655) | Oct–Nov 2026 | `0a` ladder and contract (#3660) · `0b` skill standard (#3661) · `0c` passport spec and A2A threat model (#3662) · `0d` audit procedures (#3663) · `0e` DPIA, keys, retention, pilot (#3664) |
| 1 See and teach (#3656) | Nov 2026–Jan 2027 | `1a` scanner and ingest (#3665) · `1b` skill evaluation gate and run pins (#3666) · `1c` skill text scan (#3667) · `1d` first IAM skills (#3668) |
| 2 Own and connect (#3657) | Jan–Mar 2027 | `2a` intake, retirement cascade, ownership transfer (#3669) · `2b` orphan pass and hygiene (#3670) · `2c` service-principal disable (#3671) · `2d` integration passport (#3672) · `2e` A2A peers and card pinning (#3673) |
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
