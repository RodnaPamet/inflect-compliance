# 2026-10-17 — The harness matrix tab, acceptance UI and scan evidence

**Issue:** #3687, step 1a of the agentic IAM roadmap (#3665). The ingest core is #3688.
**Commit:** the commit that adds this note.

## Design

The 1a core ingests signed harness reports and stores, per scan, the level and reach
it derives for each discovered agent. Nothing showed those rows to anyone, and nothing
made them evidence. This step adds three readers and one writer of evidence. It adds no
writer of the harness tables.

```
/agents/reports?tab=harness   (same admin.agent_registry gate as the pack)
  page.tsx ── gate ── getHarnessMatrix(ctx) + getHarnessScannerKeysView(ctx)   read-only
            └─ ReportsClient → ToggleGroup (link mode) → HarnessTab
                 ├─ ScannerSection per scanner: completeness, drift, MatrixGrid of agents × criteria
                 ├─ AcceptancesCard (anchors the calendar links to)   POST harness-acceptances (owner only)
                 ├─ ShadowList, ScanHistory
                 └─ ScannerKeysCard                                    POST / DELETE harness-scanner-keys
compliance calendar  ── agent-harness-acceptance source (expiresAt) → ?tab=harness#harness-acceptance-<id>
agentic-evidence-emission job ── AGENT_HARNESS_SCANS artefact per ASI10 / ASI03 control per UTC month
                                 └─ scheduled tick only: reconcileClosedHarnessPeriods (previous month,
                                    months a late scan reached, unsafe approvals put back)
```

**The tab.** A `ToggleGroup` in link mode (`?tab=harness`); a missing or unknown value
is the pack. The server reads only the selected tab, so the harness tab never builds the
pack and the pack tab never reads a scan. Every read sits after the existing gate.

**The read model.** `usecases/agent-harness-matrix.ts` reads the scan window through
`listHarnessScans`, then reads names, the trusted key holders, items, acceptances, the
shadow list and the key register in one tenant transaction, each with a `take:` and one
row past it to detect truncation. Items are read twice: the shown sections' LATEST scans
first (whole, since one scan holds at most `MAX_AGENTS`), then their previous scans for
drift. A section's rows are the worst of its latest scan only when every stored agent of
that scan was read; otherwise it shows none and says so (`rowsUnread`). An empty shadow
list reads as "none" only when every trusted scanner — every unrevoked key holder — has a
complete latest scan shown, and then as of the oldest of them. The view types and the pure rules live in `src/lib/agentic/harness-read-model.ts`,
which is client-safe, so the tab's components run the same functions the server ran:

- `harnessScanCompleteness` is the one expression for "complete": every source read in
  full, stored sources readable, and at least one agent. A scan with no agents is EMPTY.
- "Latest" means `asOf` (then `createdAt`, then `id`). A report backfilled for an earlier
  moment does not pose as the current one. Drift compares each scanner only with its own
  previous scan, from stored rows: level drops, newly seen agents, sources gone incomplete
  and sources no longer reported.
- A cell is `criterionState` over the ladder's `collapseVerdicts`. A met verdict with no
  evidence renders as not met, and a criterion reported twice is judged on its worse
  answer. The tab does not have its own copy of that rule.
- An evidence pointer is a link only when it is an absolute `http:`/`https:` URL. Anything
  else renders as text to copy.

**Acceptance.** `src/lib/agentic/harness-acceptance-rules.ts` holds the order in which
`acceptHarnessShortfall` refuses: shadow, then owner, then shortfall. The server computes
each row's affordance from that rule (`ACCEPT`, `RENEW`, `OWNER_ONLY`, `REGISTER_FIRST`,
`NONE`). The button appears only for the first two, and no user id reaches the client. The
modal posts an end-of-UTC-day ISO instant. A refusal is shown inline and the modal stays
open.

**Calendar.** `loadAgentHarnessAcceptanceEvents` projects `AgentHarnessAcceptance.expiresAt`
for acceptances that are neither revoked nor processed and that belong to a live register
row. This is the acceptances card's population, so every link lands on a rendered anchor.
The source is keyed `admin.agent_registry`, the tab's own gate. Titles carry the
registered agent's name and nothing else, because titles are pushed to external calendars.

**Evidence.** `AGENT_HARNESS_SCANS` is the third artefact kind. It is emitted through the
existing `(tenant, control, kind, UTC month)` identity onto controls that discharge ASI10
(Rogue Agents, the inventory obligation) or ASI03 (Identity and Privilege Abuse, the
access obligation). `loadHarnessFacts` reads the month's scans (cap 200), finds each
scanner's latest scan, and tallies the latest scans of up to 20 scanners. The tally is
one read across all of them, capped at 20,000 items. `HarnessScanFact` is the complete
set of fields the body may render: scan identifiers, completeness, sources, and level,
reach, below-bar and not-in-register counts. Owner references, user ids, justifications,
pointers, credentials, tool servers and agent names are absent by shape (DPIA condition 8).
`harnessIncompleteReasons` lists every way the month falls short — including every
scanner that held a trusted key at some moment of the month (registered before it ended,
not revoked before it began) and reported no scan in it. The completeness is derived from
that list, so an INCOMPLETE artefact always states why. The planned Evidence status is
`APPROVED` only for COMPLETE, otherwise `NEEDS_REVIEW`. It is written on create and then
corrected in one direction (`harnessStatusCorrection`): an incomplete month found APPROVED
is put back, a NEEDS_REVIEW is raised only when it was the emitter's own verdict
(`AgenticEvidenceArtefact.plannedEvidenceStatus` records it), and a review decision
otherwise stands. Every status the emitter changes writes a `STATUS_CHANGE` audit row.

**Closed months.** The job's scheduled tick (no `asOf`) also runs
`reconcileClosedHarnessPeriods`: it re-emits the previous month every day, re-emits any
older month that a scan was ingested into after that month's artefact was last emitted,
and then puts back every harness artefact whose plan is NEEDS_REVIEW and whose Evidence
reads APPROVED, whatever its month.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/harness-ladder.ts` | Exports `isVerdictEvidenced`, `criterionState` and `collapseVerdicts`. `scoreHarness` is rebuilt on them with unchanged behaviour |
| `src/lib/agentic/harness-contract.ts` | Exports the source and verdict schemas. `parseStoredHarnessSources` / `parseStoredHarnessVerdicts` re-validate stored JSON (null = unreadable) |
| `src/lib/agentic/harness-findings.ts` | `harnessBarFor`: the bar spelled in the DB's reach vocabulary |
| `src/lib/agentic/harness-read-model.ts` | Client-safe view types, completeness, drift, pointer-to-href and row order |
| `src/lib/agentic/harness-acceptance-rules.ts` | The refusal order and the affordance, shared by the usecase and the tab |
| `src/app-layer/usecases/agent-harness-matrix.ts` | `getHarnessMatrix`, `getHarnessScannerKeysView`: read-only |
| `src/app-layer/usecases/agent-harness-acceptance.ts` | Refuses through the shared rule. Its bounds come from the rules module |
| `src/app-layer/usecases/agent-harness-scans.ts` | `listHarnessScans` gets the `asOf` / `createdAt` / `id` tiebreak |
| `src/app/t/[tenantSlug]/(app)/agents/reports/page.tsx`, `ReportsClient.tsx` | `?tab=` dispatch after the gate; the tab control; the pack body unchanged |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/*` | The tab: sections, drift, matrix, cells, pointers, acceptances, shadow list, scan history, the key register and its two modals |
| `src/app-layer/schemas/calendar.schemas.ts`, `usecases/compliance-calendar/{index,loaders-reminder-backed}.ts` | The acceptance-expiry source |
| `src/lib/agentic/evidence-artefact.ts` | The harness kind, its two targets, facts, completeness, status, body and redaction contract |
| `src/app-layer/usecases/agentic-evidence-emission.ts` | `loadHarnessFacts` (with the silent key holders), the opt-in gate, the harness plans, the one-directional status correction in `writeArtefact`, and `reconcileClosedHarnessPeriods` |
| `src/app-layer/jobs/agentic-evidence-emission.ts` | The scheduled tick also reconciles closed harness months and counts what it demoted |
| `src/app-layer/jobs/schedules.ts` | Prose only |
| `prisma/migrations/20261017235500_agentic_evidence_harness_scan_kind/` | Widens the `kind` CHECK to admit the third value, and adds `plannedEvidenceStatus` |
| `prisma/schema/agentic.prisma` | Comment on `AgenticEvidenceArtefact.kind`; the `plannedEvidenceStatus` column |
| `messages/en.json`, `messages/bg.json` | `agents.reports.tab*`, `agents.harness.*`, and the calendar type and source labels |
| `controls/[controlId]/_tabs/ControlMappingsTab.tsx`, `tests/runs/[runId]/page.tsx` | One disclosure toggle each demoted to secondary, paying for the tab's two modal primaries |
| `tests/guards/{primary-action-budget,primary-secondary-ratio,filter-toolbar-coverage,columns-dropdown-coverage,list-page-shell-coverage}.test.ts` | The two lowered per-file budgets, the payment recorded at the unchanged ceiling, and the four sub-tables' written exemptions |

## Decisions

- **Link-mode `ToggleGroup`, not `TabSelect`.** `TabSelect` is banned in `src/app`, and
  `DashboardLayout` has no tab slot. Link mode keeps the tab in the URL, which the calendar
  deep-links into, and lets the server read only one tab. The reports page was not added
  to the tab-primitive registry, because that registry tracks migration to `TabSelect`.
- **`asOf`, not arrival order, decides "latest".** This applies to the matrix and the
  evidence alike. The accept affordance still follows `DiscoveredAgent.lastLevel/lastReach`,
  because that is what the usecase reads. A row whose latest-ingested reading differs from
  the row it sits on says so.
- **Drift never compares two scanners.** Several scanners per tenant are expected, and
  comparing across them reports false drops and false newcomers. A baseline that is
  incomplete is still used, and its completeness is shown beside the drift.
- **An empty population is a finding.** No scan at all, an EMPTY scan, and an empty
  shadow list without every trusted scanner's complete scan behind it each render as a
  finding, never as `EmptyState`. This is the opposite of the register's empty state,
  where the register is the whole population by definition.
- **A silent scanner is a gap, on the tab and in the evidence.** One scanner's complete
  scan says nothing about the sources another reads, so the shadow basis and the
  evidence's completeness both need every trusted scanner. The evidence counts a key
  that was live at any moment of the month (by scanner, not by key, so a key rotated
  mid-month is not a silent scanner); the tab counts unrevoked keys with no scan in its
  window and names those scanners. Comparing reporting scanners only — the first cut —
  approved a month in which a second scanner sent nothing.
- **Rows come from a whole scan or not at all.** One combined read of the latest and
  previous scans' items, cut at its bound in id order, could leave a latest scan with a
  prefix of its agents (or none) under a "worst first" label. The latest scans are now
  read on their own and checked against `agentCount`; only drift can be withheld for the
  previous scans' size. `getHarnessMatrix` takes `limits`, which can only lower its
  bounds, so the bounded paths are tested without thousands of rows.
- **The affordance is hidden, not disabled,** for anyone but the owner, and the server
  computes it. A note says why the action is absent.
- **The scanner keys sit on the tab,** not on `/admin/api-keys`. The routes carry the
  tab's gate. The `admin:harness_ingest` API-key scope already exists on the API-key page
  and is named here in text, not linked, because that page has a different gate.
- **Monthly identity for the evidence, not per scan.** A per-scan identity collides when
  two scanners share an `asOf`, and it breaks the withdrawal notice's period. One artefact
  per control per month lists every scan in the month and tallies each scanner's latest.
  A month is not closed by its last tick: a daily scanner's scan after the final 06:30
  tick is the month's true latest. So the scheduled tick re-emits the previous month,
  and any older month a scan was ingested into since its artefact was last emitted. Only
  months that already carry a harness artefact are reached that way — a month that never
  had evidence claims nothing a late scan could make false. Receipts and decision records
  keep their behaviour (a backfill run, `payload.asOf`).
- **`NEEDS_REVIEW`, not a new status.** It is the product's existing out-of-band demotion
  from `APPROVED`. Coverage excludes it (`coverageQualifyingEvidenceWhere`). A person may
  re-submit an incomplete month through the review flow, but an approval of it does not
  stand; the way to an APPROVED month is a complete scan. A level never enters the
  status: the ladder is report-only, so an estate read in full that is all H0 is complete
  evidence of exactly that.
- **Status ownership is scoped to the harness kind. This deviates from the plan.** The
  plan had the emitter assert `APPROVED` on receipts and decision records too, which it
  called "unchanged in practice". It would not have been unchanged. The stale-review
  sweep demotes any `APPROVED` row that carries a past `nextReviewDate`, and an emitter
  re-approving every day would fight that sweep. So `ArtefactPlan.evidenceStatus` is
  `null` for the two older kinds, which are created `APPROVED` and then left to the review
  flow as before.
- **For the harness kind the correction is one-directional.** The first cut rewrote ANY
  status that differed from the plan. That reset a re-submitted month to NEEDS_REVIEW
  every morning, turned a reviewer's REJECTED into APPROVED once the scans completed
  (skipping the reviewer and the segregation-of-duties check), and fought the stale-review
  sweep, which runs at the same minute. Now only the unsafe direction overrides a person:
  APPROVED on an incomplete month. A promotion only undoes the emitter's own demotion,
  which needs the previous plan, hence `plannedEvidenceStatus` — nullable, no default, on
  the existing `EvidenceStatus` type, so the ADD is catalogue-only.
- **A tally is withheld rather than stated partially.** This happens when the item read
  hits its bound, when a scanner is beyond the 20-scanner cap, or when the stored items
  disagree with the scan's `agentCount`. A withheld tally on a latest scan makes the month
  INCOMPLETE.
- **ASI10 and ASI03 only.** The emitter matches requirement codes exactly. ISO 27001 would
  need both `A.5.9` and `5.9` spellings, and adding it would widen the daily sweep to
  nearly every tenant. ASI02/04/06/09 and Art.12 are other kinds' obligations.
- **Opt-in by scanner key.** A tenant gets harness artefacts only once it has registered a
  scanner key at least once. Revoked keys count, and key rows are never deleted. Before
  that, every ASI-pack tenant would collect two "no scan received" artefacts a month for a
  scanner it cannot run. After it, a month with no scan is the finding.
- **The CHECK is swapped, not the type.** The migration drops and re-adds the same-named
  constraint in one script (and adds the nullable planned-status column), so there is no instant without a CHECK, and the rows it
  re-validates all hold older values. An older container skips a kind it does not know in
  the withdrawal sweep. Rollback is to redeploy the prior image and leave the migration in
  place. The integration suite pins that every kind in `AGENTIC_ARTEFACT_KINDS` is one the
  migrated CHECK accepts, which nothing pinned before.
- **The digest covers the rendered facts and the bounds.** Tallies such as "not in the
  register as of this emission" move without any scan moving, so they must rewrite the
  body.
- **The two new primaries are paid for, not added.** `modal-action-order` makes the last
  action of each dialog primary (the accept confirm and the key-register submit), and the
  product-wide ceiling of 175 has no slot to give. They are bought by demoting two
  disclosure toggles that shared a region with their own form's primary submit — the
  control mappings tab's "map requirement" toggle and the test run's evidence show/hide
  toggle, which reads "Cancel" while open. The card trigger that opens the key dialog is
  secondary, so the measured total is unchanged.
- **The tab's four tables carry no `FilterToolbar` and no column gear.** They are
  sub-tables on a multi-section report whose contract is that it has no filters, and
  hiding a matrix row or a criterion column would hide evidence. Each is exempted in the
  two coverage guards with that reason.
- **Not added:** a revoke verb for acceptances (the usecase records and renews only); the
  harness tab in the exported assessor pack (the emission job delivers harness evidence);
  any new API route (the tab reads server-side, and `harness-scans` stays machine surface).
- **Left for the orchestrator:** the DPIA (`docs/agentic-harness-scanner-dpia.md`, on
  `claude/agentic-iam-0e`) should record condition 8 as met by this step, citing the
  canary case in `tests/integration/agent-harness-evidence-emission.test.ts`, once both
  branches have merged.
- **Seen and left alone:** every artefact kind's title renders `null` for a control with
  no code (pre-existing), and some requirement keys in `legacy-evidence-controls.ts` match
  nothing.
