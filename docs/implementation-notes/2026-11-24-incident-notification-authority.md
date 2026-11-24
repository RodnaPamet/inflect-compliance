# 2026-11-24 — Incident notification authority: a writer, a reader, and no dead link

## Design

`TenantSecuritySettings.incidentAuthority` (the NIS2 Article 23 CSIRT or
competent authority a workspace notifies) existed only in the schema. Its doc
comment promised the incident view would show it as "notify: <authority>", but
nothing in `src/` read or wrote it, and the incident page's "Notification
authority" section linked `/t/<slug>/admin/settings`, a route that never had a
page.

```
admin/security page ── IncidentAuthorityCard (#incident-authority)
        │  PUT /admin/security-settings { incidentAuthority }   (admin.manage)
        ▼
updateTenantSecurityConfig ── sanitizePlainText, collapse whitespace, trim,
        │                     empty → null, ≤ 200 chars
        │                     INCIDENT_AUTHORITY_CHANGED (before/after)
        ▼
TenantSecuritySettings.incidentAuthority
        │  read inside getIncident (incidents.view)
        ▼
GET /incidents/:id → notifyAuthority ── incident page: "Notify: <authority>"
                                         + link to /admin/security#incident-authority
                                           for a viewer offered the write
```

- **Writer.** The existing patch-shaped `PUT admin/security-settings` and
  `updateTenantSecurityConfig`, as `apiKeyRotationDays` (#3708) did: one more
  nullable column on the row this route already owns, so no second writer.
- **Reader.** `getIncident` reads the one column in its own transaction and
  returns it as `notifyAuthority`. The settings route is `admin.manage`-only,
  and every incident reader needs to know whom to notify.
- **Link.** Shown only where `useOffersAdminApiWrite({ key: 'admin.manage' })`
  says the server would take the write (the edge's admin roles and the key).
  Anybody else is told "An administrator names it…" when none is named, and
  sees just the authority when one is.
- **Anchor.** The card renders its frame, with `id="incident-authority"`, from
  the first paint, and scrolls itself into view once its value loads when the
  URL's fragment names it: the browser's own fragment jump happens before a
  client-loaded card has content. It sits above the cards that render only once
  loaded, so nothing above it shifts after the scroll.

## Other dead links, and the guard

A sweep of every literal `` `/t/${…}/…` `` path in `src/` against the tenant
pages found four more 404s, all fixed:

| Link | Was | Now |
| --- | --- | --- |
| Search hit for a test plan | `/controls/<id>/tests` | `/controls/<id>/tests/<planId>` |
| Org portfolio overdue-evidence drill-down (two sites) | `/evidence/<id>` | `/evidence?ev=<id>` (opens the detail sheet) |
| BIA detail, linked process | `/processes/<mapId>` | `/processes?activeId=<mapId>` |
| Calendar connect callback | `/account/calendar` | `/calendar` |

`tests/guards/tenant-page-links-resolve.test.ts` holds it: every literal tenant
path must match a `page.tsx` under `src/app/t/[tenantSlug]` segment by segment,
an interpolated segment matching only a dynamic one. Both populations come from
git (`repoFiles`). Paths it cannot judge from text (a computed first segment, a
part-interpolated segment, the bare tenant root) are counted, and the count is
capped.

## Files

| File | Role |
| --- | --- |
| `src/lib/incidents/authority.ts` | Length bound and anchor, shared by client and server |
| `src/app-layer/usecases/tenant-security-settings.ts` | Normalise, write and audit `incidentAuthority` |
| `src/app-layer/schemas/tenant-security-settings.schemas.ts` | The PUT's field |
| `src/app-layer/usecases/incident.ts` | `getIncident` returns `notifyAuthority` |
| `src/app/t/[tenantSlug]/(app)/admin/security/IncidentAuthorityCard.tsx` | The setting |
| `src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx` | Shows it; link or "ask an administrator" |
| `tests/guards/tenant-page-links-resolve.test.ts` | Literal tenant paths resolve to a page |

## Decisions

- **No schema change.** The column existed; it is not in the encryption
  manifest and is not added: an authority's name is public.
- **The change event carries both values.** `SECURITY_SETTINGS_UPDATED` records
  field names only; "whom were incident commanders told to notify, and since
  when" needs the values, and neither is sensitive.
- **Normalised before the bound.** Markup is stripped and whitespace collapsed
  first, so the 200-character limit is on what is stored and shown. An input
  that is empty after that clears the setting rather than storing "".
- **The calendar callback lands on `/calendar`.** No page or control starts the
  per-user calendar connect today, so there is no settings page to return to;
  the calendar is the nearest real page, and the `?calendar=` result rides
  along for when one reads it.
