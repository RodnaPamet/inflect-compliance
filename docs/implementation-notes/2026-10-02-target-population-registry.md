# 2026-10-02 — the TARGET population: bounding which row an agent may write to (#3051 step 5c)

**Commit:** see `feat/target-population-registry`

## Design

Step 5b opened VALUE fields: the agent chooses an argument within a typed
constraint a reviewer read. This opens the **target** — the argument that says
*which row* the write is about.

Owner decision 1 on #3051 rejected bounding the target with a pattern:
approving `^[0-9]+$` on an employee number approves every employee, and a
reviewer reading that pattern is unlikely to see it. The owner's follow-on ruling
(2026-10-02) settled what "bounded by data" means: a **code-defined registry** of
named populations, not an operator-authored saved query, because a stored
predicate has exactly the property that made the pattern unreviewable. A registry
entry can only be widened by a code change somebody reviews; the accepted cost is
that a new population needs a deploy, not a console action.

```
ExternalToolParameterSet
  openFields        {"employeeEmail": {"kind":"target"}, "note": {...}}   ← WHICH ARGUMENT
  targetPopulation  "terminated_employee_work_emails"                      ← WHICH POPULATION
         │
         │  resolved AT DISPATCH, per call, never at approval
         ▼
TARGET_POPULATIONS[key].resolve(ctx, MAX_POPULATION_ROWS + 1)
         │  runInTenantContext → RLS → tenant-scoped read, row-capped
         ▼
  ok | unknown_key | empty | too_large | unresolvable
         │                └── every one of these REFUSES; nothing is sent
         ▼
  value ∈ values ? dispatch : external_target_not_in_population
```

Three entries ship, all of them populations that **already existed** —
`identity-leaver-pass.ts`'s `where: { tenantId, status: 'TERMINATED' }` roster,
projected onto the three identifiers this product already treats as addressable:

| key | value | bounds beyond the tenant |
| --- | --- | --- |
| `terminated_employee_work_emails` | `Employee.workEmail` | `status = TERMINATED`; row cap |
| `terminated_employee_hris_record_ids` | `Employee.hrisRecordId` | `status = TERMINATED`; `hrisRecordId IS NOT NULL`, because the schema says a null handle must refuse and never fall back; row cap |
| `terminated_employee_entra_account_ids` | `ConnectedIdentityAccount.externalUserId` | terminated employee; link re-observed inside `POPULATION_OBSERVATION_FRESHNESS_MS`; `contradictedAt IS NULL`; account not `isProtected`; `provider = 'entra-id'` alone; row cap |

## Files

| file | role |
| --- | --- |
| `src/app-layer/usecases/external-tool-target-populations.ts` | the registry: three entries, each with a stable key, a description, a written `bound`, and a tenant-scoped capped resolver; plus `resolveTargetPopulation`'s five-state result |
| `src/lib/integrations/open-fields.ts` | a fifth `openFields` kind, `{"kind":"target"}`; `parseOpenFields` now takes the row's population and hydrates the marker with it, failing CLOSED if the two halves disagree |
| `src/app-layer/usecases/external-tool-parameters.ts` | the digest covers the population (`…template-target:v2`); propose-time registry-key and coherence refusals; promotion copies the pending population |
| `src/app-layer/usecases/external-mcp-tools.ts` | `targetPopulation` selected and threaded to the tool boundary beside the raw `openFields` |
| `src/lib/mcp/tools/external-tools.ts` | `refuseUnlessInPopulation` — the dispatch gate, five distinct refusals, nothing sent on any |
| `prisma/schema/agentic.prisma` | `targetPopulation` / `pendingTargetPopulation` |
| `prisma/migrations/20261002160000_external_tool_target_population/` | the columns, three coherence CHECKs, and `CREATE OR REPLACE` of both trigger functions |

## Decisions

- **Which argument is the target lives in `openFields`; which population bounds
  it lives in a column.** Each fact is stored exactly once. The marker is in the
  JSON because the target *is* an open field — the agent chooses its value — so
  it inherits the advertised-schema union, the strict `argsSchema`, the
  supplied-name refusal, the missing-field refusal, the shadow-an-approved-value
  refusal and the `MAX_OPEN_FIELDS` review budget for free. A `targetField`
  column would need a second branch in each of those five derivations, and a name
  that must be added in five places is a name that will be forgotten in one. The
  population is a column because "which templates name population X" is the
  question a deploy that removes or narrows an entry has to answer, and a scan
  over JSONB is not an answer.

- **A CHECK ties the two halves in both directions.** `jsonb_path_exists` /
  `jsonb_path_query_array` are `IMMUTABLE` (verified against `pg_proc.provolatile`
  rather than assumed), so the equality and the at-most-one-target rule are plain
  CHECK constraints. A marker with no population is the dangerous direction — the
  agent would choose a row bounded by nothing. A population with no marker is
  harmless at dispatch and refused anyway: the row asserts something about a
  target that its field list does not, so a reviewer approved one of two readings
  and nobody knows which.

- **The promotion trigger gates the COLUMN, and that clause has real teeth.**
  With a marker already present, retargeting a live template to a wider
  population satisfies every CHECK while the field list, the field names and the
  approved exact values all read unchanged. It is the widest change this table can
  express, and the trigger is the only thing that refuses it. The trigger also
  requires a promotion's `targetPopulation` to equal `pendingTargetPopulation`
  exactly, so the reviewed field list cannot come into force beside an unreviewed
  population.

- **The digest covers the population, in a third form that leaves the older two
  byte-stable.** `proposeParameterChange` compares a candidate digest against the
  stored `parametersHash` to refuse a no-op edit, so changing how an existing row
  would hash makes every such row look edited. Hence: no open fields and no
  target → exactly `hashParameters`; open fields only → exactly 5b's
  `…template:v1`; a target → a new `…template-target:v2`. Without the population
  inside the digest, a retarget would hash identically to what is in force and be
  refused as "nothing to approve" — and a swap between the review and the click
  would still match the hash the approver named.

- **The population is resolved at dispatch, and the whole set is materialised
  rather than probed.** `findFirst({ where: { ...population, email: supplied } })`
  would answer membership in one indexed read, and is rejected because it cannot
  separate the three outcomes the dispatch must separate: a value outside the
  population, an **empty** population, and a population too large to be a bound.
  An empty population means the data moved and the template is inert, which an
  operator must be told rather than left to infer from a value-shaped refusal.

- **A full cap refuses rather than truncates.** At exactly
  `MAX_POPULATION_ROWS`, "not in the population" and "past the cap" are
  indistinguishable, so `take: MAX + 1` makes reaching the cap detectable and the
  dispatch refuses. A probe that could not look must not report "nothing".

- **The advertised schema never enumerates the population.** An `enum` of the
  current members would be a snapshot taken when the invocation was assembled,
  presented to the model as the live bound — a row leaving the population
  mid-run would still look addressable — and it would put tenant identifiers into
  a tool listing nothing asked to read them. The model is told the shape and the
  population's NAME, and learns membership by being refused. The refusal reports
  the population's SIZE and never its contents.

- **A baseline may carry no target**, refused by the usecase and by the trigger
  with its own message. A first save has no reviewed moment, and allowing it would
  make four-eyes avoidable by delete-and-re-save.

- **An omitted `targetPopulation` key carries the row's population forward.**
  Reading absence as "no target" would unbind a template's row-level bound
  whenever somebody edited only its exact values — and the promotion trigger
  would accept it, because dropping a bound is a narrowing and needs only the
  ordinary signature. A narrowing nobody intended is still a change nobody
  reviewed.

- **An unknown population key is refused at BOTH propose time and dispatch, and
  the two are not redundant.** Propose-time puts a typo in front of the admin who
  wrote it; dispatch-time is what makes removing a registry entry safe — every
  template naming it becomes undispatchable rather than unbounded — and it is a
  statement about the registry *now* rather than when the edit was proposed.
