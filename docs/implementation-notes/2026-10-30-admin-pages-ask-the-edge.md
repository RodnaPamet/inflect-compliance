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
| `src/lib/tenant-context-provider.tsx`, `src/app/t/[tenantSlug]/layout.tsx` | The verdict travels to client pages; `useOffersAdminApiWrite` |
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
- **The members picker offers a refused custom role disabled, with the
  reason**, rather than hiding it: a role that disappears from a list reads as
  deleted. The same predicate decides the note that holds Save when a role
  change would leave an Admin's custom role on another role.
