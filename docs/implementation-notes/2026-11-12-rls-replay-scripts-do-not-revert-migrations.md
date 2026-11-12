# 2026-11-12 — RLS replay scripts no longer revert security migrations

**Commit:** `cf7068c6f fix(rls): replay scripts no longer revert security migrations`

Closes #5241 and #5240, two `audit-2026-11` findings. Both were filed "not yet
reproduced: one auditor reported it… re-read the cited lines before fixing", and
both reproduce on live code. Follow-up filed as #5423.

## Design

`prisma/rls-setup.sql` and `prisma/rls-fix.sql` are operator tools, reached for
to REPAIR row-level security. Each describes itself as "fully IDEMPOTENT — safe
to re-run at any time", and every `CREATE POLICY` in them is preceded by a
`DROP POLICY IF EXISTS`. That last detail is the whole hazard: replaying one
does not ADD, it REPLACES whatever the migrations applied. A stanza left at an
older, weaker shape therefore reopens a hole at exactly the moment somebody is
trying to close one.

Two stanzas were stale.

`Control` in `rls-setup.sql` recreated the split pair that migration
`20260806120000_control_rls_single_asymmetric_policy` removed by name as a
leak — its own header documents that shape as "leaky for exactly this case".
`Control.tenantId` is nullable (`String?`), and a `FOR ALL` policy with no
`WITH CHECK` takes its `USING` clause as the check, so the pair let an
`app_user` session UPDATE the global (`tenantId NULL`) row that every tenant
reads, and null its own row's `tenantId` to publish it into every tenant's
library. The `FOR INSERT` sibling does not constrain UPDATE. This is the same
reasoning Epic D.1 records for `UserSession`.

`PolicyAcknowledgement` in `rls-fix.sql` recreated
`allow_all USING (true) WITH CHECK (true)` after dropping tenant isolation,
against the EXISTS-on-parent policy `20260422180000_enable_rls_coverage` gave
it — so a replay let any `app_user` session read every tenant's
acknowledgements and write against other tenants' policy versions. `rls-fix.sql`'s
own header records five sibling tables already corrected for precisely this
("which (because this file is 'safe to re-run') silently re-opened them to
cross-tenant access"); this one was missed. Same shape as the cadence bug in
#4672 — a fix that did not reach the sibling.

Both replaced with the canonical policies from the cited migrations, verbatim.

### Why nothing caught them

The two existing mechanisms each miss this by construction, and both say so:

- `tests/integration/rls-isolation.test.ts` reads `pg_policies` — the DATABASE,
  which holds what the migrations applied. A script that weakens things only
  WHEN REPLAYED is invisible to it.
- `tests/guardrails/rls-coverage.test.ts` does scan `rls-setup.sql`, but states
  its scope: "intentionally narrowed to the Epic O-1 organization layer …
  Tenant-layer drift between rls-setup.sql and the per-feature migrations is a
  known, separate housekeeping item". `Control` is tenant-layer.
- `rls-fix.sql` was referenced by no test at all.

So the new guard is a pure file scan over both scripts, every migration and the
Prisma schema, needing no Postgres — the half the DB-backed suite structurally
cannot cover.

## Files

| File | Role |
| --- | --- |
| `prisma/rls-setup.sql` | `Control` moved to the single asymmetric policy; the stale "deferred: need tenantId via migration" note for `PolicyAcknowledgement` corrected |
| `prisma/rls-fix.sql` | `PolicyAcknowledgement` re-asserts the migration's EXISTS policy plus `superuser_bypass` instead of `allow_all` |
| `tests/guards/rls-replay-scripts-do-not-weaken-migrations.test.ts` | The guard: no `allow_all` where a migration isolated, and the asymmetric policy wherever `tenantId` is nullable |

## Decisions

- **The guard's second rule is keyed on NULLABILITY, not on migration history.**
  The first draft asked "does the script keep the `WITH CHECK` the migration gave
  it", unioned over every migration. It flagged six tables, and five were FALSE:
  `20260423200000_denorm_tenantid_phase3_simplify_rls` and
  `20260521130000_promote_policy_approval_tenant` moved `PolicyApproval`,
  `EvidenceReview`, `FindingEvidence`, `AuditChecklistItem` and
  `AuditorPackAccess` to the split pair DELIBERATELY, after denormalising a real
  non-nullable `tenantId` onto each — where there is no NULL row to claim and no
  way to null the column, so the pair is safe. Unioning over history asks whether
  a table EVER carried a `WITH CHECK`, which is a different question from whether
  the script's shape is right. Nullability is the actual reason the asymmetric
  policy is mandatory, it states that reason at the assertion, and it cannot rot
  as migrations accumulate. A rule that flags five correct stanzas gets
  suppressed, not obeyed.

- **The migration-side check judges the LATEST definition only.** Migrations are
  append-only history: an older one legitimately creates a shape a later one
  fixes. Reading them as a set is what produced the five false positives above.

- **`tableName`, not the model name.** `parseSchemaModels()` resolves `@@map`,
  which is what an RLS policy actually names. Comparing against model names
  would silently skip any remapped table.

- **A denominator test, because every rule here is satisfied by an empty scan.**
  It asserts both scripts are non-trivial, >50 migrations parsed, >20 isolated
  tables, and a non-empty nullable population — plus the two subject tables
  asserted BY NAME, so neither can leave scope without a failure.

- **Shape, not semantics, and the docblock says so.** Two differently-worded
  `USING` clauses that mean different things both pass. Semantic equivalence
  needs a database, and that is `rls-isolation.test.ts`'s job. The guard also
  reads `CREATE POLICY` only, so a migration that DROPs without recreating is
  not represented.

- **The scripts' coverage gap was measured and filed separately (#5423) rather
  than fixed here.** The migrations give `tenant_isolation` to 220 tables; the
  two scripts between them cover 58, and the remaining 162 are not mentioned
  anywhere in either file — while `rls-setup.sql`'s header reads "All
  tenant-scoped tables use:". That is not a live hole (the scripts are wired to
  nothing; `prisma migrate` is the apply path) but it is a repair tool that
  silently under-repairs. Completing it, or retiring it, is a decision about
  whether a replay tool should exist at all, which is the owner's and not a
  side-effect of fixing two stanzas.
