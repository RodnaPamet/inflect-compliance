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

`upsertRequirements` (`?action=upsert-requirements`) rewrites the GLOBAL
`FrameworkRequirement` rows every tenant reads, so it moved to a second policy,
`assertCanEditFrameworkCatalogue`: the install key AND the old OWNER/ADMIN
role line. A tenant's custom role can narrow it, never widen it.

The entry points now follow the same key: **Import framework** (the server page
passes `canInstall` from the request context), the install wizard's steps (a
notice says who can install instead), and the template library's Install
buttons, tick boxes and Select All.

## Who this changes

| Principal | Install verbs above | `upsertRequirements` |
| --- | --- | --- |
| OWNER, ADMIN | allowed (unchanged) | allowed (unchanged) |
| EDITOR, AUDITOR, READER, AI_ADMIN | refused (unchanged) | refused (unchanged) |
| Custom role, ADMIN or OWNER base, `frameworks.install: false` | **now refused** (was allowed) | **now refused** (was allowed) |
| Custom role, EDITOR / AUDITOR / READER base, `frameworks.install: true` | **now allowed** (was refused) | refused (unchanged) |
| API key with `*` | allowed (unchanged) | allowed (unchanged) |
| API key with `admin:write`, no `frameworks:write` | **now refused** (role ADMIN, no install flag) | **now refused** |
| API key with `frameworks:write`, no `admin:write` | **now allowed** (role EDITOR, install flag set) | refused (unchanged) |

## Files

| File | Role |
| --- | --- |
| `src/app-layer/policies/framework.policies.ts` | Granular install gate; new catalogue gate |
| `src/app-layer/usecases/framework/fixtures.ts` | `upsertRequirements` uses the catalogue gate |
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
  only gate, as before. Adding one to the shared POST would also gate the
  catalogue action under a different rule than its usecase.
- **The catalogue write keeps the role line.** Reading only the install key
  there would hand an EDITOR-based custom role the power to edit the shared
  catalogue for every tenant. That an ADMIN of any one tenant can still do so is
  a pre-existing question this change does not answer.
