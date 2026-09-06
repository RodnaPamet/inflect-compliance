# 2026-09-06 — the agent-governance reports

**Commit:** branch `feat/agentic-10c` — `feat(agentic): the reports an assessor
asks for, with every number's definition attached` (the sha is deliberately not
quoted: this note is committed WITH the change, so any sha written here names a
commit that no longer exists the moment the commit is amended or squashed)

## Design

Nine prompts of this roadmap built RECORDS — a register, a risk assessment, a
policy card, a tool-manifest pin, an approval queue with a four-eyes rule, a
kill switch and a drill that proves it. Every one of them is queryable a row at
a time, by somebody who already knows it exists. None of them is what an
assessor asks for, which is one artefact that answers, for the whole tenant:
which agents run here and who answers for each; which of ASI01–ASI10 each is
covered for; whether the human approvals mean anything; what has gone wrong and
whether the stop control is proven; and which agents somebody else wrote.

This is those five reports. **No new table, no new job, no new page, no new
permission key.** Every figure is derived from rows the earlier prompts already
landed — a governance report with its own storage would be a second copy of the
register, and two copies can disagree about what a tenant runs.

```
  loadAgents(ctx) ──────────────┬──▶ 1 agent inventory
    one transaction, no read      │
    inside a loop; the legacy     ├──▶ 5 third-party assessments  ─┬─ Vendor
    placeholder filtered out      │                                └─ McpToolManifestPin
    here so every report shares   │
    one denominator               └──▶ 2 ASI coverage matrix ── computeTenantAgentRiskCoverage

  computeAgentReviewQuality ────────▶ 3 approval statistics ──── getSampleAuditDisagreementRate
    (alert: false)

  AgentKillSwitch / Drill / Breaker ▶ 4 incident + kill-switch history
```

### Every number carries its definition, in the same payload

A report that renders is not a report that is true. "12 agents" is not a fact
until somebody has said which twelve — over what population, at what moment,
counting retired ones or not. So `src/lib/agentic/report-definitions.ts` holds a
`METRIC_DEFINITIONS` registry keyed by the stable metric id an assessor might
cite, and every report's envelope resolves `definitions` **from the keys of its
own `metrics` block on every build**. The two cannot drift, and the integration
test asserts the coverage is total in BOTH directions: a metric with no
definition is a number nobody can defend, and a definition with no metric is a
claim the report does not actually make.

Each definition carries three things, and each answers a question that has
actually been asked of a compliance report:

| field | answers |
| --- | --- |
| `population` | which ROWS — named by table wherever a table is the honest answer |
| `moment` | `AS_OF_GENERATION` (a snapshot) or `OVER_WINDOW` (a period) |
| `includes` / `excludes` | the edges — every exclusion is a decision somebody could reasonably have made the other way |

The exclusions are the load-bearing half. `inventory.registered_agents` excludes
soft-deleted rows and the legacy placeholder; `incidents.kill_engagements`
excludes the drill canary's kills and the global platform kill;
`thirdparty.tools_human_approved` excludes `BASELINE` pins because
trust-on-first-use is not a human decision. A reader who disagrees with an
exclusion can at least SEE it.

### Empty, unknown and zero are three different answers

Every figure is a `Measure`, not a number:

```
MEASURED       counted; 0 here means genuinely none
NO_POPULATION  nothing to count over — the denominator is empty
NOT_ASSESSED   the rows exist; the judgement this summarises does not
NOT_OBSERVABLE the fact is outside this platform's boundary
```

plus a stable `basis` code (`NO_DRILLS_RUN`, `ASI_FRAMEWORK_NOT_INSTALLED`,
`OUTSIDE_PLATFORM_BOUNDARY`, …) saying which absence it is — a code and not
prose, for the reason `AgentProposalSampleAudit.dissentCodes` gives.

The sharpest case is `incidents.tool_calls_after_kill`. Summing an empty drill
list gives `0`, which reads as the strongest claim the product can make —
"nothing got through the kill switch" — from a tenant that has never run a
drill. The suite asserts both arms side by side: a tenant that ran one clean
drill reports `MEASURED 0`, a tenant that has never drilled reports
`NO_POPULATION / NO_DRILLS_RUN`. The same distinction is asserted for
`approvals.approval_rate` (0/0 is not "everything was rejected"),
`approvals.sample_audit_disagreement_rate` (a perfect record and a queue nobody
reviewed both produce zero dissents), and the whole inventory block for a tenant
with no agents.

Two per-row facts get the same treatment rather than being flattened into a
column: `assessmentState` is `NEVER_ASSESSED | ASSESSED | ASSESSED_STALE` beside
the tier rather than inside it, and `breakerState` is `null` when no breaker row
exists — never observed, which is not "closed".

### An API route and no page — and why

The pack is exposed as ONE read-only route, `GET /api/t/:slug/admin/agents/reports`
(`?section=` narrows, `?days=` sets the lookback), and adds no UI surface. It is
an artefact somebody hands over — the shape it needs is a document with its
definitions attached, not a dashboard — and every subsystem it draws on already
has an operator page (the register, review quality, the kill-switch list). A
sixth rendering of the same rows would be one more place to keep in step, with
its own filters, for a reader who is going to export it anyway. It also avoids
the new-page ratchets (`<Heading>`, canonical parents, page segregation,
`MIGRATED_PAGES`) for a surface nobody asked to browse.

The route writes NOTHING — deliberately unlike `…/agents/review-quality`, which
deduplicates an alert row when a bias pattern is outstanding. The pack passes
`alert: false`: an artefact somebody generates to hand to an assessor must be
re-runnable without changing the thing it describes, or the second run reports
on the first one.

### The coverage refactor

`computeAgentRiskCoverage` answered the ASI question for ONE agent. The matrix
needed it for all of them, and the tempting shape — call it in a loop — would
have been an N+1 and, worse, a second place where the framework-family expansion
(two representations of the framework, two spellings of a requirement code)
could disagree with the first about what a tenant covers. So both entry points
now share `buildCoverageReports`, and the only per-agent input —
`AiSystemRequirementLink` — is loaded for every agent in one query
(`loadAgentScopes`).

`computeTenantAgentRiskCoverage` returns `{ frameworkInstalled, framework,
risks, agents }` rather than just the per-agent array, and that split is a
defect the test found rather than a design somebody planned. Reading
"is the framework installed" off `agents.some(a => a.frameworkInstalled)` says
NO for a tenant with no agents — a different finding, aimed at a different
person, than "nobody has registered an agent yet". Framework presence is a
property of the catalogue; the agent list cannot answer for it.

## Files

| file | role |
| --- | --- |
| `src/lib/agentic/report-measures.ts` | the four-state `Measure` + its closed `basis` vocabulary; `ratio()` guards the empty denominator |
| `src/lib/agentic/report-definitions.ts` | `METRIC_DEFINITIONS` — 38 authored metric ids, each with population / moment / includes / excludes; `definitionsFor()` resolves best-effort so a gap is visible rather than fatal |
| `src/app-layer/usecases/agent-governance-reports.ts` | the five report builders, the pack, and the shared `loadAgents` |
| `src/app-layer/usecases/agent-coverage.ts` | (modified) `buildCoverageReports` shared by both entry points; batched `loadAgentScopes`; new `computeTenantAgentRiskCoverage` |
| `src/app/api/t/[tenantSlug]/admin/agents/reports/route.ts` | GET, `requirePermission('admin.agent_registry')`, `?section=` / `?days=` |
| `tests/guardrails/admin-route-coverage.test.ts` | (modified) the new route registered — the list is a completeness check |
| `tests/guardrails/schema-index-coverage.test.ts` | (modified) `AgentCircuitBreaker` triaged into `LIST_MODELS_TENANT_INDEX_SUFFICIENT`; the pack is its first `findMany` site |
| `public/openapi.json` | (regenerated) the route walker picked up the new path |

## Decisions

- **No new model, and therefore no migration.** Every figure already existed as
  a row somebody wrote for another reason. The finding this prompt closes was
  never "the data is missing" — it was that nothing read it this way, which is
  the same shape as the automation-bias module one prompt earlier.

- **`definitions` is resolved from `metrics`, not authored alongside it.** An
  appendix maintained by hand rots the moment somebody adds a figure. Resolving
  it from the emitted keys makes a missing definition detectable, and the
  resolver DROPS an unknown key rather than throwing so the failure is a visible
  coverage gap in the payload instead of a 500 on the whole pack.

- **The pack is sequential, not `Promise.all`.** Each report opens its own tenant
  transaction; five concurrent ones per assessor click is a pool exhaustion
  nobody asked for on a read that runs once a quarter.

- **The drill canary is counted apart from real kills, in both directions.**
  `listKillSwitches` does not make this distinction and does not need to — it is
  an operator surface where seeing the drill's own rows is useful. A governance
  report is different: "two kill switches are currently in force" is a sentence
  an assessor acts on, and an exercise against an id no credential resolves to
  is not an outage. Both the window count and the as-of-now snapshot exclude it,
  and `incidents.drill_canary_engagements` reports it separately rather than
  silently dropping it.

- **`thirdparty.supplier_side_agent_changes` is `NOT_OBSERVABLE`, and is emitted
  anyway.** A third-party agent's model, prompt and tool implementation live on
  the supplier's side of the boundary. The register records what the operator
  DECLARES and the tool boundary records what the agent DID here; neither is a
  view of the supplier's build. Every available proxy would be a claim about the
  supplier made out of our own logs. Naming the gap in the payload follows the
  precedent `UNOBSERVABLE_REVIEW_QUESTIONS` set for `DIFF_EXPANSION` — a metric
  surface silent about its blind spot reads as one that has none.

- **The window-scoped and snapshot figures are mixed in one report on purpose,
  and labelled.** `incidents.kill_engagements` is over the window;
  `incidents.kills_in_force_now` is as of generation, because a kill engaged
  before the window and still in force is a fact about now. Same for
  `approvals.pending_now`: queue depth NOW is what drives rubber-stamping now.
  Mixing them silently would be the category error; the `moment` field on each
  definition is what makes mixing them safe.

- **`vendorUnresolved` exists because the CHECK constraint guarantees a NAMED
  vendor, not a resolvable one.** A soft-deleted supplier leaves a third-party
  agent pointing at nothing, and the honest render is a flagged row rather than
  a blank vendor column that looks like first-party.

- **The app-layer `tenantId` filter is defence in depth here, and a mutation
  proved it.** Removing `tenantId` from the register read changed nothing — RLS
  is the load-bearing layer. What the two-tenant suite DOES catch is the
  realistic defect: reading on the base client, outside `runInTenantContext`.
  That mutation failed seven tests across three tenants and two reports.
