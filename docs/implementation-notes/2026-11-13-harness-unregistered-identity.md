# 2026-11-13 — An unregistered identity with no sign of a model is not a shadow agent

**Commit:** see the `claude/harness-unregistered-identity` branch.

## Design

Before this change every principal a harness scan found with no register row
was a shadow agent: one `SHADOW_AGENT` finding at HIGH, and a second HIGH
finding, `HARNESS_SHORTFALL`, for being below the agent bar. A service account,
a build workflow that holds a credential and a directory application were all
reported that way, although nothing about them suggests they run a model. The
standalone scanner stopped doing this in its local results the same day; this
change makes Inflect's ingest, findings and harness tab apply the same rule
under the same names, so the two copies can be merged later.

Owner decisions, 2026-11-13:

- A principal no register row is linked to, and that shows no sign of running a
  model, is an **unregistered automated identity**.
- The signs are five, in this order, and no others: `FOUND_IN_CODE`,
  `FOUND_IN_RUNTIME`, `FOUND_ON_MCP_SERVER` (the three source kinds in
  `discoveredVia`), `LISTS_A_TOOL`, `LISTS_A_MODEL`. The name of a credential
  is not a sign.
- It gets one finding, `UNREGISTERED_IDENTITY`, MEDIUM, OBSERVATION, keyed
  `UNREGISTERED_IDENTITY:<discoveredId>`, in place of `SHADOW_AGENT`, and no
  `HARNESS_SHORTFALL`. It keeps its row, level and criteria, is left out of
  counts of agents below their bar, and has a section of its own on the tab.
- It closes as a shadow agent's finding does: by being registered.

### The rule lives in the planner

`src/lib/agentic/harness-findings.ts` gains `MODEL_SIGNS`, `modelSignsOf`,
`unregisteredIdentityRefOf` and the finding. `PlannedAgent` carries
`modelSigns` and `unregisteredIdentity`, so the ingest does not work the class
out a second time. The wire contract and the scanner package are untouched:
the class is derived from what a report already carries.

### What an incomplete scan may conclude

Inflect has what a standalone run lacks: prior state, and the rule that a scan
closes a finding only on positive evidence. A sign is a presence and counts on
any scan. The absence of a sign counts only as far as the scan read.

| The scan | The principal shows | The plan |
|---|---|---|
| Any | A sign | Assert `SHADOW_AGENT`; resolve `UNREGISTERED_IDENTITY` |
| Complete | No sign | Assert `UNREGISTERED_IDENTITY`; resolve `SHADOW_AGENT` and `HARNESS_SHORTFALL` |
| Incomplete | No sign, on record as an agent | Treat as an agent, as before; resolve nothing |
| Incomplete | No sign, not on record as an agent | Assert `UNREGISTERED_IDENTITY`; resolve nothing |

"On record as an agent" is `PriorHarnessState.onRecordAsAgent`: the principal's
`SHADOW_AGENT` or `HARNESS_SHORTFALL` finding is open. The ingest reads those
two refs for the principals it already knows, in one bounded read, and hands the
planner the set.

```
          sign (any scan)
   ┌───────────────────────────────┐
   ▼                               │
SHADOW_AGENT ── no sign, COMPLETE ─┼──▶ UNREGISTERED_IDENTITY
   ▲    │                          │        │
   │    └─ no sign, incomplete ────┘        └─ no sign, any scan: stays
   │       (stays; nothing closes)
   └──────────── sign (any scan) ───────────┘
```

Every move asserts one finding and resolves the other in the same plan, so a
principal holds one of the two open. The sequence test in
`tests/unit/agentic/harness-findings.test.ts` replays the ingest's reconcile
over eight scans and checks the open set after each.

### Every reader asks one rule

A stored principal's class is `unregisteredIdentitiesOnRecord(findings)`: its
identity finding is open and its shadow finding is not. With both open, or
neither, it reads as a shadow agent, the more severe reading. Four readers use
it:

- **The harness matrix** reads both refs for every unlinked principal it shows
  (the two lists, the matrix rows, the acceptance clock) in one read. It splits
  what was the shadow list into `shadow` and `unregisteredIdentities`, sets
  `MatrixRow.unregisteredIdentity`, and never marks an identity below a bar.
- **The shortfall acceptance** refuses an identity as `UNREGISTERED_IDENTITY`
  through `shortfallAcceptanceRefusal`, the rule the tab's affordance shares, so
  the tab offers it neither an action nor the "register first" note.
- **The acceptance expiry sweep** does not reopen a shortfall for a principal
  that lost its register row and is now on record as an identity.
- **The evidence emitter** leaves identities out of "below the report-only bar"
  and states their number on a line of its own.

### The intake takes either finding

`registrableFindingOf` reads a `SHADOW_AGENT` or `UNREGISTERED_IDENTITY`
finding and returns the discovered id. Everything else about the intake is
unchanged: the owner is confirmed by a person, the entry is provisional, no
finding is written, and one discovered agent makes one register row. The
dialog says, for an identity, that registering it records it as an agent.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/harness-findings.ts` | The signs, the class, the finding, the two on-record readers, `registrableFindingOf` |
| `src/app-layer/usecases/agent-harness-scans.ts` | Reads which known principals are on record as agents; counts identities in the scan's audit row |
| `src/app-layer/usecases/agent-registration-intake.ts`, `src/lib/agentic/registration-intake.ts`, `src/app-layer/schemas/agent-registry.schemas.ts` | The intake registers from either finding |
| `src/lib/agentic/harness-read-model.ts` | `MatrixRow.unregisteredIdentity`, `ShadowRow.kind`, `HarnessMatrixView.unregisteredIdentities` |
| `src/app-layer/usecases/agent-harness-matrix.ts` | Splits the unlinked principals by the finding on record |
| `src/lib/agentic/harness-acceptance-rules.ts`, `src/app-layer/usecases/agent-harness-acceptance.ts` | No shortfall to accept, and none reopened at expiry |
| `src/lib/agentic/evidence-artefact.ts`, `src/app-layer/usecases/agentic-evidence-emission.ts` | The identity tally, and its exclusion from the below-bar count |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/ShadowList.tsx`, `HarnessTab.tsx`, `MatrixGrid.tsx`, `RegisterShadowAgentModal.tsx` | The second section, the badge, the dialog's notice |
| `messages/en.json`, `messages/bg.json` | The section's words in both locales |
| `docs/agent-harness-contract.md`, `docs/agent-harness-scanner-onboarding.md`, `docs/user/guide/manage/agent-reports.md`, `CLAUDE.md` | What a reader is told |

## Decisions

- **The record is the open finding, not the stored scan rows.**
  `DiscoveredAgent.discoveredVia` and the latest scan item are overwritten by
  every scan, an incomplete one included. Read as "what the principal last
  showed", they would let a second incomplete scan take the first one's missing
  sign for the record and flip the class. The finding moves only on evidence,
  and it needs no schema change: no migration was written.
- **A sign on an incomplete scan resolves the identity finding.** That finding
  says nothing the scan read shows a model. A sign the scan saw is positive
  evidence against it, whatever else the scan could not read.
- **A principal first seen on an incomplete scan with no sign is an identity.**
  Nothing is closed by opening a MEDIUM finding, and holding it as a shadow
  agent until a complete scan would raise two HIGH findings on every sign-less
  principal whenever one source failed to read, which is the noise the decision
  removes. If a sign was in the unread part, the next scan that reads it moves
  the principal.
- **`onRecordAsAgent` includes an open `HARNESS_SHORTFALL`.** A registered
  agent below its bar that loses its register row has a shortfall open and no
  shadow finding. Without the shortfall in the set, an incomplete scan would
  open an identity finding beside a shortfall it may not close.
- **With both findings open, or neither, a reader takes the shadow agent's
  class.** Both can be open only off the plan's own path: a person reopened one
  by hand, or an identity was registered through the intake and its register
  row stopped linking before a complete scan had closed its finding. The next
  complete scan settles it.
- **`LEVEL_DROP`, `UNPINNED_WRITE_TOOL` and the orphan-credential rules are
  unchanged.** A level that fell is still an event for an identity: it keeps
  its level, and the event says the level moved, not that a bar was missed.
- **The refusal code `NOT_A_SHADOW_AGENT_FINDING` keeps its name.** It is the
  API's, and it now covers a finding that is neither of the two the intake
  takes.
- **The evidence emitter reads the class tenant-wide, by `sourceRef` prefix.**
  Its tallied population can reach 20,000 agents, more than a bound parameter
  list holds. Past its own cap the tallies are withheld, as they are when the
  agents themselves were not all read.
- **The matrix chooses its rows by the ladder alone and orders them again
  after reading the class.** The class is read only for the rows shown, so a
  section over its row cap may show an identity where a lower-ranked agent
  below its bar would have been. Reading the class for a whole scan to choose
  200 rows was not worth a second unbounded read.
- **Left alone, with the reason:** `get_discovered_agent` and the
  discovered-agent picker return observations and a register link, never a
  class; the stale-estate alert judges scans, not principals; the calendar
  source lists acceptances, which need a register row; `get_harness_register`
  reads the register. The scanner package's Okta source still says in a comment
  that an API token raises `SHADOW_AGENT`: the package was out of scope for
  this change.
