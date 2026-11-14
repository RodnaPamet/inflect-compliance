# 2026-11-14 — The joiner asks for a fallback group only when a starter needs one

**Commit:** `fix(identity): the joiner refuses NO_DEFAULT_GROUP only when a planned starter needs the fallback (#5317)`

## Design

`planJoinerPass` refused `NO_DEFAULT_GROUP` whenever
`identityDefaultGroupName` / `identityDefaultGroupId` was unset. Clearing the
fallback therefore refused every joiner pass, even one where every department
was mapped, while the audit row written when it was cleared said only unmapped
departments were affected (#5317 item 41).

The owner's decision (2026-11-14): refuse only when at least one PLANNED
starter's department is unmapped and so needs the fallback. The planner
already decided per starter whether the fallback was taken
(`groupIsDefaultFallback`, set when the department is empty or has no rule),
so the refusal now counts those among the PLANNED decisions:

```
planned.filter((d) => d.groupIsDefaultFallback).length > 0 && !defaultGroupId
  → NO_DEFAULT_GROUP
```

A starter who is not planned (another day, already provisioned, refused on
identity) is never created and so never needs a group.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-joiner-pass.ts` | The refusal's condition and its sentence, which now names how many planned starters need the fallback. |
| `src/app-layer/usecases/identity-entitlement-map.ts` | The audit sentence written when the fallback is cleared. |
| `src/app-layer/usecases/identity-joiner-run.ts` | A comment on the config read. |
| `docs/jml-joiner-design.md` | The refusal table's row. |
| `tests/unit/identity-joiner-pass.test.ts` | The planner cases. |
| `tests/unit/jobs/joiner-refused-plan-creates-nothing.test.ts` | The pass at AUTOMATIC creates with no fallback when every starter is mapped. |

## Decisions

- **Still one refusal for the pass, in its place in the order.** The code
  computed the fallback per starter but never skipped per starter: the
  refusal was always pass-wide. It stays pass-wide and after
  `NO_DEPARTMENT_MAP`, so a pass with one unmapped planned starter creates
  nobody, the mapped starters included. Turning it into a per-starter skip
  would be a different decision from the one the owner took.
- **Unmapped means what the decision means.** An empty department counts as
  unmapped, because `decide` gives it the fallback. The refusal reads the
  decision's own flag rather than recomputing the map lookup, so the two
  cannot disagree.
- **The audit sentence was still not quite true after the change.** "The
  joiner now refuses NO_DEFAULT_GROUP for unmapped departments" reads as
  though only those starters are refused. It now says a pass with a starter in
  an unmapped department refuses and creates nothing.
