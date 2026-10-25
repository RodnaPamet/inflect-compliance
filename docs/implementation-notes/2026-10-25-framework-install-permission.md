# 2026-10-25 — framework installs read the install permission

**Issue:** #4125

## Design

Every framework install button is gated on the custom-role-aware
`frameworks.install` permission (`<RequirePermission resource="frameworks"
action="install">`). The server gate, `assertCanInstallFrameworkPack`, read
`ctx.role` for OWNER/ADMIN instead. For a member with a custom role, `ctx.role`
is the membership's BUILT-IN role, so the two disagreed in both directions.

The policy now reads `ctx.appPermissions.frameworks.install`. It guards every
tenant-scoped framework write:

```
installPack                  POST frameworks/{key}                  (Install Pack, setup wizard)
installSingleTemplate        POST frameworks/{key}?action=install-template
bulkInstallTemplates         POST frameworks/{key}?action=bulk-install
bulkMapControls              POST frameworks/{key}?action=bulk-map
reorderFrameworkRequirements POST frameworks/{key}/reorder           (Builder tab)
```

`upsertRequirements` (`?action=upsert-requirements`) is **removed** (owner
decision). It rewrote, added and retired the GLOBAL `FrameworkRequirement` rows
every tenant reads, so any one tenant's OWNER or ADMIN could change every other
tenant's frameworks, with no audit row; and no screen called it. The catalogue
is kept by the deploy-time scripts (`scripts/seed-framework-catalogs.ts`,
`scripts/framework-import.ts`). A request naming the action now falls through
to the default branch like any unknown action, whose body schema refuses it.

The entry points now follow the same key: **Import framework** (the server page
passes `canInstall` from the request context), the install wizard's steps (a
notice says who can install instead), and the template library's Install
buttons, tick boxes and Select All.

## Who this changes

| Principal | Install verbs above |
| --- | --- |
| OWNER, ADMIN | allowed (unchanged) |
| EDITOR, AUDITOR, READER, AI_ADMIN | refused (unchanged) |
| Custom role, ADMIN or OWNER base, `frameworks.install: false` | **now refused** (was allowed) |
| Custom role, EDITOR / AUDITOR / READER base, `frameworks.install: true` | **now allowed** (was refused) |
| API key with `*` | allowed (unchanged) |
| API key with `admin:write`, no `frameworks:write` | **now refused** (role ADMIN, no install flag) |
| API key with `frameworks:write`, no `admin:write` | **now allowed** (role EDITOR, install flag set) |

Nobody can rewrite the requirement catalogue any more: OWNER and ADMIN lose the
removed action.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/policies/framework.policies.ts` | Granular install gate |
| `src/app-layer/usecases/framework/fixtures.ts` | `upsertRequirements` removed; the read-only diff stays |
| `src/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts` | `?action=upsert-requirements` removed |
| `src/app/t/[tenantSlug]/(app)/frameworks/page.tsx` + `FrameworksClient.tsx` | `canInstall` hides Import framework |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/install/page.tsx` | Notice instead of the steps |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page.tsx` | Install controls gated; errors shown |

## Decisions

- **One policy, not one per verb.** The Builder tab and both template installs
  were already gated on `frameworks.install` in the UI, and all five verbs are
  tenant-scoped writes of the same kind. Splitting them would recreate the
  button/server disagreement one verb at a time.
- **No route-level `requirePermission`.** The frameworks routes are not in
  `PRIVILEGED_ROOTS` and have no `route-permissions.ts` rule; the usecase is the
  only gate, as before.
- **Remove the catalogue write rather than gate it.** A tenant-scoped route is
  the wrong place for a write whose effect is every tenant's: no role inside one
  workspace should hold it. Moving it to the platform-admin API was the
  alternative; with no caller and a deploy-time path already in place, the owner
  chose removal.
