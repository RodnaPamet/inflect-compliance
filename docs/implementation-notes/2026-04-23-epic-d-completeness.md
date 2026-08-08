# 2026-04-23 — Epic D: Isolation & Sanitisation Completeness

**Commit:** _(stamped post-commit)_

Three remediations that close the concrete gaps left after Epic C:

| Sub-epic | What |
| --- | --- |
| D.1 | `UserSession` RLS — asymmetric single-policy form for nullable-tenant tables |
| D.2 | Sanitisation rolled out across 5 audited usecases that write to encrypted free-text columns |
| D.3 | 7 tenant API routes migrated from `requireAdminCtx` to `requirePermission` |

## Design

### One pattern per nullable-tenant table

`UserSession` joins `IntegrationWebhookEvent` as the second
nullable-tenant table in the codebase. Both follow the same
asymmetric single-policy form documented in the original Epic A.1
RLS migration: `USING (tenantId IS NULL OR own) WITH CHECK (own)`.
Adding a third would not require a new shape — just a new entry in
`SINGLE_POLICY_EXCEPTIONS` plus a migration that pastes the same
two-policy template (`tenant_isolation` + `superuser_bypass`).

The deliberate choice: keep the exception list small and explicit
rather than inventing per-table policy variants. The
`SINGLE_POLICY_EXCEPTIONS` set has two entries today; a future PR
that adds a third must either inherit the asymmetric pattern (and
the post-loop `qual` + `with_check` sanity check verifies that
shape is real) OR add a Class-A pair with a separate
`tenant_isolation_insert` policy.

### Encryption ≠ "safe to render" — the per-file `sanitizeOptional`

Five usecase files needed sanitisation. They share the
optional-update three-state contract: `undefined` means "don't
touch", `null` means "explicit clear", `string` means "set to this
value (sanitised)". The shared `sanitizePlainText` helper returns
`''` on null/undefined input — so calling it directly on an
`undefined` patch field would silently turn an "untouched" column
into an empty-string write.

The fix: a 4-line `sanitizeOptional` helper inlined per file rather
than as a shared export. Inlining was the deliberate choice over
factoring — the function is small enough that keeping it next to
its consumers is more legible than threading another import. The
duplication is intentional and documented in each file's header
comment.

The `sanitize-rich-text-coverage` ratchet's
`SANITISER_COVERAGE_FLOOR = 8` makes the contract numeric: 3 from
Epic C.5 + 5 from Epic D.2. Bumping the floor requires editing the
constant AND adding a `History` line in the same comment block —
two parallel touches that a reviewer can spot in one diff.

### Audit visibility was the real prize of D.3

Migrating 7 routes from `requireAdminCtx` to `requirePermission`
looks like a refactor, but the actual unlock is audit visibility.
Before: a non-admin probe at `/billing/events` returned 403 and
left no trace in the `AuditLog` table — auditors and SIEM
consumers couldn't see the denial. After: every denial writes a
hash-chained `AUTHZ_DENIED` row with the permission key
(`admin.manage` or `admin.members`), the role of the actor, the
HTTP method, the path, and the request id — and (Epic C.4) is
streamed to any tenant-configured SIEM webhook within 5 seconds.

The legacy helper file (`src/lib/auth/require-admin.ts`) gained a
"STATUS — legacy / fallback only" header that names
`requirePermission` as canonical and lists the three legitimate
remaining usages (non-tenant routes, the legacy guardrail's accept
list, and tests of the legacy guard itself). Future contributors
reading the file see the migration story before they reach for the
old pattern.

### Self-service routes deserve a written exclusion

Widening `PRIVILEGED_ROOTS` to include `security/` brought 5
self-service routes (own MFA enrolment, own session revocation)
into the api-permission-coverage scope. They are NOT admin-gated
by design — any tenant member operates on their own MFA factor or
their own current session. Two options were possible: (a) wrap
each in `requirePermission` (denial would be self-denial — odd) or
(b) add them to `EXCLUDED_ROUTES` with written reasons.

Option (b) won. Each entry carries a one-line `reason` field
explaining the self-service contract; the guardrail logs a
`[exempt]` note for each during the test run, so the carve-out is
visible in CI output. Adding a new self-service route requires
either wrapping with `requirePermission` (preferred — even
"self-only" checks become audit-visible) or adding a new exclusion
with a reviewable reason.

## Files

| Created |
| --- |
| `prisma/migrations/20260423150000_epic_d1_user_session_rls/migration.sql` — `UserSession` RLS policies |
| `tests/integration/user-session-rls.test.ts` — 7 behavioural cases against live Postgres |
| `tests/unit/security/migrated-route-enforcement.test.ts` — 10 cases (one ADMIN-success + one READER-403-with-audit per migrated cluster) |
| `docs/epic-d-completeness.md` — operator runbook |
| `docs/implementation-notes/2026-04-23-epic-d-completeness.md` — this file |

| Updated |
| --- |
| `src/app-layer/usecases/finding.ts` — sanitiser import + per-file `sanitizeOptional` + sanitised `createFinding` + sanitised `updateFinding` |
| `src/app-layer/usecases/risk.ts` — same shape; covers `createRisk`, `createRiskFromTemplate`, `updateRisk` |
| `src/app-layer/usecases/vendor.ts` — same shape; `FREE_TEXT_VENDOR_FIELDS` allowlist for the loose-typed `updateVendor` patch; covers `createVendor`, `updateVendor`, `addVendorDocument`, `decideVendorAssessment` |
| `src/app-layer/usecases/audit.ts` — covers `createAudit`, `updateAudit` (incl. per-checklist `notes`) |
| `src/app-layer/usecases/control-test.ts` — covers `createTestPlan` (incl. `steps[]`), `updateTestPlan`, `completeTestRun` (incl. threading the sanitised value into the auto-created `CONTROL_GAP` task on FAIL) |
| `src/app/api/t/[tenantSlug]/billing/{checkout,portal,events}/route.ts` — migrated to `requirePermission('admin.manage', …)` |
| `src/app/api/t/[tenantSlug]/security/sessions/{revoke-all,revoke-user}/route.ts` — migrated to `requirePermission('admin.members', …)` |
| `src/app/api/t/[tenantSlug]/security/mfa/policy/route.ts` — PUT migrated; GET stays open |
| `src/app/api/t/[tenantSlug]/sso/route.ts` — all 4 verbs migrated |
| `src/app/api/t/[tenantSlug]/admin/key-rotation/route.ts` — docstring updated to reflect Epic D.3 status |
| `src/lib/security/route-permissions.ts` — 4 new rules (billing, security/sessions/revoke-{all,user}, security/mfa/policy PUT, sso) |
| `src/lib/auth/require-admin.ts` — header rewritten to mark the helper "legacy / fallback only" with explicit pointer to `requirePermission` |
| `tests/guardrails/rls-coverage.test.ts` — `'UserSession'` added to `SINGLE_POLICY_EXCEPTIONS`; post-loop sanity check now verifies the asymmetric `qual` + `with_check` shape via `pg_policies` |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` — 5 new entries in `RICH_TEXT_USECASES`; `SANITISER_COVERAGE_FLOOR = 8` ratchet + stale-path assertion added |
| `tests/unit/security/sanitize-write-paths.test.ts` — consolidated all 20 write-path tests in one canonical file (the previous prompt's separate `sanitize-encrypted-write-paths.test.ts` was merged in and deleted) |
| `tests/guardrails/api-permission-coverage.test.ts` — `PRIVILEGED_ROOTS` widened to include `billing/`, `sso/`, `security/`; `EXCLUDED_ROUTES` lists 5 self-service routes with written reasons |
| `CLAUDE.md` — new "Isolation & Sanitisation Completeness (Epic D)" section after the Epic C section |

## Decisions

- **Inline `sanitizeOptional` per usecase file** rather than a shared
  export. The body is 4 lines; inlining keeps the rule next to its
  consumers and makes the diff per file self-explanatory. The
  duplication is intentional and documented.

- **Each migrated route's denial flows through `requirePermission`** —
  not just for the audit row, but because that's what the api-
  permission-coverage guardrail recognises. Mixing patterns inside
  the same `src/app/api/t/` tree would have left the migrated routes
  uncovered by either guardrail.

- **Self-service routes excluded with written reasons** rather than
  forced through `requirePermission` with a self-only check. A
  self-only check would write an `AUTHZ_DENIED` row every time the
  user denies themselves — noisy and meaningless. The exclusion
  list is small (5 entries) and reviewable.

- **`requireAdminCtx` is not deleted** — it's still imported by
  non-tenant routes outside Epic D's audit scope and by the legacy
  guardrail's accept list. Deleting it now would either leave those
  callers broken or force a same-PR sweep beyond the brief. The
  helper's header explicitly marks it legacy / fallback so future
  callers see the right pattern first.

- **Sanitiser ratchet uses a numeric floor + history comment** rather
  than asserting an exact equality. Equality would force every
  legitimate addition into a same-line CI failure; floor + history
  lets the list grow naturally while preventing silent shrinkage.

- **`UserSession` RLS asymmetric-shape check reads `pg_policies`
  directly.** Asserting the policy by NAME (the previous shape) would
  let a "simplify" PR keep the name and strip a clause without
  failing CI. Reading `qual` and `with_check` from the catalog
  closes that loophole.

- **Behavioural RLS test runs against live Postgres.** Static
  guardrail catches the policy presence; behavioural test catches
  policy *correctness*. The two together are the contract — neither
  alone is enough.
