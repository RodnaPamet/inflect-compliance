# 2026-11-25 — Calendar push writer (epic #5937, step 2)

**Commit:** `feat(calendar): push a person's own deadlines to Google and Outlook (step 2 of #5937)`

## Design

Step 1 left every piece of the push in place except the one that writes: the
generation (`generatePushableEvents`), the reconciler, the sweep and the
consent-health guard all existed with no production caller, and
`calendar-push-tenant` enumerated connections and wrote nothing. Step 2 adds the
two provider writers, a database-backed mapping store, and the wiring, per
`docs/calendar-push-design.md`.

```
calendar-push-tenant (per workspace, people sequentially)
  locale = Tenant.defaultLocale            (runInTenantJobContext, source 'calendar-push')
  for each live connection:
    runUserPushGuarded ── IntegrationAuthError → revoke once; RateLimited → throttled; else failed
      pushOneConnection
        readCalendarConnectionForPush  → token (v2, DEK resolves), disconnectRequestedAt, Entra directory
        writer = Google | Graph        (calendar-http: resilientFetch, 401 → refresh once)
        disconnecting? → removeAllPushedEvents → revoke when done or after 7 days
        else sweepUserCalendar
               generate: aggregation(ownedBy = person, locale) from start of UTC day, 90 days
               reconcile (deletes held for failed/capped sources)
               apply ≤ 50 actions, removals first
        stamp lastPushedAt

DELETE /calendar/connections → disconnectCalendar
  remove ≤ 25 pushed events → all gone: revoke token, Google revoke → 204
                            → otherwise: disconnectRequestedAt, token kept → 202
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/calendar/calendar-http.ts` | Shared seam: resilient fetch with a small budget, 401 refresh-once, all-day span, re-creation id |
| `src/app-layer/integrations/providers/calendar/google-writer.ts` | Google Calendar v3 writer; quota 403 → throttle |
| `src/app-layer/integrations/providers/calendar/graph-writer.ts` | Graph v1.0 writer; `transactionId`, immutable ids, duplicate lookup by marker |
| `src/app-layer/integrations/providers/calendar/token.ts` | `revokeGoogleCalendarToken` |
| `src/app-layer/usecases/calendar-mapping-store.ts` | Prisma `MappingStore`, one transaction per call |
| `src/app-layer/usecases/calendar-push-person.ts` | One connection's nightly run, the disconnect retry, the disconnect |
| `src/app-layer/usecases/calendar-reconcile-sweep.ts` | Per-person action cap, removals first, re-created id recorded, `removeAllPushedEvents` |
| `src/app-layer/usecases/calendar-event-reconcile.ts` | `holdDeletes` |
| `src/app-layer/usecases/calendar-push-generate.ts` | Own deadlines, locale, link line, start-of-day window, `failedSources`, keys on event type |
| `src/app-layer/usecases/compliance-calendar/index.ts` | `ownedBy` and `locale` inputs; `calendarSourceTypes` |
| `src/app-layer/usecases/user-calendar-connection.ts` | Push-path reads and writes under a non-bypass job context; disconnecting state; `undeletedEventCount` |
| `src/app-layer/usecases/calendar-consent-health.ts` | Takes a principal rather than a `RequestContext`; job-path revoke |
| `src/app-layer/jobs/calendar-push.ts` | The wiring |
| `src/app/api/t/[tenantSlug]/calendar/connections/route.ts` | DELETE through `disconnectCalendar` (204 / 202) |
| `prisma/migrations/20261125120000_calendar_connection_disconnecting/` | `UserCalendarConnection.disconnectRequestedAt` |
| `messages/{en,bg}.json` | `workspaceText.calendarPush` |
| `docs/calendar-push-design.md`, `docs/sub-processors.md` | What step 2 ships; the `calendar` row says what is written |

## Decisions

- **Owner decisions of 2026-11-25 applied, not re-opened.** Only the person's
  own deadlines (owner or assignee, the "My deadlines" semantics), and the
  product's wording in `Tenant.defaultLocale`.
- **`ownedBy` and `locale` are aggregation inputs, absent on the page.** The
  calendar page's answer does not move; the push gets the filter applied before
  the total cap, so the cap is spent on the person's own events.
- **The catalogue duplicates the page's type labels on purpose.** Pushed text
  lives under `workspaceText.*` with the rest of the text the product writes on
  a workspace's behalf; a unit test holds it equal to the page's composition
  for every event type in both languages, so the two cannot drift.
- **Keyed on the event type, not the entity type.** One row can carry two
  deadlines; the step-0 keying would have made them share a calendar event.
  Nothing had ever been written to the mapping table, so no row moves.
- **Window from the start of the UTC day.** From `now` (03:00) today's
  deadlines dropped out and were deleted on their due day.
- **Failed and capped sources hold their deletes.** The generation read
  `erroredSources`, which the response never carries, so the outage guard was
  dead; it reads `failedSources` now, and an unread source no longer churns
  delete-then-recreate.
- **Removals before writes under the cap.** The cap (50 per person per run)
  bounds both quota and run time; removals are the revoke direction and never
  wait.
- **A 401 is retried once after a forced refresh.** Revoking on the first 401
  would disconnect a person over clock skew.
- **Google's quota 403 is a throttle.** The resilient layer reads every 403 as
  a lost credential, which the guard turns into a revoked connection.
- **Graph's duplicate answer is handled defensively and is unverified.** No
  real mailbox was reachable; every plausible shape is handled and the open item
  is recorded in the design doc.
- **Disconnect state is a column, not a reused field.** `disconnectRequestedAt`
  is additive and nullable; `revokedReason` is person-facing text and the wrong
  place for a state the job branches on. The retry window (7 days), the inline
  removal budget (25) and the per-run cap (50) are named constants chosen here;
  the design asked for "bounded", not for a number.
- **The Microsoft refresh goes to the recorded directory.** The token was
  issued at `TenantCalendarConsent.externalTenantId`; refreshing at the
  deployment's own directory would be refused and read as a withdrawn consent.
  Inflect's record of a withdrawn admin consent does not stop pushes — that is
  `revokeAdminConsent`'s documented behaviour, and whether it should is put to
  the owner.
- **No second, more frequent revoke-only schedule.** Considered, per the
  design; one daily run with removals first is the shipped shape.
