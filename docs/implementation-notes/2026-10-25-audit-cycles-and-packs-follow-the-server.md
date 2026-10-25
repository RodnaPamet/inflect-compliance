# 2026-10-25 — Audit cycles and packs: the page follows the server

**Commit:** `fix(audits): the cycle and pack pages offer what the server allows, and packs work for every framework` (#4129)

## Design

The audit-readiness policies gate on the built-in role (`ctx.role`); the pages
gated on two permission keys that hold different populations. `audits.manage`
is OWNER + ADMIN, so an Editor was offered none of the cycle, pack and clone
actions the server lets Editors take; `audits.share` is also held by AUDITOR,
so an Auditor was offered share, resolve and create-finding buttons that every
request refused. The owner's decision: the page follows the server, and server
access is not widened.

```
src/lib/audit-readiness/access.ts           role sets + auditReadinessAccess(viewer)
   ▲                         ▲
   │ ROLES.includes(ctx.role) │ useAuditReadinessAccess()  (audits/_lib)
audit-readiness.policies.ts  cycles, cycle detail, pack detail, auditors pages
```

The role sets live in one client-safe module. The policies read them with
`.includes(ctx.role)` in the `if` itself, and the pages read
`auditReadinessAccess({ role, appPermissions })`, which also folds in the route
keys the reliance pack (`audits.manage` + `admin.manage`) and the auditor-grant
routes (`admin.manage`) add on top of the role.

Four behaviours change on the server:

- **A cycle needs a framework in use.** `createAuditCycle` used to look the key
  up in the global catalogue. It now asks `isFrameworkInUse` — a live control
  mapped to one of the framework's live requirements, through every
  representation of it — which is the Frameworks page's `computeCoverage(...)
  .mapped > 0` asked with one `findFirst`. `GET /frameworks?inUse=true`
  (`listFrameworksInUse`) feeds the cycle form's picker.
- **Every framework has a default pack.** `previewDefaultPack` refused anything
  but ISO27001 and NIS2. The selection was already framework-neutral; only the
  policy keyword bias is per framework, and a framework with no keyword list
  takes every published policy.
- **A draft pack's item can be removed** — `removeAuditPackItem`,
  `POST /audits/packs/:id?action=remove-item`, the same writers as adding,
  audited as `AUDIT_PACK_ITEM_REMOVED`, refused on a frozen pack.
- **The freeze attaches the Statement of Applicability for real**, and
  snapshots hand-added items like any other.

## Files

| File | Role |
| --- | --- |
| `src/lib/audit-readiness/access.ts` | The role sets and the page-side access object |
| `src/app-layer/policies/audit-readiness.policies.ts` | Reads the role sets |
| `src/app-layer/usecases/framework/coverage.ts` | `isFrameworkInUse`, `listFrameworksInUse` |
| `src/app/api/t/[tenantSlug]/frameworks/route.ts` | `?inUse=true` |
| `src/app-layer/usecases/audit-readiness/cycles.ts` | The in-use refusal |
| `src/app-layer/usecases/audit-readiness/packs.ts` | Item names on read, snapshot rule, removal, SoA, default pack for any framework |
| `src/app-layer/usecases/audit-readiness/sharing.ts` | `attachedToAudit` on a materialised finding |
| `src/app-layer/usecases/agent-audit-reliance.ts` | Freezes without an SoA |
| `src/app/t/[tenantSlug]/(app)/audits/**` | Gates, error envelopes, 404s, labels, removal with undo |

## Decisions

- **The SoA is a `FRAMEWORK_COVERAGE` item, not a new enum value.** The freeze
  inserted `EXPORT_ARTIFACT`, which `AuditPackItemEntityType` has never had,
  inside a `catch {}`, so it failed on every freeze unseen. Adding the value is
  a two-deploy migration (a container whose client predates a value fails every
  read of a row carrying it). An SoA is the framework's coverage, requirement by
  requirement, so the existing value is honest; `type: 'SOA_REPORT'` in the
  snapshot tells it from the reliance pack's summary, and the pages name it in
  words. It is upserted on the item's unique key, so a clone that carries the
  old SoA forward gets it refreshed, and it is the CYCLE's framework's SoA, only
  for a framework that has one. A failure is now logged.
- **The reliance pack freezes without an SoA.** Every item there is its
  planner's decision, and the SoA attach had never once succeeded, so this keeps
  reliance packs exactly as they have always been.
- **A row-backed item's snapshot is the server's.** `addAuditPackItems` ignores a
  caller's `snapshotJson` for CONTROL / POLICY / EVIDENCE / ISSUE: the page sent
  `{ title }`, the freeze kept any non-empty snapshot, and the item froze with
  its title alone — and a caller could put any content in front of the auditor
  under a real control's id. The freeze also rebuilds such an item whose
  snapshot lacks the `snapshotAt` every server builder stamps, which covers
  drafts made before this change. Computed artefacts keep theirs.
- **Draft items are named on read** (`displayName` from `getAuditPack`), the
  same field a frozen snapshot is read by, so a row reads the same either side
  of the freeze.
- **Removal re-asserts DRAFT under the pack's row lock** with a predicated
  `updateMany`, the interlock `storeExportArtifact` uses, and the page takes the
  Epic 67 undo window.
- **`isFrameworkInUse` asserts no permission of its own.** `createAuditCycle`
  must keep refusing on the cycle writer's role alone; asserting
  `frameworks.view` there would have refused a custom role nobody decided to
  refuse.
- **A 404 is latched on the detail pages.** The API answers a missing cycle or
  pack with `notFound`, which `apiGet` throws, so "not found" was unreachable;
  the latch keeps a later failed revalidation from turning it into a retry
  screen.
- **A list a role cannot read is not asked for.** The share-link list and the
  auditor list are fetched only by Owners and Admins, and everyone else is told
  why there is nothing, instead of reading a refusal as an empty list.
