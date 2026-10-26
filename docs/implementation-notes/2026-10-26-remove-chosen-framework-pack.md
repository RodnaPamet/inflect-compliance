# 2026-10-26 — a workspace removes a framework pack it chose

**Commit:** `feat(frameworks): a workspace can take a chosen pack back out of a framework's scope`

## Design

Since #4364 the pack install records each installed pack in
`TenantFrameworkPack`, and a multi-pack framework's coverage, readiness and
tree count only the recorded packs' requirements. Nothing removed a record, so
a scope could only widen (#4372).

```
Packs tab ─ Remove pack ─▶ undo toast (5 s) ─▶ POST ?action=remove-pack { packKey }
                                                 └─ removeChosenPack(ctx, frameworkKey, packKey)
                                                      assertCanInstallFrameworkPack
                                                      pack of THIS framework, else 404
                                                      runInTenantContext:
                                                        pg_advisory_xact_lock('framework-pack-scope:<tenant>:<framework>')
                                                        no record        → 409 PACK_NOT_CHOSEN
                                                        count ≤ 1        → 409 LAST_CHOSEN_PACK
                                                        delete record; audit FRAMEWORK_PACK_REMOVED
```

`listFrameworkPacks` returns `chosen` per pack, read from the workspace's own
records, and the Packs tab marks and offers removal only on chosen packs of a
framework with more than one pack.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/framework/install.ts` | `removeChosenPack`: gate, refusals, lock, delete, audit |
| `src/app-layer/usecases/framework/catalog.ts` | `listFrameworkPacks` adds `chosen` |
| `src/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts` | `POST ?action=remove-pack` |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page.tsx` | Chosen badge, Remove pack, undo toast, scope refresh |

## Decisions

- **Only the record is removed.** A control the pack installed may serve
  another pack (the EU drone core is shared by all of them) or another
  framework's mapping, and deleting it would discard tasks and evidence links.
  Archiving a control stays its own act.
- **The last chosen pack is refused.** With no record, `pack-scope.ts` falls
  back to counting every requirement, so removing the last pack would widen
  the scope, the opposite of removal. Install asks for at least one pack for
  the same reason. The page shows the button disabled with the reason; the
  server refuses anyway.
- **One advisory lock per (workspace, framework).** The count and the delete
  are a read then a write. Without the lock two removals racing could each see
  two packs and leave none. Install only adds records, so it does not need the
  lock.
- **Same gate as install** (`frameworks.install`): deciding what the workspace
  has taken on is one act, whichever direction it goes.
- **A POST action, not a DELETE route**, matching the framework route's
  existing action dispatch and the undo-toast sites that send their write when
  the window closes.
