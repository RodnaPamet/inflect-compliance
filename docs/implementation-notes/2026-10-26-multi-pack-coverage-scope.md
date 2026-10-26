# 2026-10-26 — coverage of a multi-pack framework counts only the chosen packs

**Commit:** `feat(frameworks): coverage of a multi-pack framework counts only the packs a workspace chose`

## Design

EU drone operations (#4311) has eight packs, one per operating subcategory
plus the class C2 pack (#4350), and install requires choosing at least one.
Nothing recorded the choice. Coverage divided by all 51 requirements, so a
workspace that flies only in A2 saw the specific-category and LUC sections as
unmapped gaps it never took on.

```
install (installPacksInTenant)
   ├─ controls, tasks, requirement links          (as before)
   ├─ TenantFrameworkPack upsert (tenant, pack)   ← NEW: the choice
   └─ FRAMEWORK_PACK_INSTALLED audit row          (as before)

pack-scope.ts  resolveRequirementScope(tdb, tenantId, frameworkId)
   packs on framework < 2           → ALL
   no TenantFrameworkPack rows      → ALL
   otherwise                        → CHOSEN_PACKS: codes cited by the
                                      chosen packs' templates (this framework only)

readers:  computeCoverage · generateReadinessReport · computeGenericReadiness
          (audit cycles) · getFrameworkTree
```

Each reader resolves the scope inside the same `runInTenantContext`
transaction as its links read. It partitions the active requirements into
in-scope and out-of-scope, and computes everything it did before over the
in-scope set. Coverage and the readiness report add `scope`,
`outOfScope` / `outOfScopeRequirements`, and CSV rows labelled
`Not in chosen packs`. The tree keeps every node, and marks out-of-scope
requirements `na` with `outOfScope: true`. The explorer labels them
"Out of scope", and the Coverage tab lists them under "Outside your chosen
packs".

The migration backfills the table from the audit trail, joining
`metadataJson->>'packKey'` to `FrameworkPack.key`, so a workspace that
installed packs before this change keeps its choice. The insert is
idempotent (deterministic id, `ON CONFLICT DO NOTHING`).
`tests/integration/framework-pack-scope.test.ts` replays that exact
statement.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/frameworks.prisma`, `auth.prisma` | `TenantFrameworkPack` model and back-relations |
| `prisma/migrations/20261026120000_tenant_framework_pack/` | Table, indexes, FKs, audit-trail backfill, Class-A RLS |
| `src/app-layer/usecases/framework/pack-scope.ts` | The one scope rule: resolve, partition, summarise |
| `src/app-layer/usecases/framework/install.ts` | Records each installed pack in the install transaction |
| `src/app-layer/usecases/framework/coverage.ts` | Coverage and readiness report scoped; out-of-scope listed and exported |
| `src/app-layer/usecases/audit-readiness/scoring.ts` | Generic (non-ISO, non-NIS2) cycle readiness scoped the same way |
| `src/app-layer/usecases/framework/tree.ts`, `src/lib/framework-tree/*` | Tree marks out-of-scope requirements `na` + `outOfScope` |
| `src/components/frameworks/FrameworkExplorer.tsx`, framework detail `page.tsx` | "Out of scope" label, detail note, out-of-scope figure and list |

## Decisions

- **The choice is recorded, not inferred.** Inferring scope from which
  controls exist would treat a deleted control as a narrowed choice, and a
  hand-installed template as a widened one. The install is the act that
  states the choice, so it writes the row. Nothing removes a row: no pack
  uninstall exists, and a later install only widens the scope.
- **Narrowed only for a framework with more than one pack.** A single pack
  may leave requirements uncovered on purpose, and those are real gaps. Today
  that means only EU drone operations is ever narrowed, and every other
  framework's figures are unchanged (each fixture defines exactly one pack).
- **A workspace with no row is not narrowed.** That keeps a framework
  adopted only through hand-mapped controls, or through the template library,
  counted as before.
- **Membership is by requirement code**, which stays meaningful across the
  two-representation split (`framework-representation-aliases.ts`). Template
  links to another framework's requirements are ignored.
- **Out-of-scope requirements stay visible.** The owner chose this: listing
  them apart keeps them from silently disappearing, while keeping them out of
  every count and percentage keeps them from reading as gaps.
- **ISO 27001 and NIS2 cycle scorers are untouched.** Each is a single-pack
  framework, so the scope would always be ALL there.
- **Additive migration.** Rolling back the code leaves the table unread and
  harmless. Rolling back the migration is a `DROP TABLE` that loses only the
  recorded choices, which the backfill can rebuild from the audit trail.
