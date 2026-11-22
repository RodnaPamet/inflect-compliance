# 2026-11-22 — The risk automation triggers fire

**Commit:** `(this PR) fix(automation): the risk triggers fire; hide the dead Issue triggers (#3752)`

## Design

Found in the A2A production pilot: an "Invoke agent" rule on **Risk created**
showed 0 runs after a risk was created. Nothing emitted any risk trigger:
`emitRiskCreated` and its three siblings in `events/risk.events.ts` had no
caller outside a unit test whose header claimed every risk usecase called them.
The rule builder offered all four, so every rule on one was silently dead.

The risk usecases now emit, each AFTER its transaction commits, so a rolled-back
write fires no rule:

| Event | Emitted by |
| --- | --- |
| `RISK_CREATED` `{ title, score, category, status }` | `createRisk` (so the CSV import, per row), `createRiskFromTemplate`, `applySession` (accepted AI suggestions), onboarding's starter risks, all through `usecases/risk-automation-events.ts` |
| `RISK_UPDATED` `{ changedFields }` | `updateRisk`: the keys the caller supplied |
| `RISK_STATUS_CHANGED` `{ fromStatus, toStatus }` | `updateRisk` when the status moved; `bulkSetRiskStatus` per row that moved |
| `RISK_CONTROLS_MAPPED` `{ controlId, action: 'LINKED' }` | `linkControlToRisk` |

`ISSUE_CREATED` / `ISSUE_STATUS_CHANGED` had no producer either (Issues were
retired for Tasks). They are hidden from the builder rather than removed.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/risk.ts` | Emits the four risk events after commit |
| `src/app-layer/usecases/risk-automation-events.ts` | The one RISK_CREATED emitter every create path calls |
| `src/app-layer/usecases/risk-suggestions.ts`, `onboarding-automation.ts` | Emit RISK_CREATED per risk they create |
| `src/app-layer/automation/event-contracts.ts` | `RiskCreatedData.status` |
| `src/lib/automation/event-labels.ts` | `hidden` on the Issue events; risk condition fields the payload carries |
| `src/components/processes/RuleBuilderModal.tsx` | A stored hidden trigger stays selectable, labelled "(no longer emitted)" |
| `tests/guardrails/automation-trigger-has-producer.test.ts` | Every offered trigger has a called producer; every hidden one has none |
| `tests/integration/risk-automation-events.test.ts` | Real usecases against Postgres, and one dispatch through a real rule |

## Decisions

- **Every created risk fires "Risk created"**, bulk paths included (owner
  decision, 2026-11-22). A CSV import of N risks fires N times per rule.
- **Inline `emitAutomationEvent`, not the `risk.events.ts` helpers.** Each
  helper also writes an audit row, and every risk usecase already writes its
  own; calling them would have doubled the trail. The helpers stay, uncalled,
  and the guardrail asserts they are uncalled so nobody mistakes them for the
  wiring again.
- **The guardrail counts only CALLED producers.** A string literal beside an
  `emitAutomationEvent` call in a function nothing calls is exactly the defect;
  a guard that counted it would have passed throughout. It also recognises the
  schedule sweep's direct `enqueue('automation-event-dispatch', …)`.
- **Hidden, not removed.** Removing the Issue events from the catalogue would
  break the contracts' compile-time check and leave stored rules naming an
  unknown event; hiding stops new rules and keeps old ones legible.
- **Risk conditions match the payload.** A risk has no severity, so the
  `severity` condition offered on "Risk created" and "Risk updated" could never
  match; it is gone, and "Risk created" gains `category`. "Risk updated"
  carries only `changedFields`, so it offers no condition.
- **`status` is optional in the contract** only so hand-built test events need
  not set it; every producer sets it.
