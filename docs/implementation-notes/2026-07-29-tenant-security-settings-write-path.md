# 2026-07-29 — Tenant security settings: the missing write path

**Commit:** `<sha>` feat(admin): add the TenantSecuritySettings write path

Closes the second follow-up named in `2026-07-21-admin-privacy-posture.md`.

## The finding was real, and larger than described

The note said `auditStreamUrl`, `incidentAuthority` and `maxConcurrentSessions`
"have no write path; the admin settings route is GET-only".

Verified independently, then cross-checked by a parallel audit. Both agree:
**`TenantSecuritySettings` has exactly ONE writer in the entire repo** —
`mfa.ts:97` — and its upsert names only three columns
(`tenantId`, `mfaPolicy`, `sessionMaxAgeMinutes`). Every other column falls to
its schema default forever.

That is **eight** consumer-backed settings with no writer, not three:

| field | consumer | writer |
|---|---|---|
| `maxConcurrentSessions` | `session-tracker.ts` (Epic C.3) | none |
| `auditStreamUrl` | `audit-stream.ts` (Epic C.4) | none |
| `auditStreamSecretEncrypted` | `audit-stream.ts` | none |
| `aiGuardMode` | `ai/guard/index.ts` | none |
| `aiResidency` | `risk-suggestions.ts` | none |
| `aiLocalBaseUrl` | `risk-suggestions.ts` | none |
| `aiLocalModel` | `risk-suggestions.ts` | none |
| `mfaFailClosed` | `auth.ts` | none |

Epic C.4 is the clearest case: buffer, HMAC signing, retry with idempotency key
and OTel metrics all ship and all short-circuit on
`if (!settings?.auditStreamUrl || !settings.auditStreamSecretEncrypted)`. The
feature was complete and unreachable.

**`incidentAuthority` is different and is NOT fixed here.** Its only occurrences
repo-wide are the migration that created it, the schema line, and two doc
mentions — **zero references in `src/`**. It has no writer *and no reader*. Its
own schema comment claims "the incident view surfaces this as
`notify: <authority>`", which is false. Adding a write path would make it
settable but still inert; it needs a product decision (wire it into the NIS2
Art.23 incident view, or drop the column), not a form field.

## Design

One route, `GET|PUT /api/t/:slug/admin/security-settings`, gated `admin.manage`
on both verbs — mirroring `admin/risk-matrix-config`.

**Patch semantics are the load-bearing decision.** Only keys present in the body
are written; explicit `null` clears. This is correctness, not ergonomics:
`updateTenantMfaPolicy` upserts the SAME ROW and its update block writes
`sessionMaxAgeMinutes: input.… ?? null` unconditionally. A second writer sending
a whole row would silently reset whatever the other one owns. `mfaPolicy` and
`sessionMaxAgeMinutes` are deliberately absent from this schema — they already
have an owner.

**SSRF: validated at write time AND delivery time.** Delivery already runs
through `safeFetch` (`audit-stream.ts:178`), which is authoritative — it
re-resolves DNS and pins the connection. The write-time check
(`checkWebhookUrl`, the structural half) is additive so an operator typing an
internal URL gets a form error rather than hours of silent delivery failures,
and so unsafe values never land in the row. The *structural* check is used
rather than `assertPublicAddress` because a settings write should not fail
because the endpoint is briefly unresolvable; delivery re-checks DNS anyway.

**The HMAC secret is written as plaintext.** `auditStreamSecretEncrypted` is in
the Epic B manifest (`encrypted-fields.ts:125`), so the Prisma middleware
encrypts on write and decrypts on read. Encrypting in the usecase would
double-encrypt and the streamer would sign every batch with the wrong key — a
failure whose only symptom is a SIEM rejecting everything.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/tenant-security-settings.ts` | New. Patch-shaped read + write, authz, validation, audit. |
| `src/app-layer/schemas/tenant-security-settings.schemas.ts` | New. `.strict()` patch schema. |
| `src/app/api/t/[tenantSlug]/admin/security-settings/route.ts` | New. GET + PUT on `admin.manage`. |
| `src/lib/security/route-permissions.ts` | Rule for the new route. |
| `tests/guardrails/admin-route-coverage.test.ts` | Registry entry. |
| `public/openapi.json` | Regenerated. |
| `tests/unit/tenant-security-settings.test.ts` | New. 24 assertions. |

## Decisions

- **Covered all eight unreachable fields, not the three named.** They are the
  identical defect reached through the identical route. Shipping a settings page
  that deliberately omits half the unreachable settings would have been the
  worse outcome. Same reasoning as the vendor-policy fix the day before.

- **`maxConcurrentSessions` rejects 0.** The reader gates on
  `maxConcurrent > 0`, so a stored 0 or -1 falls into the same branch as null and
  reads as UNLIMITED. An admin typing 0 to mean "block additional sessions"
  would get the exact opposite, silently. The lower bound of 1 is the only place
  that can say so, and the error message says why.

- **The secret is never returned.** Reads expose `hasAuditStreamSecret: boolean`.
  The audit detail records changed field NAMES only — never values, since one is
  an HMAC secret and another is an internal endpoint. Three tests pin this,
  including a serialise-and-search for the secret string.

- **`aiResidency=LOCAL_ONLY` requires a gateway.** Enforced in the usecase rather
  than the Zod schema, because the patch may set only one side of the pair and
  the other has to come from the stored row — a cross-field invariant Zod cannot
  see.

- **Two defects in the first draft were caught by an adversarial re-read, not by
  the tests.** Both are recorded because the *class* of mistake is the durable
  lesson:

  1. The audit payload used `category: 'configuration'`, which is not in the
     enum at `json-columns.schemas.ts:28-35`. `validateAuditDetailsJson`
     **throws** on an unknown category, and the `logEvent` call is awaited
     *inside* the `runInTenantContext` transaction — so every valid save would
     have rolled back and returned 400. All 24 tests passed, because every one
     of them mocks `logEvent`: the suite was structurally blind to the only bug
     that mattered. The fix adds a test that runs the REAL validator over the
     REAL emitted payload, and a mutation check confirms reintroducing
     `'configuration'` fails exactly that one test and no other.
  2. `audit-stream.ts:137` requires BOTH `auditStreamUrl` and
     `auditStreamSecretEncrypted`; with only one set it returns null and the
     buffered batch is dropped. Saving a URL alone would have produced a
     settings page reporting streaming as configured while every event was
     silently discarded. The write path now refuses the half-configuration.

## Known adjacent weaknesses, deliberately not fixed here

- `session-tracker.ts` reads these settings inside a bare `try/catch` that falls
  back to "unlimited / NextAuth default" on ANY error. A transient DB blip
  therefore silently disables the session cap. That is a fail-open in a security
  control and deserves its own change.
- `safeFetch` does not set `redirect: 'manual'`, so a stored audit-stream URL
  that 302s to link-local space would still reach it — the write-time check
  cannot see the redirect target. Tracked separately.
