# 2026-10-30 — Admin pages read the membership role the edge reads

**Commit:** see the PR for #4581 B

## Design

The edge's admin gate (`checkAdminAccess`) reads the role on the person's OWN
membership in the tenant the path names, and refuses every
`/api/t/:slug/admin/**` call from anybody who is not OWNER or ADMIN (bar the
AI_ADMIN agent paths and the AUDITOR inventory reads). The admin pages read
something else: the custom-role-aware `admin.view`, which a custom role can
grant on a Reader, Editor or Auditor membership. Such a member saw the gear and
the admin pages, and nearly every page then failed to load or save.

Owner decision (2026-10-30): the pages match the edge. One set,
`EDGE_ADMIN_ROLES`, now lives in an import-free module
(`src/lib/auth/edge-admin-roles.ts`) that `guard.ts` re-exports and the client
can hold. Three surfaces read it:

```
sidebar gear       perms.admin.view && membershipOpensAdminConsole(membershipRole)
admin layout       row admits  → page
                   else membership role not OWNER/ADMIN → forbidden
                   else RequirePermission(admin.view)
gateAdminPage      admitsAdminPage: keys + tier + membership role
                   (row's `roles`, default EDGE_ADMIN_ROLES; the audit log
                   adds AUDITOR)
```

The membership role travels as `membershipRole`: on `RequestContext` (set by
the session paths of `getTenantCtx` / `getLegacyCtx`), on
`TenantServerContext`, and on the client `TenantContextValue` the tenant layout
builds. `role` stays the EFFECTIVE role (a custom role's base), which is what
every coarse-tier check reads; nothing else changes meaning.

## Decisions

- **A new field rather than reusing `role`.** `role` is the custom role's base
  when there is one, and every `canAdmin` check depends on that. Changing it
  would move authority across the product; adding a field moves nothing.
- **Absent fails closed.** An API-key context has no membership, so it opens no
  admin page; a client context without the field shows no gear and no page.
  The tenant layout always sets it.
- **The audit log keeps AUDITOR.** Owner decision 2026-10-29. The page reads on
  the server and makes no admin API call, so the edge has nothing to refuse
  there; its row names `roles` explicitly.
- **The page gate reads the DB membership role, the edge reads the JWT.** They
  agree except for the moment between a role change and the JWT's refresh, and
  the server's answer is the authoritative one.
