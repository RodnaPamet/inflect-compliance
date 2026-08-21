# 2026-08-21 — what our coverage sweeps cannot see

**Commit:** `(this branch) test(guardrails): widen three coverage denominators that were keyed on their own marker`

## Why

The prev/next stepper rollout swept for detail pages using `EntityDetailLayout`,
wired every one it found, and read as finished. Three detail routes with real
sibling lists were never touched, because none used that shell — so none entered
the denominator. They were not considered and rejected; **they were not reached**.
One was missed by the implementing lane *and* by its adversarial verifier.

Generalised: **a sweep keyed on a marker reports complete coverage of the things
carrying that marker, and is silent about everything else. The number looks like
coverage and is a census of one pattern.**

This note audits the repo's coverage-shaped guards for that failure mode. Three
were widened here; the rest are recorded with their blind spot and a verdict.

A guard that only *claims* to cover one pattern is honest. One whose name or
failure message implies whole-repo coverage is not. That distinction is the
verdict column below.

## Findings

### 1. `hibp-coverage.test.ts` — the structural scan could not see its own flagship route

**Denominator (before):** files under `src/app/api/**/route.ts` containing an
**inline** Zod field matching
`/\b(password|newPassword|currentPassword|confirmPassword)\s*:\s*z\./`.

**What it could not see:** any route whose body schema is declared elsewhere.
That is not hypothetical — it is the repo's own house style. Running the guard's
exact regex over all 581 route files yields **two** hits:
`auth/change-password` and `auth/reset-password`. `auth/register/route.ts` — the
route the guard's docblock names first, the one that creates accounts — matches
**zero** times, because it parses `AuthActionSchema` imported from `@/lib/schemas`
(which unions `AuthRegisterSchema`, where `password: z.string().min(8)` actually
lives). Register was covered *only* because a human had put it on the curated
`HIBP_REQUIRED_ROUTES` list.

So the "auto-fails any new route that parses a password field" claim in CLAUDE.md
held for one of the two ways this repo writes such a route, and the *other* way is
the one the canonical example uses. A fourth password route written like `register`
would have landed unregistered and unnoticed.

CLAUDE.md's workaround — "define password schemas inline in the route file so the
scan sees them" — is a house rule asking contributors to compensate for a detector,
and the flagship route already breaks it.

**Verdict: not acceptable, and small enough to fix.** The scan now resolves one
hop: it reads `src/lib/schemas` + `src/app-layer/schemas`, computes the exported
schemas that carry a password-shaped field (to a fixpoint, so `AuthActionSchema`
inherits from `AuthRegisterSchema`), and treats a route importing one of those
names exactly like a route declaring the field inline. A sanity assertion pins
that the shared-schema set is non-empty and contains both names, so the widened
branch cannot pass by finding nothing.

*Mutation proof:* deleting the `register` entry from `HIBP_REQUIRED_ROUTES` now
fails with `Route src/app/api/auth/register/route.ts parses a password-bearing
shared schema AuthActionSchema but is not registered`. Before the widening, the
same deletion left the structural scan green.

### 2. `rls-coverage.test.ts` / the Prisma tripwire — a tenant table outside the tenant-table list

**Denominator:** `TENANT_SCOPED_MODELS` = every DMMF model carrying a `tenantId`
field, plus `OWNERSHIP_CHAINED_MODELS`, a hand-kept list that had **one** entry.

**What it could not see:** a table that is tenant-scoped through its parent and
therefore carries no `tenantId` column. Parsing the schema for models with no
`tenantId` that hold a to-one relation to a tenant-scoped model gives three
candidates, and one is a real miss:

- **`PolicyAcknowledgementAssignment`** — shipped 2026-07-15. Its migration
  (`20260715140000_policy_ack_assignment`) creates the table *with* the mirrored
  `EXISTS`-on-`PolicyVersion.tenantId` policy and even says "mirrors
  PolicyAcknowledgement's RLS". The RLS is real; the **list entry was never
  added**. Consequences: `rls-coverage.test.ts` never verified the policy exists
  (a later migration could drop it with CI green), and `isTenantScopedModel`
  returned `false`, so the tripwire would not warn on a context-less query. Both
  its sibling `PolicyAcknowledgement` and it are read/written side by side in
  `usecases/policy-attestation.ts`, under the same `db` — only one was watched.
- `FrameworkMapping` — genuinely has no RLS, and that is deliberate: the
  `20260323180000_apply_full_rls_setup` migration records it as "global by design
  (cross-tenant mapping)", and no code in `src/` writes it (`ControlRepository`
  calls it "the legacy frameworkMapping island"). **Acceptable** — but note the
  justification lives in a migration comment, not in anything the guard reads.
- `Tenant` — the root, correctly excluded.

**Verdict: not acceptable, one line to fix.** `PolicyAcknowledgementAssignment`
added to `OWNERSHIP_CHAINED_MODELS`.

*Mutation proof:* temporarily adding `FrameworkMapping` to the same list turns
`rls-coverage.test.ts` red on three DB-backed assertions (missing
`tenant_isolation`, missing `superuser_bypass`, missing `FORCE ROW LEVEL
SECURITY`) — proving the list is a live denominator against a real database and
that the new entry is now genuinely checked, not merely listed. Removed; green.

### 3. `api-permission-coverage.test.ts` — 489 of 581 route files are outside the scan

**Denominator:** `PRIVILEGED_ROOTS`, fifteen hand-listed directories. Walking
them reaches **92** route files. `src/app/api` holds **581**.

This guard is unusually self-aware — it already carries an "every
`EXCLUDED_ROUTES` entry is actually reachable by the scan" test, written after
`/api/account` turned out to be excluded by entries no root covered. But the
remedy was applied per-directory, and one large surface was never triaged:

**`/api/org/**` — 25 route files, none in any root.** This is the organization
tier: org member add/update/remove, org invite create/revoke, attaching and
detaching tenants from an org, setting org threat level and maturity. Every one
of them is gated — verified route by route: 8 gate at the route with
`if (!ctx.permissions.canManageMembers | canManageTenants | canDrillDown) throw
forbidden(...)`, and the rest gate inside the usecase
(`org-threat-level.ts:89 canSetThreatLevel`, `org-maturity.ts:190 canSetMaturity`,
`org-security-initiative.ts:59 canConfigureDashboard`,
`org-dashboard-widgets.ts:62`). Underneath all of them, `getOrgCtx`
(`src/app-layer/context.ts:183`) resolves the caller's `OrgMembership` and throws
an external 404 when there is none, so org membership is a floor no route can skip.
**There is no open door here.**

What is missing is the other half of C.1. `AUTHZ_DENIED` is written in exactly
one place — `src/lib/security/permission-middleware.ts` — so every one of those
denials is a 403 with no audit row. That is the precise defect this guard's own
comment records for `/api/admin/diagnostics` ("a 403 that writes no AUTHZ_DENIED
row"), reproduced across a 25-route surface, and nothing forward-enforces that
the 26th org route arrives with any gate at all.

**Verdict: acceptable today, not acceptable as a standing arrangement — and too
big for this lane.** Adding `src/app/api/org` as a privileged root means either 25
`EXCLUDED_ROUTES` entries with reasons, or extending `requirePermission` to resolve
an *org* role rather than a tenant role. Both are real design work. Recorded here
rather than half-done.

### 4. `usecase-test-coverage.test.ts` — 8 of 10 exemptions had quietly earned their way off

**Denominator:** `src/app-layer/usecases/**` minus `EXEMPTIONS`. The coverage test
does `if (uc in EXEMPTIONS) continue;` **before** running the detector, so an
exemption removes the file from the denominator permanently and nothing ever
rechecks it.

Eight of the ten exempt files now have a direct
`from '@/app-layer/usecases/<path>'` test — `clause`, `framework/catalog`,
`framework/tree`, `org-audit`, `inherited-control-data`, `vendor-audit`,
`traceability-graph`, `test-hardening`. Their reasons still read "pending direct
unit tests". The visible debt figure (`BASELINE = 10`) overstated reality by 5×,
and — the part that matters — deleting `clause-usecase.test.ts` tomorrow would not
have failed this suite, because `clause.ts` was no longer in the denominator.

**Verdict: fixed.** Stale entries deleted, `BASELINE` 10 → 2, and a new
`no EXEMPTIONS entry is stale` test runs the *same* `isImported` detector against
the exempt files so the two halves cannot disagree. `api-permission-coverage.test.ts`
already had this shape for `EXCLUDED_ROUTES`; this is that pattern applied to the
other list.

*Mutation proof:* re-adding `clause.ts` to `EXEMPTIONS` fails the new test naming
that file. Removed; green.

### 5. `encryption-manifest-coverage.test.ts` — a 13-word name regex is the denominator

**Denominator:** tenant-scoped models × `String` columns whose **name** matches
`/note|comment|description|summary|content|reason|answer|body|detail|finding|
remediation|treatment/i`.

**What it cannot see:** free text under any other name. Scanning tenant-scoped
models for `String` columns that read as free text, do not match the heuristic,
and are absent from `ENCRYPTED_FIELDS` yields **55** columns. The sharpest pair:

- `ControlException.justification` **is** encrypted.
- `Control.applicabilityJustification` and
  `ControlRequirementLink.applicabilityJustification` are **plaintext**.

Same word, opposite treatment, and the guard cannot notice either way, because
`justification` is not in the regex — `ControlException` is encrypted because a
person decided to, not because anything asked. Others in the same class:
`AiSystem.classificationRationale`, `RiskAppetiteConfig.appetiteStatement`,
`RiskControl.rationale`, `AssetRiskLink.rationale`, `RiskCorrelation.rationale`.

Many of the 55 are `title` columns that are plaintext *on purpose* (substring
search), which is exactly why widening the regex is not a one-line change: it
would demand ~55 triage decisions, several of them product calls about search.

**Verdict: acceptable blind spot, misleading name.** The file is called
`encryption-manifest-**coverage**`; what it measures is "no column whose name
looks sensitive is unencrypted or undocumented". Those are different claims. The
`NOT_SENSITIVE` map is genuinely good — every entry carries a reason — but it can
only ever hold columns the regex found.

### 6. `sanitize-rich-text-coverage.test.ts` — honest, and its acceptability rests on one unguarded fact

**Denominator:** `ENCRYPTED_FIELDS`, i.e. "every encrypted business-content model
must be classified as sanitised / not-rich-text / known-gap". This guard was
already rebuilt away from the `SANITISER_COVERAGE_FLOOR = 8` that CLAUDE.md still
documents, and its header explains precisely why a floor cannot prove completeness.
It is the best-shaped guard in this audit.

**What it cannot see:** user-supplied free text on a model that is *not*
encrypted — `Control.description`, `Evidence.title`, `Policy.description`, the
`ProcessNode.label` canvas strings.

**Verdict: acceptable — but for a reason the guard does not state.** The whole
repo has four `dangerouslySetInnerHTML` sites; three are the theme-init script and
a comment, and the fourth is
`t/[tenantSlug]/(app)/policies/[policyId]/page.tsx:473`, rendering
`PolicyVersion.contentText`, which *is* covered. So React auto-escaping is
carrying the unencrypted columns. Nothing guards that — a new
`dangerouslySetInnerHTML` over an unencrypted column would be a real XSS with no
ratchet in its way.

### 7. `query-shape-guardrails.test.ts` (D1/D2) + `schema-index-coverage` Layer C — `src/app-layer` only

**Denominator:** source under `src/app-layer`. Route handlers, `src/lib`, and
server components are outside it.

**Concrete:** `listActiveSessionsForTenant` in `src/lib/security/session-tracker.ts`
is a `findMany` over every non-revoked, non-expired `UserSession` in a tenant with
**no `take:`**, ordered by `lastActiveAt`. D2's unbounded-`findMany` budget never
counts it. Likewise `TenantScimToken`, `BillingEvent` and `UserSession` are
`findMany`'d only outside `src/app-layer` and appear in **neither** Layer C map, so
the C-completeness triage never fired for them.

**Verdict: acceptable, low consequence, worth knowing.** The indexes those queries
need happen to exist (`UserSession` carries `@@index([tenantId, revokedAt])`) —
but by hand, not because a guard demanded it. `no-direct-prisma.test.ts` keeps this
surface small, which is what makes the narrow denominator defensible.

### 8. `no-auto-join.test.ts` — `**/*.ts` under `src/`

Whole-`src` glob and a `tenantMembership.(create|upsert|createMany)` marker — a
good denominator. Two things it cannot see: **`.tsx` files** (the glob is
`**/*.ts`), so a server action inside a page component would be invisible — no
such site exists today, verified; and anything outside `src/`, where
`scripts/add-test-user.ts`, `scripts/add-tenant-owner.ts` and `prisma/seed.ts` do
create memberships. **Verdict: acceptable** — the docblock says "call sites in
`src/`", and the out-of-`src/` writers are not request-reachable. The `.tsx` gap is
latent and free to close whenever someone touches the file.

### 9. `admin-route-coverage.test.ts` — hand-kept list, partial sweep

`ADMIN_ONLY_ROUTES` is hand-kept, and the companion "no unlisted route file" sweep
walks only the `admin/` subtree — not the `billing/`, `sso/`, `security/` entries
the same list carries. A new `billing/` route would not be forced onto the list.
**Verdict: acceptable because `api-permission-coverage.test.ts` covers those roots
by glob** — but the two are not independent checks of each other, and the header
("Scans all admin-only API route files") reads as though the sweep were complete.

### 10. Documentation that overclaims

Not changed here — CLAUDE.md is shared and other lanes hold it this week — but both
of these describe guards that no longer work that way:

- The Epic D.2 section still documents `SANITISER_COVERAGE_FLOOR = 8`. The floor is
  gone; the guard's own header explains at length why it was removed.
- The Epic E.4 section instructs "define password schemas inline in the route file
  so the scan sees them". After finding 1 that is no longer required, and it was
  never true of `auth/register` anyway.

## A false alarm, and how it was caught

The first pass of finding 7's method reported "12 services and 5 jobs with no
importing test", including several security-relevant ones. The detector matched
`'@/app-layer/services/<name>'` — and much of `tests/unit` imports these modules by
relative path (`'../../src/app-layer/services/import-service'`). Re-running against
*any* import specifier gives the honest number: **2 services and 2 jobs**
(`cwe-mapping`, `vendor-doc-text`, `cloud-posture-collect`, `dsar-export`).

`src/app-layer/services/tenant-safety.ts::validateTenantSafety` — the cross-tenant
reference validator on the import path — was on the false list and is in fact
tested, via `tests/unit/tenant-safety-selfref.test.ts` importing `import-service`
relatively.

The audit's own sweep had the exact defect the audit is about, in the same shape:
a marker (`@/`) that most of the population carries, mistaken for the population.
Worth recording, because a false alarm here costs more than a missed one — it sends
someone hunting.

`usecase-test-coverage.test.ts::isImported` has the same `@/`-only marker. There it
errs safe (a relatively-imported usecase reads as untested and gets pushed onto the
exemption list rather than off it) — but it is why 8 of those 10 entries read as
plausible for so long.

## Files

| File | Role |
| --- | --- |
| `src/lib/db/rls-middleware.ts` | `PolicyAcknowledgementAssignment` added to `OWNERSHIP_CHAINED_MODELS` — finding 2. |
| `tests/guardrails/hibp-coverage.test.ts` | Structural scan resolves password-bearing shared schemas one hop — finding 1. |
| `tests/guardrails/usecase-test-coverage.test.ts` | Stale exemptions deleted, `BASELINE` 10→2, new stale-exemption test — finding 4. |
| `docs/implementation-notes/2026-08-21-what-our-sweeps-cannot-see.md` | This note. |

## Decisions

- **Three fixes, seven write-ups.** The brief allowed widening a denominator where
  it is small, safe and obviously right. Findings 3 and 5 are neither small nor
  obvious — `/api/org` needs an org-role permission model, and the 55 unencrypted
  free-text columns need product decisions about search — so they are recorded
  rather than half-closed. A partially-widened denominator is worse than a narrow
  one, because the number moves without the coverage moving.
- **The stale-exemption test reuses `isImported` rather than reimplementing it.**
  Two detectors for one question drift, and then the exemption list and the coverage
  list disagree about the same file with nobody the wiser.
- **`FrameworkMapping` was used as the mutation subject for finding 2 precisely
  because it is a genuine, documented no-RLS table.** It proves the denominator is
  live against a real database without needing to drop a policy on the shared test
  DB.
- **The shared-schema slice in finding 1 is deliberately coarse** (`export const X =`
  to the next `export`). Over-wide slices can only add names to the bearing set, and
  a name in the set only ever demands that an importing route be *registered* — the
  error direction is a false demand for review, never a silent pass.
