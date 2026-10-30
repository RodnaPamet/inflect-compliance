# 2026-10-30 — Admin pages ask the edge

**Commit:** `feat(admin): the custom roles, members and integrations pages offer only what the server takes`

## Design

An admin-API write passes three gates: the edge (`checkAdminAccess`, by the
membership's BUILT-IN role), the route's `requirePermission` key (custom-role
aware), and the usecase's floor (`assertCanAdmin` reads the coarse tier of a
custom role's BASE). #4471 made the agent register ask all three through the
server's own functions. This change generalises that and applies it to the
Custom roles and Integrations pages, and teaches the Members page and the
Custom roles form the owner's carriage rule of the same day.

```
tenant layout (server) ── edgeAdmitsAdminApi(slug, session.user) ──▶ TenantContext.edgeAdmitsAdminApi
                                       │ checkAdminAccess
client page ── useOffersAdminApiWrite({ key, floor }) ── offersAdminApiWrite(viewer, gate)
agent pages (server) ── agentRegisterAffordances ─────────┘
```

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/admin-api-affordances.ts` | `offersAdminApiWrite`: edge ∧ key ∧ floor. Pure and client-safe |
| `src/lib/auth/admin-api-edge.ts` | `edgeAdmitsAdminApi`: the edge's own answer, server-side (`guard.ts` imports `next/server`) |
| `src/lib/agentic/agent-register-affordances.ts` | Now the agent register's use of the two, not a copy |
| `src/lib/tenant-context-provider.tsx`, `src/app/t/[tenantSlug]/layout.tsx` | The verdict travels to client pages (`edgeAdmitsAdminApi`) |
| `src/lib/auth/use-offers-admin-api-write.ts` | `useOffersAdminApiWrite`, the client pages' hook over the verdict |
| `src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx` | Writes offered by the gates; the carriage locks; refusals in labels |
| `src/app/t/[tenantSlug]/(app)/admin/members/page.tsx` | The custom-role picker asks `customRoleCarriageRefusal` |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx`, `SharePointCard.tsx` | Configure (canAdmin) and operate (key only) offered separately |
| `src/app-layer/usecases/custom-roles.ts` | `listCustomRoles` reports `nonAdminCarriers` per role |

## Decisions

- **The edge verdict is computed once, in the tenant layout.** The three
  pages are client components, the app mounts no `SessionProvider`, and the
  edge module cannot be bundled for the browser. One boolean answers for every
  admin path outside the agent subtree and the auditor's inventory reads; a
  unit test holds it equal to `checkAdminAccess` on the roles and integrations
  APIs for every role, so an edge change that splits them fails there.
- **The hook is its own module, not the provider's.** Every tenant page loads
  the tenant context provider, so whatever it imports at runtime ships in every
  route's First Load JS. With the hook there, `admin-api-affordances` and
  `permission-key` did: every route grew by 2 to 4 KB and the test-plan page
  went over its budget (671.7 KB against 668). The provider carries only the
  `edgeAdmitsAdminApi` field; the hook imports the provider, never the reverse,
  so only the pages that call it carry the affordance code.
- **An absent verdict is read as admitted.** A provider built without it (a
  test) keeps every control; the layout always asks, and the server is the
  authority either way. Failing closed would have hidden controls in every
  rendered test of every admin page for no protection.
- **Integrations splits configure from operate.** Listing, testing and syncing
  check the key alone; saving, enabling, disabling, removing and authorizing
  also take `canAdmin`. An Admin membership on a Reader-based custom role that
  grants Manage keeps the first three, as the server gives them.
- **The roles form locks against the role as STORED**, because the server
  refuses only what a save adds: a key the role already grants stays
  switchable (off, and on again), and the Admin base stays choosable for a role
  already built on it. The count comes from the server (`nonAdminCarriers`,
  one `groupBy`), not from the members list, which the roles page does not load.
- **A cell's hint names one reason, in a fixed order.** The roles grid has
  three locks besides the editor's own permissions: the Admin-base rule (#4536,
  generalised by #4595 to `ADMIN_BASE_ONLY_PERMISSIONS`: `admin.manage`,
  `admin.members`, `admin.owner_management`, `admin.tenant_lifecycle`,
  `personnel.manage`) on a base other than Admin, and this page's carrier locks
  (the ten keys, and the Admin base). The two key lists are disjoint, so the
  order only has to decide against "not held": not held comes first, because no
  other change on the page lets the editor give it; then the base rule; then
  the carrier rule. The cells the two role rules meet on, the five
  Admin-base-only cells on a role non-Admins carry, get their own hint
  (`roles.cellNeedsAdminBaseCarried`), because "needs an Admin base" alone would
  send the editor to a base they cannot pick. Presets start
  inside all three rules, Save is held for any of them, and a refusal is re-said
  in the server's order: grant, personnel, carriage.
- **The members picker offers a refused custom role disabled, with the
  reason**, rather than hiding it: a role that disappears from a list reads as
  deleted. The same predicate decides the note that holds Save when a role
  change would leave an Admin's custom role on another role.
