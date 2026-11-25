# 2026-11-25 — Calendar vendor observations (#5957)

**Commit:** `calendar: count what Graph, Entra and Google answer, and script the owner's checks`

## Design

Calendar push was built without a Microsoft directory or a Google account, so
six of its behaviours are documentation, not observation (#5957). The owner
runs the real-account steps; this change makes each step leave countable
evidence and gives the owner a script to follow.

```
writer / callback ──▶ observeCalendarVendor() ──▶ one pino line
                       (vendor-observation.ts)     msg  calendar.vendor_observation
                                                   provider operation status code [dateShape]
                                                          │
VM check `calendar-observations` ◀── docker logs --since 72h (app + worker)
   grep the message → awk: five values, each held to a vocabulary or a shape
   → a table of counts in the public job summary
```

The owner's steps are `docs/runbooks/calendar-vendor-verification.md`
(scenarios a–e plus the Azure portal checklist) and
`docs/runbooks/google-calendar-oauth-verification.md` (drafts for Google's
sensitive-scope verification).

One behaviour changed: a refused Outlook code exchange is now read for its
codes (`CalendarCodeExchangeError`), so `AADSTS65001` at the exchange maps to
`consent_required` instead of `connect_failed`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/calendar/vendor-observation.ts` | The line: operation list, field builder, date-shape and earlier-event readers |
| `.../calendar/graph-writer.ts` | Observes inserts (new / existing / duplicate / refused), the duplicate lookup, every patch |
| `.../calendar/google-writer.ts` | Observes inserts |
| `.../calendar/calendar-http.ts` | `readEventBody`: read an answer once for its id and the fields the observation needs |
| `.../calendar/token.ts` | `CalendarCodeExchangeError`: the exchange's refusal, codes only |
| `src/app/api/integrations/calendar/callback/route.ts` | Observes redirect and exchange errors; exchange `CONSENT_REQUIRED` → `consent_required` |
| `src/app/api/integrations/calendar/admin-callback/route.ts` | Observes `/adminconsent` errors |
| `deploy/vm-check/remote.sh`, `vm.sh`, `.github/workflows/vm-check.yml` | The `calendar-observations` check |
| `docs/runbooks/calendar-vendor-verification.md`, `docs/runbooks/google-calendar-oauth-verification.md` | The owner's scripts |

## Decisions

- **A child logger with no bindings.** `logger.info` adds the ambient
  `requestId`, `tenantId` and `userId`. The observation must be countable
  without naming anybody, so it goes through `createChildLogger({})`, which adds
  only pino's own `level`, `time`, `pid` and `hostname`.
- **Values are checked twice.** The writer drops a `code` that is not
  code-shaped and an out-of-range status; the VM check's awk program re-reads
  each of the five keys with a strict pattern and prints `(other)` or `-` for
  anything outside its vocabulary. The awk lists are held equal to the
  TypeScript's by the VM check guard, and the program avoids `>` because the
  "writes no file" guard reads every line for one.
- **`graph.insert_existing` from Graph's own clocks.** A 2xx cannot say whether
  Graph de-duplicated. The event's `createdDateTime` against the answer's `Date`
  header (both Graph's) can: more than five minutes apart means an earlier
  event came back. Unreadable counts as new, never as a duplicate.
- **`graph.patch` for every patch, not a `patch_deleted` operation.** The writer
  cannot know an event was deleted by hand; the scenario arranges that exactly
  one patch happens that night, and its status is the answer.
- **The code is the `AADSTS` number when Entra sent one, else the OAuth
  `error`.** One field, and the number is what `readEntraError` classifies by.
  The audit row keeps both, as before.
- **`dateShape` is about what Graph stored, not what Outlook shows.** Graph
  answers in UTC when no `Prefer: outlook.timezone` is sent, so the runbook makes
  the date the owner sees in Outlook the answer to open item 2.
- **The duplicate scenario uses a reconnect.** The crash form (a create Graph
  accepted and Inflect never recorded) cannot be produced from the product. A
  disconnect then reconnect repeats every `transactionId` for events that were
  deleted, which is reachable and also shows a possible defect on both
  providers: a repeated id answered as a duplicate of a deleted event.
- **No observation on a forged callback.** Redirect errors are observed only
  after the sealed flow and the session are verified, so nobody can add rows by
  calling the callback URL.
