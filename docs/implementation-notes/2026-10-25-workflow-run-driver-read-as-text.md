# 2026-10-25 — `WorkflowRun.driver` kept out of the typed client

**Commit:** `fix(agentic): keep WorkflowRun.driver out of the typed client, so a run with an unknown engine stays readable (#4241)`

## Design

`AgentDriverMode` has two columns. #4224 (PR #4242) fixed the settings column by
reading it as `::text`. This note covers the other one, `WorkflowRun.driver`.

A Prisma 7 client that meets an enum label it was not generated with does not
return the string. Its data mapper throws
`Value 'X' not found in enum 'AgentDriverMode'` and the whole operation fails.
After a rollback past a third engine, any operation whose result carries
`driver` fails for a run stamped with that engine:

```
whole-row read (no select)  → the read throws
select { driver: true }     → the read throws
update with no select       → the UPDATE runs, the RETURNING row fails to map,
                              and inside a tenant transaction the throw rolls it back
```

The fix keeps the column out of the typed client's results. The readers that
need the engine read it as text:

```
typed read / write   omit: { driver: true }        (or a select without it)
the engine           readRecordedRunDrivers(db, tenantId, ids)
                       SELECT "id", "driver"::text … WHERE "tenantId" = … AND "id" IN (…)
                       → coerceRecordedRunDriver: STATIC | FLUE | UNRECOGNISED
```

`local/no-typed-run-driver-read` makes every new record-returning `workflowRun`
call take that shape, and relation reads of a run from a parent too.

### The population, measured with an AST walk rather than a line grep

The issue listed six sites that pass no `select`. Four of them do pass one
(`agent-run-reaper`, `audit-narrative-dispatch`, `automation-executions`,
`ad-hoc-question-result`), and each select leaves `driver` out. A line-based
grep cannot see a `select` that sits a few lines below the call. The real
population of record-returning calls whose result carries `driver` was eleven:

| Site | Shape | Now |
| --- | --- | --- |
| `drivers/run-store.ts` `getRunRow` | `findFirst`, no select | `omit` |
| `drivers/run-settlement.ts` `updateRun` | `update`, no select | `omit` |
| `workflow-runs.ts` resume (×2), abort, seal | `update`, no select | `omit` |
| `workflow-runs.ts` `getWorkflowRun` | `findFirst` + `include` | `omit`, then the engine as text |
| `workflow-runs.ts` `listWorkflowRuns` | `findMany` + `include` | `omit`, then one text read for the page |
| `agent-harness-attribution.ts` capture | `select { driver: true }` | text read |
| `audit-workpaper-narrative.ts` capture | `select { driver: true }` | text read |
| `scripts/flue-enable-tenant.ts` resume step | `select { driver: true }` | text read |

There are no reads that `include` a run from a parent relation (`run`, `runs`,
`workflowRuns`) in `src/` or `scripts/`. The rule covers them anyway.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-driver.ts` | `coerceRecordedRunDriver`, `RecordedRunDriver`, `RUN_DRIVER_UNRECOGNISED`. Client-safe, beside the settings coercer. |
| `src/lib/agentic/agent-driver-stored-mode.ts` | `readRecordedRunDrivers` / `readRecordedRunDriver`, the text read, beside #4224's. |
| `src/lib/agentic/drivers/run-store.ts`, `run-settlement.ts` | `omit` on the run store's read and the settlement write. |
| `src/app-layer/usecases/workflow-runs.ts` | `omit` on four writes and two reads. The list and the page get the engine from the text read. |
| `src/app-layer/usecases/agent-harness-attribution.ts`, `audit-workpaper-narrative.ts` | Text read. New outcome `UNRECOGNISED_ENGINE`. |
| `src/app/t/[tenantSlug]/(app)/agents/runs/*Client.tsx`, `messages/*.json` | The run chip can say "Unrecognised engine". |
| `scripts/flue-enable-tenant.ts` | Text read in `resume-paused`. |
| `eslint-rules/rules/no-typed-run-driver-read.js` (+ test, README, config, wired guard) | The ratchet. |

## Decisions

- **`omit`, not a `select` listing every scalar.** The issue warned that
  enumerating the scalars of a row read whole is a large diff that goes stale
  when the model gains a column. `omit: { driver: true }` is the inverse. It
  names the one column, it stays correct as columns are added, and the result
  type drops `driver` honestly. The compiler then showed that nothing reading
  those rows used the field.
- **Not a client-wide `omit`.** Prisma accepts a global `omit` in the
  constructor, and it would cover every future site with no rule. But
  `buildClient` is typed `PrismaClient`, which erases the omit generic. Every
  whole-row type would still claim `driver: AgentDriverMode` while the runtime
  value was `undefined`. That turns a loud failure into a silent wrong value,
  which is worse. The test client would also behave differently from
  production.
- **`omit` on writes, not `select: { id: true }`.** The audit extension builds
  its `after` snapshot from the write's result. A `select` would empty that
  snapshot, and `omit` keeps it whole.
- **`UNRECOGNISED`, not `STATIC`.** The settings coercer reads an unknown value
  as `STATIC` because the setting is a permission and narrowing it is safe.
  The run column is a fact about a run that already happened. Reading it as
  `STATIC` would tell an incident review that the static engine walked a run it
  did not walk. Every decision made from the column compares against a named
  engine (`=== 'FLUE'`), so the marker refuses there. The two captures refuse
  with their own outcome, because `NOT_A_MODEL_RUN` is documented as "the
  static engine".
- **A rule, not a `no-restricted-syntax` selector.** Several config blocks
  replace `no-restricted-syntax` for their own files, and a selector would stop
  applying there without any warning. The rule is off under `tests/` because
  the integration suite's control has to make the forbidden read.
- **Left alone: the audit extension's prior-state reader.** It reads the prior
  row with a `findFirst` that it reaches by computed delegate name, so the rule
  cannot see it. On a poisoned run that read throws. The reader catches the
  error and the audit row records `changedFieldsAreDiffed: false`. That is a
  correct report of what happened, and the write commits, as the integration
  test checks. Teaching a generic reader about one model's column would buy a
  diff for the rollback window only.
- **Not a migration or an enum change.** An `ALTER TYPE` during a rolling deploy
  makes old containers fail with SQLSTATE 42704. This change is for the image
  that cannot know the new value.
