# 2026-10-29 — Incidents page: write gating, the capped register, and a real detection time (#4463)

**Commit:** the `claude/fix-incidents-page` series, `Refs #4463`.

## Design

```
Register (IncidentsClient)
  page.tsx ── listIncidents(take: SSR_PAGE_LIMIT) + listIncidentKpiCounts ──▶ first paint
  SWR GET /incidents ── listIncidents(take: LIST_BACKFILL_CAP + 1)
                     ── applyBackfillCap ─▶ { rows, truncated }
                     ── IncidentRepository.kpiCounts ─▶ kpiCounts (4 counts, whole tenant)
  client ── unwrapCappedList(rows) ─ filter in memory ─ TruncationBanner(truncated)
         ── KPI cards + header count from kpiCounts (rows only as a fallback)

Open incident (NewIncidentModal)
  DatePicker (day, UTC-midnight Y/M/D) + <Input type="time"> (HH:MM, local)
     └─ combineDetectedAt ─▶ one local instant ─ isDetectedAtInFuture(now) ─▶ refuse at the field
  POST detectedAt (ISO) ─▶ createIncident
     └─ isDetectedAtInFuture(now, 5 min) ─▶ 400 · assertOwnerInTenant ─▶ 400 · write

Incident page
  every write control  ⇐ appPermissions.incidents.manage   (the route's one key)
  refused write        ⇒ apiErrorMessage(body, "Action failed")
```

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx` | Write controls gated on `incidents.manage`; server reason on failure; read-only containment-step state; capped evidence picker; deadline-state labels |
| `src/app/t/[tenantSlug]/(app)/incidents/IncidentsClient.tsx` | Filtered empty state; capped envelope + banner; server KPI counts; "24h · Overdue" badge |
| `src/app/t/[tenantSlug]/(app)/incidents/NewIncidentModal.tsx` | Date + time "Detected at"; field-level title/description bounds; server reason |
| `src/app/t/[tenantSlug]/(app)/incidents/page.tsx` | SSR first page + KPI counts |
| `src/app/api/t/[tenantSlug]/incidents/route.ts` | PR-5 backfill cap, row-count metric, `kpiCounts` |
| `src/app-layer/repositories/IncidentRepository.ts` | `kpiCounts` |
| `src/app-layer/usecases/incident.ts` | `listIncidentKpiCounts`; future detection refused; owner membership on create/update; labelled timeline text |
| `src/app-layer/usecases/compliance-calendar/loaders-reminder-backed.ts` | Labelled notification titles |
| `src/lib/incidents/detected-at.ts` | Pure day + time → instant helpers, the skew allowance |
| `src/lib/incidents/labels.ts` | English labels for server-written text, held equal to `en.json` |

## Decisions

- **The UI gate is the granular key alone.** Every incident write route is
  `requirePermission('incidents.manage')` and the usecase asserts only
  `appPermissions.incidents.manage`; there is no coarse tier on these paths, so
  adding one in the UI would hide controls from a custom role the server
  admits. Built-in roles see what they always could use: OWNER and ADMIN.
- **A read-only checklist still shows state.** Hiding the containment
  checkboxes for a viewer would also hide which steps are done, so a viewer gets
  an icon plus a screen-reader label instead of a box they cannot tick.
- **The register follows the PR-5 shape, KPI counts the vendors shape.** The
  cap moved from the repository's silent 200 to `LIST_BACKFILL_CAP` with the
  cap + 1 sentinel; the KPI cards are aggregates, not counts of `rows`, so they
  stay right above the cap. Filtering stays client-side over the loaded rows,
  which the banner discloses. The GET response changes from a bare array to the
  envelope, as every other capped list route did before it.
- **Detection time is two fields, not a new primitive.** No date-time primitive
  exists and the platform `DatePicker` is day-level by design. Epic 58 bans
  `type="date"` / `datetime-local`, not `type="time"`, so the form pairs the
  picker with the shared `<Input type="time">`. The time is the person's own
  time zone, which the field names, and the full instant is stored.
- **Five minutes of skew before "future" is refused on the server.** The form
  defaults to the device's "now"; a device clock running a little fast must
  not have its own default refused. The client checks against its own clock
  with no allowance. Five minutes cannot move an Article 23 deadline in a way
  that matters.
- **Labels, not translations, in stored text.** Timeline entries and calendar
  titles are server-written English, like every other system timeline entry
  and calendar title, so they carry the English UI labels from one module. A
  test holds them equal to `messages/en.json`. Existing entries are not
  rewritten, and audit-log details keep the codes.
