# The Audits surface: what is already right

This file exists to stop work, not to start it.

Five parts of the Audits surface were examined during the 2026-08 review and
found **correct**. Each one looks, at a glance, like the kind of thing a sweep
would "fix" — an external-access path, an RLS policy set, an unscoped-looking
file read, a vocabulary map, a set of E2E specs. Reviewing them again costs an
afternoon; changing them costs a regression in code that is currently load-
bearing and correct.

If you are here because a linter, an audit, or an LLM suggested a change to one
of these, read the entry first. The reasoning that made each one correct is
recorded here precisely because it is not visible from the code alone.

---

## 1 · The audit-pack share path — `usecases/audit-readiness/sharing.ts`

**This is the best-built external-access code in the repository.** It is the
reference to copy when adding any other public-token surface, not a candidate
for hardening.

What it already does:

- **32-byte CSPRNG token**, **SHA-256 at rest** — the raw token is never
  retrievable after issue.
- **Revocation AND expiry re-checked on both sides** — on the read
  (`sharing.ts:84-89`) and again on the public write (`:160-165`). Checking once
  and trusting the session is the usual mistake; this does neither.
- **An explicit PUBLIC projection** (`:92-95`) enumerating what may cross the
  boundary, rather than a deny-list of what may not. A field added to the model
  is invisible to the public surface by default.
- **DRAFT and soft-deleted packs are dead links** — the share URL of a pack that
  was never frozen resolves to nothing.
- `sanitizePlainText` on **body and authorLabel**, with length caps.
- A **belongs-to-this-pack check** on the referenced item, so a valid token
  cannot comment on someone else's pack item.
- `withTenantDb` scoping throughout.
- An audit row written with **`actorType: AUDITOR`, `userId: null`** — the trail
  records an external actor as an external actor rather than as nobody.

## 2 · RLS on the audit domain

All ten audit-domain models carry the **strict** policy form: `USING (tenantId =
current_setting(...))` plus a separate `FOR INSERT WITH CHECK`.

- There is **no nullable-`tenantId` model** in this domain, so the asymmetric
  single-policy shape required for `UserSession` (see
  `docs/epic-d-completeness.md`) does not apply here and must not be copied in.
- The two legacy ownership-chained policies were **correctly replaced** by
  `20260423200000_denorm_tenantid_phase3_simplify_rls`, with a `DROP` before
  each `CREATE`.
- **The Control permissive-sibling leak does not reproduce here.** If you are
  applying that fix across domains, this domain is already done — a second
  `CREATE POLICY` here would reintroduce exactly the permissive sibling the
  Control fix removed.

## 3 · `usecases/audit-hardening.ts:40-58` — the reference tenant-scoped file read

This is the **reference implementation** for reading a tenant-owned file:
resolve the `FileRecord` under `runInTenantContext`, `assertTenantKey` the
resolved `pathKey`, then read from the resolved key — never from the caller's
input. Covered by
`tests/unit/usecases/audit-hardening-file-oracle.test.ts`.

**Any note calling this an unscoped-`readStream` counter-example is stale.** It
was one, and it was fixed. The 2026-08 review used it as the model for the
SharePoint export's missing assertion, not the other way round.

## 4 · `_lib/status-variants.ts` — the model for vocabulary consolidation

The template for domain-vocabulary work anywhere in the repo. Its docstring
records **the exact contradictions it resolved** (list vs detail disagreeing on
`COMPLETE` and `READY`; the pack page collapsing two states to one) and then
**states the resolution rule** — terminal = `success`, in-flight = `info`,
pending = `warning`, inert = `neutral`.

The rule is the part that matters. `src/lib/readiness/bands.ts` was built to
this shape after the readiness thresholds regrew, because an extraction that
records only *what* it merged decays as soon as a new surface needs a variation;
one that records *why* tells the next author where their case belongs.

## 5 · The two E2E specs provision isolated tenants correctly

Both follow `docs/implementation-notes/2026-05-21-e2e-isolation.md`: mutating
specs take the `isolatedTenant` fixture, so a write can never touch the shared
seeded tenant or another test. No cross-test `let` cascade. Nothing to fix.

---

## Related

- `docs/implementation-notes/2026-08-09-audits-verified-defects.md` — the five
  defects that *were* real.
- `docs/implementation-notes/2026-08-10-audits-consolidation.md` — the
  duplication and dead schema removed alongside them.
- `docs/epic-d-completeness.md` — the asymmetric-RLS rationale that entry 2
  deliberately does not apply.
