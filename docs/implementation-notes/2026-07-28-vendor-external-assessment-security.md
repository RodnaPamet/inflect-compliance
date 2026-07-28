# 2026-07-28 — Vendor external-assessment security hardening

**Commit:** `<pending> fix(vendor): close the external-assessment path — RLS, evidence ownership, rate limiting, revocation`

## Design

The vendor external-assessment flow is the only place in the product where an
**unauthenticated party writes to tenant-scoped tables**. A respondent gets a
link, loads a questionnaire, and submits up to 500 answers — with no session,
no membership, and no `RequestContext` derived from auth.

The token layer guarding that was already strong and is untouched here:
32-byte CSPRNG, SHA-256 at rest, raw returned once, expiry clamped 1–90 days,
`timingSafeEqual` compare, token↔assessment binding, and an `ALLOWED_STATUSES`
gate that makes links self-expire on submit.

What sat *behind* that door was weaker than the door. Five gaps, all closed
here, with `audit-readiness/sharing.ts` as the reference implementation —
it solves the same problem (anonymous holder of a share token writing into a
tenant) and solves it correctly.

**RLS was never engaged.** `external-assessment-access.ts` documented the
model in its module header: *"subsequent reads/writes wrap that tenantId in
`runInTenantContext` so RLS still gates the data layer."* Nothing did.
Every read and the entire write transaction used the bare `prisma` client, so
`SET LOCAL ROLE app_user` + `set_config('app.tenant_id')` never ran. The
second isolation layer — the one CLAUDE.md calls architecturally
impossible to bypass by accident — was simply absent on the one path where
the caller is anonymous. Both writes also carried no tenantId predicate at
all: the answer upsert keyed on `assessmentId_questionId`, the status
transition on `id`.

Reads now run in `withTenantDb(assessment.tenantId, …)` and the write
transaction in `runInTenantContext`, which additionally preserves the
actor/requestId audit binding. Both writes gained explicit tenantId
predicates via Prisma's extended `where`.

`verifyAccessToken` deliberately stays outside a tenant context — it is the
lookup that *discovers* the tenant, so wrapping it would be circular. The
ratchet asserts this stays true in both directions.

**evidenceId was unverified.** The column carries a real FK
(`VendorAssessmentAnswer_evidenceId_fkey`), so the arbitrary-string write
some readings suggest is not possible — Postgres rejects it. But an FK
proves *existence*, not *ownership*: a respondent who guessed a valid
Evidence cuid from another tenant could attach it, and the reviewer surface
reads answers back verbatim. Claimed ids are now looked up scoped to the
assessment's tenant and rejected if unowned — the same shape as `sharing.ts`
verifying `auditPackItemId` belongs to the share's pack.

**No rate limiting.** `middleware.ts` edge-limits every other anonymous
surface — `/trust/`, `/api/trust/`, the device-report endpoint — and then
`/vendor-assessment/` and `/api/vendor-assessment/` fell through to the bare
`isPublicPath` allow. Token brute-force, assessment-id enumeration and
repeated 500-answer submits were all unthrottled. Now limited before the
allow, keyed per assessment so one noisy respondent cannot starve another.

**No revocation.** A leaked link had three exits, all bad: wait for expiry,
resend (which *rotates* the token, invalidating anything already shared —
useless when the goal is to stop the leaked one), or drag the assessment out
of `SENT`/`IN_PROGRESS`, corrupting lifecycle to get a security outcome.
`revokedAt` mirrors `AuditPackShare.revokedAt`; `verifyAccessToken` denies on
it as a reason distinct from `expired`, because the two are different events.

**Free text was persisted raw** and rendered verbatim on the reviewer
surface. Now sanitised at persist — sanitising at render would leave the row
itself dangerous to PDF export and any SDK consumer.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/vendor-assessment-response.ts` | Tenant contexts, tenantId predicates, evidence ownership check, `sanitizeAnswerJson`, required-upload fix, zeroed respondent ctx |
| `src/lib/security/external-assessment-access.ts` | `revoked` failure reason + gate |
| `src/app-layer/usecases/vendor-assessment-send.ts` | `revokeAssessmentLink` usecase |
| `src/app/api/t/[tenantSlug]/vendor-assessment-reviews/[assessmentId]/revoke/route.ts` | Revoke route |
| `src/app/api/vendor-assessment/[assessmentId]/{route,submit/route}.ts` | Map `revoked` → 410 |
| `src/middleware.ts` | Edge rate limit before the public-path allow |
| `prisma/schema/vendor.prisma` + migration | `VendorAssessment.revokedAt` |

## Decisions

- **Zeroed the respondent context rather than deleting it.** `logEvent` and
  `runInTenantContext` read only `tenantId` / `userId` / `requestId`, so the
  forged `role: 'EDITOR'` + `canWrite: true` was dead weight — but dead
  weight shaped exactly like a live privilege, inside the write transaction,
  waiting for future code to consult `ctx.permissions`. The fields stay
  (the type requires them) with every capability `false`.

- **Required FILE_UPLOAD accepts an evidenceId OR a note — not an
  evidenceId alone.** The bug is real: `{ questionId, answerJson: null }`
  satisfied a required upload, because the required-field sweep only checks
  whether the questionId appears in the payload. But demanding an
  `evidenceId` would make every required upload question *unsubmittable*,
  because the respondent surface deliberately ships a note field rather than
  an uploader at this stage (`external.vendorAssessment.fileUploadHint`:
  *"File-upload responses are coordinated through your contact"*). So the
  fix rejects emptiness, which is the actual defect. A real anonymous upload
  path needs a storage key, an AV gate and a quota before an unauthenticated
  party can put bytes in a tenant's bucket — that is its own work.

- **The raw send-response token was left alone.** The concern was that it
  puts a live credential into response logs, but this codebase does not log
  response bodies (`errors/api.ts` logs status/route/duration metadata), and
  the one-time UI reveal depends on the token crossing the wire — there is
  no other channel. Removing it would break the feature to close a leak that
  is not there. Worth revisiting only alongside a dedicated reveal endpoint.

- **Only `revokedAt`, no `revokedByUserId`.** The reference model
  (`AuditPackShare`) stores only the timestamp and leaves the actor to the
  audit event. Adding the column would have pulled in a User relation, a
  back-relation, and an FK index for information the audit trail already
  holds.

- **The post-commit notify path keeps its bare transaction.** It reads a
  `User` (not tenant-scoped) and writes an outbox row with an explicit
  tenantId, after the assessment is already committed. Its sibling call site
  in `vendor-assessment-review.ts` does the same; changing one and not the
  other would be worse than changing neither.
