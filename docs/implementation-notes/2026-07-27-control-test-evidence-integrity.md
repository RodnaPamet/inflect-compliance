# 2026-07-27 — Control-test evidence integrity

**Commit:** `<sha>` fix(tests): freeze evidence after completion + close the fail-open integrity path

## Design

A completed control-test run is audit evidence; its verdict is already immutable
(`completeTestRun` rejects a second completion). These fixes close the gaps in
the EVIDENCE backing that frozen verdict.

### The CRITICAL chain (1–3)
Three gaps together let audit evidence be fabricated and then pass verification:

1. **Evidence mutable after completion.** `linkEvidenceToRun` /
   `unlinkEvidenceFromRun` did no run-status check, so a signed-off PASS/FAIL
   could gain or lose evidence. Both now reject when `run.status === 'COMPLETED'`
   (an amendment must fork a new run via `retestFromRun`), and the run page
   hides the add/unlink affordances on a completed run.
2. **Unlink hard-deleted the frozen hash.** The link row (and its `sha256Hash`)
   is genuinely destroyed and the audit recorded only the linkId. The unlink now
   records the destroyed `{kind, fileId, sha256Hash}` in the audit detail, so the
   deletion is reconstructible.
3. **Integrity check was fail-open.** A FILE link whose `fileId` didn't resolve
   was stored with a `null` hash and linked anyway, and `verifyRunEvidence`
   scored `matches === null` as VERIFIED — so a foreign/missing fileId reported
   `integrityOk: true`. Now an unresolvable FILE link is REJECTED at link time,
   and `allFileLinksVerified` requires `matches === true` (null/false → not
   verified). Unlink is scoped to the run in the URL (#9) so a link can't be
   deleted through an unrelated run.

### Authorization (4, 6, 7)
- **Export was ungated** — `assertCanReadTests` resolves to a flag true for every
  role, so a READER could export every run's notes/hashes/control codes. Export
  now gates on `reports.export`.
- **Granular `tests.*` keys were unenforceable** — the policy helpers read the
  coarse `permissions.canRead/canWrite` computed from `baseRole`, ignoring a
  custom role's `permissionsJson`. They now read `appPermissions.tests.*` (the
  custom-role-aware set), so `tests.execute:false` on an EDITOR base is finally
  enforced. Built-in-role behaviour is unchanged.
- **Bulk delete was write-tier** — an EDITOR could soft-delete the whole test
  program. It now requires `admin.manage`, matching the peer bulk registers, and
  finally bumps the list-cache version.

### Automation back door + validation (5, 8, 9)
- `automation-run` took raw `req.json()` and minted a COMPLETED PASS (attesting
  the control, rolling both cadences) without sanitising notes, bounding the
  evidence array, or checking the plan is ACTIVE. It now parses with Zod
  (bounded array), sanitises notes, enforces plan-ACTIVE, freezes/validates FILE
  evidence hashes (batched, no N+1), and requires the execute tier.
- `createTestPlan` validates the path controlId in-tenant; create/update/
  bulkAssign validate `ownerUserId` is an ACTIVE member (the owner is
  auto-assigned the CONTROL_GAP task on FAIL); `linkEvidenceToRun` validates an
  EVIDENCE link's `evidenceId`.
- `startTestRun`/`completeTestRun` gained the plan-ACTIVE guard `createTestRun`
  already had; the export/snapshot/automation routes validate their bodies with
  Zod + a JSON try/catch (400 vs 500); the `/tests/due` doc now matches its gate.

## Files
| File | Role |
|---|---|
| `usecases/control-test.ts` | link/unlink completion+scope guards, FILE/evidence resolution, plan-ACTIVE, owner/control validators, bulk-delete tier |
| `usecases/test-hardening.ts` | fail-closed `verifyRunEvidence`, export gate + truncation flag |
| `policies/test.policies.ts` | granular `tests.*` + admin + export gates on `appPermissions` |
| `events/test.events.ts` | unlink records the destroyed link fields |
| routes: export / automation-run / snapshot / evidence[linkId] | Zod validation, export permission, run-scoped unlink |
| `tests/runs/[runId]/page.tsx` | hide evidence mutation on a completed run |

## Decisions
- **Audit-record over soft-delete for the destroyed link (2).** Recording the
  destroyed fields keeps the deletion reconstructible without a schema migration
  (`ControlTestEvidenceLink` has no `deletedAt`); combined with (1), a completed
  run's evidence can't be unlinked at all, so the residual concern is only
  non-completed runs.
- **Wire the granular keys, don't delete them (6).** Enforcing `tests.*` via
  `appPermissions` delivers the control the PermissionSet advertised; deleting the
  keys would have removed a capability tenants configure.
- **Usecase-layer enforcement, not route `requirePermission` (6).** The test
  routes are not a privileged root, so the load-bearing gate is the policy helper
  every route already funnels through.
