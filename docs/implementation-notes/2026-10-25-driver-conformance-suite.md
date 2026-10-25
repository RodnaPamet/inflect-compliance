# 2026-10-25 — The driver conformance suite

**Commit:** `<sha> test(agentic): the driver conformance suite, instantiated for Flue (Claude agents 0b)`

Step 0b of the roadmap in `docs/claude-agent-sdk-design.md` (#4138).

## Design

```
tests/helpers/driver-conformance.ts           engine-agnostic: scenarios, observations, variances
  CONFORMANCE_SCENARIOS      10 run scenarios, each a run to make and an outcome to assert
  ADMISSION_SCENARIOS        1 scenario × 3 unvouched standings, plus a vouched positive control
  checkVariances             a variance names a known scenario, once, with a decision and a property
  describeDriverConformance / describeDriverAdmissionConformance

tests/flue/driver-conformance.test.ts          the Flue run adapter (flue project, native ESM)
tests/integration/driver-conformance-admission.test.ts   the Flue admission adapter (real DB)
tests/unit/driver-conformance-variances.test.ts          the variance rule, and no engine branch
```

An adapter scripts the model's turns, starts a run and reads back an
observation. The observation records:

- what each model call received;
- which calls left the deployment;
- the ledger rows;
- the decision rows;
- the funnel calls;
- the offered tool names;
- how the run settled.

Every scenario asserts on those, never on an internal call.

The Flue run adapter is as real as the `flue` project allows:

- **Real:** the boot (`ensureFlueRuntime`, the deployment's own providers, the
  telemetry interceptor, `planFlueStart`), the driver, residency, the tool
  core, the AI Guard and the Art 12 writer.
- **Faked:** the two model transports, by faux cores, and the database seams,
  in memory.
- **The funnel fake** throws what `denyToolCall` throws, so a kill observation
  cannot be an artefact of the fake.

## Files

| File | Role |
| --- | --- |
| `tests/helpers/driver-conformance.ts` | The tables, the adapter interfaces, the variance rule |
| `tests/flue/driver-conformance.test.ts` | Flue, run half |
| `tests/integration/driver-conformance-admission.test.ts` | Flue, admission half |
| `tests/unit/driver-conformance-variances.test.ts` | The variance rule and the no-engine-branch check |

## Decisions

- **Flue failed two scenarios as first written, and neither was weakened.**
  - `kill-switch-between-model-calls` failed: three model calls after the kill,
    and the run settled `COMPLETED`. Filed as #4196. Fixed first, by owner
    decision, in #4201, so the scenario is unchanged.
  - The ledger scenario asked for one `MODEL_CALL` step per model call. Flue
    writes one per dispatch, on purpose, with the call count. Filed as #4197.
    The owner chose the less restrictive bar on 2026-10-25:
    `ledger-accounts-for-every-call` asks that every model call be counted by a
    `MODEL_CALL` step naming how many calls it covers. The scenario was
    changed for every engine, not by a Flue variance. One step per call still
    satisfies it.
- **Admission is its own half.** Its outcome is "before the run row exists", so
  an adapter counts real rows. That needs the database, and the `flue` project
  cannot load `pg`. The vouched case is the positive control: without it, an
  engine that refused every run would pass every refusal.
- **The registration gate is real in the admission test.** Only the deployment
  switch (`resolveDriverForRun`) and the worker hand-off (`enqueue`) are
  mocked, because neither is the control under test.
- **Two status assertions were dropped from the first draft.** The secret and
  flagged scenarios asserted "not `COMPLETED`". The step does not ask for it,
  and it encoded Flue's settlement as the bar for every engine. Their
  non-vacuity comes from the mutation proofs instead. Disabling the argument
  guard or the result guard turns exactly that scenario red.
- **The project runs as native ESM.** CI passes `--experimental-vm-modules` and
  runs Node 24, so `jest.mock` hoisting does not apply. The run adapter
  registers its fakes with `jest.unstable_mockModule` and imports everything
  that reaches them afterwards. Locally, Node 22 cannot even load the project
  (`dedent`'s ESM build).
- **No engine branch, held by counting.** The helper reads the adapter's engine
  name exactly twice, both in describe titles.
  `driver-conformance-variances.test.ts` counts both.
