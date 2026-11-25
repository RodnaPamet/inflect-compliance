# 2026-11-25 — The calendar Connect control (epic #5937, step 4)

## Design

Steps 1 and 2 built the connection and the nightly push with no way into them
from the product. This step adds the control on `/calendar` that a person uses
to connect their own Google or Outlook calendar, see its state, and disconnect,
plus the one server read the control needs.

```
/calendar header (PageActions)
  ToggleGroup (views)   OverflowAction ─ "Sync to my calendar" ── phone: "⋯" menu item
                                │ first click: next/dynamic import
                                ▼
                        CalendarConnectPanel (Modal)
                          GET /calendar/connections ─► { connections[+state], providers[connectable, refusal] }
                          per provider: Connect ─► POST /calendar/connect ─► leaveForProvider(authorizeUrl)
                                        Disconnect ─► ConfirmDialog ─► DELETE ─► 204 | 202 {remaining}
                                        refusal ─► the reason, no button

callback ─► /t/<slug>/calendar?calendar=<outcome> ─► CalendarConnectOutcome
            (message kept in state, parameter removed with one router.replace)
```

The rule for "can this provider be connected" lives in one module,
`usecases/calendar-connectability.ts`, asked by both the read and the connect
route, so the panel never offers a button the route refuses. Refusals, in
order: `NOT_CONFIGURED`, `ADMIN_CONSENT_NOT_GRANTED`, `ADMIN_CONSENT_WITHDRAWN`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/calendar-connectability.ts` | New. `readCalendarConnectability`, `assertCalendarConnectable`, `calendarClientConfigured`, `calendarConnectionStateOf` |
| `src/app/api/t/[tenantSlug]/calendar/connections/route.ts` | GET adds `providers` and each connection's `state` |
| `src/app/api/t/[tenantSlug]/calendar/connect/route.ts` | Refuses through `assertCalendarConnectable` (409 / 403 with `details.reason`) |
| `src/app/t/[tenantSlug]/(app)/calendar/_components/connect/CalendarConnectAction.tsx` | New. The header action; lazy-loads the panel |
| `src/app/t/[tenantSlug]/(app)/calendar/_components/connect/CalendarConnectPanel.tsx` | New. The panel, per-provider rows, the disconnect confirm |
| `src/app/t/[tenantSlug]/(app)/calendar/_components/connect/CalendarConnectOutcome.tsx` | New. The `?calendar=` result message |
| `src/app/t/[tenantSlug]/(app)/calendar/_components/connect/connect-copy.ts` | New. `Record` maps over the server's types to message keys |
| `src/app/t/[tenantSlug]/(app)/calendar/_components/connect/leave-for-provider.ts` | New. The browser hand-off, replaceable in a rendered test |
| `src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx` | Header actions move into `PageActions`; mounts the action and the outcome |
| `messages/{en,bg}.json` | New `calendarConnect` namespace |
| `docs/user/guide/comply/calendar.md` | The help page's section on connecting a calendar |

## Decisions

- **Not configured means blank or a template placeholder.** The env schema
  asks only for a non-empty string, and three `.env` templates ship `your-…` or
  `REPLACE_ME…` values a deployment can boot with. Those are read as no client.
  A real but wrong client id is not detectable without calling the provider,
  and is not attempted.
- **The connection's state is the server's.** A person's disconnect and a
  refused token both leave `revokedAt` set; only the stored reason tells them
  apart, and it is the server's own phrase. The route maps it to a code
  (`calendarConnectionStateOf`) rather than have the page match English text.
  `user-calendar-connection.ts` was left untouched: an open pull request
  (#5951) edits it.
- **The panel reads only when opened.** The calendar page makes no extra
  request on load, and the existing calendar tests, whose fetch mock answers
  every URL with calendar events, see no new request. The cost is that the
  header button cannot show a state; the panel does.
- **Disconnect is a confirm, not an undo toast.** `docs/destructive-actions.md`
  excludes actions with effects outside Inflect: the DELETE removes events from
  the person's own calendar and, for Google, revokes the grant at Google. Undo
  could restore neither.
- **The connect's own refusal outranks the read.** When the POST answers a
  refusal (the consent was withdrawn after the panel read it), the row shows
  that refusal and the read is refreshed.
- **A live Outlook connection without the organisation consent says it is not
  updated.** That is the behaviour of #5951 (owner decision 2026-11-25: a
  withdrawn consent stops the push at once); the control states it and offers
  Disconnect, which still works.
- **The result message is captured while rendering, the parameter removed in
  an effect.** The message survives the `replace` that removes the parameter,
  a reload does not repeat it, and an unknown value is removed and says
  nothing — the address is not a channel for text.
- **A phone gets the action in the "⋯" menu.** It is secondary to reading the
  calendar; the view switch stays visible. The panel is a Modal, which a phone
  shows as a bottom sheet.
