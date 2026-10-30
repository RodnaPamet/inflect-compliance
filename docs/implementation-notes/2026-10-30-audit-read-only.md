# 2026-10-30 — Completed and cancelled audits are read-only

**Commit:** see PR for #4531

## Design

Owner decision (2026-10-30): a COMPLETED or CANCELLED internal audit is read-only, on the server as well as the page.

- `src/lib/audit-lifecycle.ts` holds the rule as one pure function, `auditWriteRefusal(currentStatus, update)`. It has no imports, so the page and the usecase read the same rule.
  - COMPLETED accepts one write: `{ status: 'IN_PROGRESS' }`, and nothing else in the same body.
  - CANCELLED accepts nothing.
  - An update that writes nothing is not refused.
- `updateAudit` asks it first. It reads the status through `AuditRepository.lockStatus`, a `SELECT … FOR UPDATE`, before any field, checklist result or FAIL cascade.
- A refusal is a 409 `ConflictError` with `details.reason` set to `AUDIT_COMPLETED_READ_ONLY` or `AUDIT_CANCELLED_READ_ONLY`.
- On the page, a read-only audit shows a notice and offers no Edit, no result pickers and no finding button. The status move back to In Progress stays.
- A refusal from the server, for an audit that closed while the page had it open, is shown in the page's own words.

## Files

| File | Role |
| --- | --- |
| `src/lib/audit-lifecycle.ts` | The rule and the refusal reasons |
| `src/app-layer/repositories/AuditRepository.ts` | `lockStatus`, the status read under a row lock |
| `src/app-layer/usecases/audit.ts` | `updateAudit` refuses first |
| `src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx` | Read-only pane; `aria-label` moved onto `buttonProps` |
| `src/app/t/[tenantSlug]/(app)/audits/_lib/audit-write-error.ts` | Carries the reason, so the page can localise it |
| `src/app/t/[tenantSlug]/(app)/audits/NewAuditModal.tsx` | Discard prompt is a `ConfirmDialog`, as in the task form |

## Decisions

- **The lock is a row lock, not a status-conditional update.** The rule depends on what the body writes, so it cannot be a single `WHERE status …` clause.
  - Without the lock, under READ COMMITTED, the edit reads PLANNED, blocks on the row for its UPDATE, and then writes onto the audit a concurrent transaction just cancelled.
  - `tests/integration/audit-read-only.test.ts` reproduces that race and fails when `FOR UPDATE` is removed.
- **Linking a finding to a closed audit is still possible from elsewhere.** `createFinding` takes an `auditId` and does not check its status, and auditor share comments are materialised into findings on their audit after fieldwork, often once it is completed. Only the audits page's own finding button is withheld. Refusing it in `createFinding` would break the auditor flow.
- **The rule covers the one write seam.** `updateAudit` is the only writer of `Audit` after creation; both audit `[id]` routes call it.
