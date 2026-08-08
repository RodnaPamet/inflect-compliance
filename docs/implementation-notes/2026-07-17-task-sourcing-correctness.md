# 2026-07-17 — Task-sourcing correctness

**Commit:** `<pending> fix(tasks): make task sourcing a real compliance loop`

## Design

Tasks are the platform's remediation engine: sensors and jobs spawn them,
and completing them is supposed to reflect back on the source. Four
plumbing defects broke that loop.

1. **Invalid `WorkItemSource` spawns.** KRI-breach passed
   `source: 'kri_breach'` and risk-appetite passed
   `source: 'risk_appetite_breach'` — neither is a `WorkItemSource` enum
   member. The KRI spawn was swallowed in a try/catch (task silently never
   created); the risk-appetite spawn was unguarded (500). Both are now
   `RISK_MONITOR` (a new enum member — risk-monitoring sensors deserve a
   distinct provenance). `WorkItemRepository.create` no longer blind-casts
   `source as WorkItemSource`: `normalizeWorkItemSource` validates at the
   write boundary and throws a 400 on an unknown value, so a bad source
   fails loudly, never silently. A guardrail
   (`tests/guardrails/workitem-source-valid.test.ts`) scans every
   `createTask` / `db.task.create` call site for a literal `source:` and
   asserts it is a real enum member.

   **Second bug the 500 was masking:** both spawners also passed
   `priority: 'HIGH'`, which is not a `WorkItemPriority` (P0–P3). Fixed to
   `P1`. (Priority/severity/type still use blind casts in the repo — a
   follow-up could normalise them the same way `source` now is.)

2. **Reconciler leaks.** `task-source-reconcile` handled only
   CONTROL_GAP→control-recheck, vuln→mitigated, and finding→closed. Added
   four reconcilers so completing the task reflects on its source:
   - **risk-appetite breach** — keyed on `RiskAppetiteBreach.remediationTaskId`
     (the field was written but never read by the loop-closing path); sets
     `resolvedAt`.
   - **KRI breach** — needed a persisted pointer: `KriReading` gains
     `remediationTaskId` + `addressedAt`; the spawn pins the task on the
     breaching reading, and the reconciler stamps `addressedAt`.
   - **policy-review reminder** — keyed on `source = POLICY_REVIEW` + the
     POLICY TaskLink; advances the policy review cycle (mirrors
     `markPolicyReviewed`).
   - **evidence-expiry reminder** — keyed on `source = EVIDENCE_EXPIRY` +
     the EVIDENCE TaskLink; records the refresh acknowledgement and services
     the review cadence (`nextReviewDate`). Deliberately does NOT touch
     `retentionUntil` — only a real re-upload/extension moves the actual
     expiry, so the sweep correctly re-raises if the evidence is still
     expiring.
   - **NIS2 plain-TASK remediations** — intentionally NOT reconciled: they
     are `type=CONTROL_GAP` with `controlId=null` (no CONTROL_LINK), and the
     gap self-assessment answer is the source of truth. Closing the nudge
     task must not silently flip an unanswered self-assessment. Noted in a
     comment at the dispatch site.

3. **control-test FAIL idempotency.** Both FAIL→CONTROL_GAP spawn sites
   minted a fresh task on every failing run. Added `hasOpenGapTask`
   (findFirst on `type=CONTROL_GAP`, `controlId`, non-terminal status,
   `metadataJson.testPlanId`) so a re-run reuses the open task per
   (control, plan) — mirrors the dedupe in retention-notifications + the
   automation executor.

4. **Job spawners routed through `createTask`.** `action-executor`,
   `policyReviewReminder`, and `retention-notifications` used raw
   `db.task.create` — no TSK-N key, no TASK_CREATED audit/automation event,
   no assignee bell/email. All three now build a system `RequestContext`
   and call the canonical `createTask`, so a job-spawned task has the same
   provenance as any other. The automation executor's dedupe key moved from
   `key` (now a real TSK-N) into `metadataJson.automationDedupeKey`; the
   execution-claim row already prevents concurrent double-fire, so the
   metadata key is the over-time idempotency guard.

## Files

| File | Role |
|------|------|
| `prisma/schema/enums.prisma` | `WorkItemSource += RISK_MONITOR` |
| `prisma/schema/risk.prisma` | `KriReading += remediationTaskId, addressedAt` + index |
| `prisma/migrations/20260717120000_task_sourcing_correctness/` | additive enum value + two nullable columns + index |
| `src/app-layer/repositories/WorkItemRepository.ts` | `normalizeWorkItemSource` boundary validation |
| `src/app-layer/usecases/key-risk-indicator.ts` | `RISK_MONITOR` + `P1`; pin reading→task |
| `src/app-layer/usecases/risk-appetite.ts` | `RISK_MONITOR` + `P1` |
| `src/app-layer/usecases/task-source-reconcile.ts` | +4 reconcilers, NIS2 note |
| `src/app-layer/usecases/control-test.ts` | `hasOpenGapTask` idempotency guard (both sites) |
| `src/app-layer/automation/action-executor.ts` | route CREATE_TASK through canonical createTask; metadata dedupe |
| `src/app-layer/jobs/policyReviewReminder.ts` | route through createTask + addTaskLink |
| `src/app-layer/jobs/retention-notifications.ts` | route through createTask + addTaskLink |
| `src/app/t/[tenantSlug]/(app)/tasks/filter-defs.ts` | RISK_MONITOR source filter |

## Decisions

- **`RISK_MONITOR` as a new enum member, not a reuse.** KRI + risk-appetite
  breaches are a distinct provenance from MANUAL/INTEGRATION; a real member
  makes them filterable in the inbox and honest in audit.
- **KRI needed a new persisted pointer.** Unlike vuln/risk-appetite (which
  already had `remediationTaskId`), KRI had nothing to reconcile against —
  hence the two new `KriReading` columns rather than shoehorning onto an
  existing field.
- **Evidence-expiry reconciler advances `nextReviewDate`, not
  `retentionUntil`.** Closing a reminder means "attended to", not
  "re-uploaded" — fabricating a retention extension would hide a still-stale
  artefact from the sweep.
- **Automation dedupe moved to metadata.** Routing through the canonical
  createTask means the visible `key` is a TSK-N sequence value, so the
  deterministic dedupe key rides `metadataJson`; correctness is unchanged
  because the execution-claim row already serialises concurrent fires.
