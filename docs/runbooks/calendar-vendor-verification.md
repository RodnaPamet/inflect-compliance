# Checking calendar push against a real Microsoft directory

Calendar push (epic #5937) was built without access to Microsoft or Google, so
several of its answers follow each vendor's documentation and have never been
observed. Issue #5957 lists them, and `docs/calendar-push-design.md` records
them as the open items of steps 2 and 3. This page turns each one into a short
session: do the steps in Inflect and in Microsoft, then run one fixed read-only
check and read a table. Nobody reads a raw log.

Google's half of #5957 is app verification, not an observation:
`docs/runbooks/google-calendar-oauth-verification.md`.

## How the answers are read

Every vendor answer an open item depends on writes one log line,
`calendar.vendor_observation`, carrying five values and nothing else: the
provider, the operation, the HTTP status, the provider's machine code (an
`AADSTS` number, an OAuth `error`, a Graph or Google error code) and, for an
inserted event, the shape of the date the provider echoed back. No tenant,
person, address, title, event id, token or URL is in it.

The `VM check` workflow counts those lines:

1. GitHub → **Actions** → **VM check** → **Run workflow**, branch `main`, check
   `calendar-observations`.
2. Approve the run in the `production` environment.
3. Read the job summary. It holds one table: `Container`, `Provider`,
   `Operation`, `Status`, `Code`, `Date shape`, `Lines`.

The check reads the last 72 hours of the app's and the worker's logs. A
container's log starts when the container does, and Watchtower replaces both on
every new image, so the summary first says when each log starts. **Run the
check the same day as the step**, and if a log starts after the step, the step's
rows are gone: run the step again. An empty table means "nothing observed in the
window", never "the vendor sent nothing". The run's log is public, which is why
it prints counts only.

When a scenario is done, paste the table into #5957 under the scenario's letter.
Narrowing the writer or the Entra mapping to what was observed is a follow-up
pull request; this page only gathers the evidence.

### Which row answers which open item

| Row (operation, status, code) | Open item (#5957) | Reads as |
| --- | --- | --- |
| `graph.insert` · 2xx · date shape | 2 | A new event. `same_date`: Graph stored the start as sent. `shifted_back` / `shifted_forward`: Graph moved it |
| `graph.insert_existing` · 2xx | 1 | Graph answered a repeated `transactionId` with the event it had made EARLIER (its `createdDateTime` is more than five minutes before the answer) |
| `graph.insert_duplicate` · 409 or 400 · code | 1 | Graph refused a repeated `transactionId`, with this code |
| `graph.duplicate_found` / `graph.duplicate_not_found` | 1 | Whether the writer's lookup by its marker then found the event |
| `graph.insert` · 4xx · code | 1 | A refused create that did NOT name a duplicate. If it follows a repeat, this code is Graph's duplicate answer and the writer does not recognise it |
| `graph.patch` · 404 or 410 | 3 | The hand-deleted event is gone; the writer creates it again (a `graph.insert` row follows) |
| `graph.patch` · 2xx | 3 | The id still resolved — for a hand-deleted event, in Deleted Items, where a patch does not bring it back |
| `entra.admin_consent_error` · `-` · code | 4 | What `/adminconsent` sent back: the `AADSTS` number when Entra sent one, else the OAuth `error` |
| `entra.personal_consent_error` · `-` · code | 4 | An error on a person's Outlook sign-in redirect |
| `entra.exchange_error` · status · code | 4 | Entra issued a code and refused to exchange it |
| `google.insert` · status · code / date shape | — | Google's answer to a create (see scenario c) |

A redirect carries no HTTP status, so the `Status` of an `entra.*_consent_error`
row is always `-`. A code that is not shaped like a machine code is printed as
`-`, never as itself.

The nightly push runs at **03:00 UTC** (`calendar-push-dispatch` in
`src/app-layer/jobs/schedules.ts`). Nothing in the product runs it sooner: no
admin control and no `VM apply` action triggers it. Every scenario that needs a
push waits for that run; check after about 03:30 UTC.

## 0 — The app registration (Azure portal)

One Entra app registration serves Microsoft sign-in and the Outlook calendar.
Open it in the Microsoft Entra admin center: **Identity** → **Applications** →
**App registrations** → the registration whose **Application (client) ID** is
the deployment's `MICROSOFT_CLIENT_ID`. Microsoft's labels move; check each
item below against what the portal shows today.

- [ ] **Supported account types** (Authentication): *Accounts in any
  organizational directory (Any Microsoft Entra ID tenant — Multitenant)*.
  Admin consent in a customer's directory needs this (open item 5). A
  single-tenant registration answers every other directory with
  `AADSTS700016`, which the consent card shows as "Inflect's Microsoft app is
  not available to your directory".
- [ ] **Redirect URIs**, platform **Web**, exactly:
  - `<your app URL>/api/integrations/calendar/callback` — a person's Outlook
    sign-in (`CALENDAR_CALLBACK_PATH`);
  - `<your app URL>/api/integrations/calendar/admin-callback` — the
    organisation consent (`CALENDAR_ADMIN_CALLBACK_PATH`);
  - `<your app URL>/api/auth/callback/microsoft-entra-id` — Microsoft sign-in,
    which is already there if sign-in works.

  `<your app URL>` is the public origin people open Inflect at, scheme
  included, with no trailing slash.
- [ ] **Certificates & secrets**: a client secret that has not expired
  (`MICROSOFT_CLIENT_SECRET`). Note its expiry date in #5957.
- [ ] **API permissions**, Microsoft Graph, **Delegated**:
  - `Calendars.ReadWrite` and `offline_access` — the calendar
    (`MICROSOFT_CALENDAR_SCOPES` in `token.ts`);
  - `openid`, `email`, `profile`, `offline_access` and `GroupMember.Read.All` —
    sign-in (`src/auth.ts`).

  `/adminconsent` grants everything the registration declares, so an
  administrator who authorises the calendar also grants sign-in's
  `GroupMember.Read.All`. The consent card says so. `MailboxSettings.Read` is NOT
  requested; scenario (e) exists because of that.
- [ ] **Token configuration** → **Add optional claim** → token type **ID** →
  `xms_edov`. Sign-in links a Microsoft account to an existing Inflect account
  only when this claim is present and true (`src/lib/auth/oauth-email-trust.ts`).
  It does not affect the calendar.
- [ ] **Branding & properties** → publisher verification. Write down whether
  the publisher is verified. Many directories let people consent only to apps
  from verified publishers; the calendar relies on an administrator's consent,
  which this setting does not block.

Record the account type and the permission list in #5957 (open item 5).

## What you need for the scenarios

- A Microsoft Entra directory you administer (a developer or trial directory is
  fine) with an Outlook mailbox for a **Global Administrator** (or another role
  allowed to grant organisation-wide consent), and one for an **ordinary user**
  who holds no administrator role.
- An Inflect workspace where you are an ADMIN or OWNER, and where the ordinary
  user is a member (any role).
- A task in that workspace **assigned to the person who connects**, with a due
  date in the next 90 days and not done. On **Tasks**, **Task** opens **New
  task**; set **Assignee** and **Due Date**, then **Create Task**. Only the
  person's own open deadlines are pushed.

## (a) Microsoft admin consent: grant, cancel, non-administrator

Open items 4 and 5. Run the three parts in this order; each starts from **Admin
→ Integrations**, card **Outlook calendar for your organisation**.

**a1 — cancel.**
1. Click **Authorise for your organisation** (or **Authorise again**).
2. At Microsoft, sign in as the Global Administrator. On the consent screen,
   click **Cancel**.
3. Inflect shows "The authorisation was declined at Microsoft, so nothing
   changed."

**a2 — a non-administrator.**
1. Click the same button.
2. At Microsoft, choose **Use another account** and sign in as the ordinary
   user.
3. Note what Microsoft shows. It may stop on its own page ("Need admin
   approval") without returning to Inflect; if so, write that down, close the
   tab, and say so in #5957 — no row is written for an answer that never
   arrives.

**a3 — grant.**
1. Click the button again and sign in as the Global Administrator. Accept.
2. Inflect shows "Outlook is authorised for your organisation." The card reads
   **Authorised**, with the directory.

**Read.** Run `calendar-observations`.

| Expected row | Answers |
| --- | --- |
| `entra.admin_consent_error` · `-` · code, from a1 | Which code Entra sends when an administrator cancels: `AADSTS65004`, `access_denied` or `permission_denied` (the `/adminconsent` endpoint's documented one) |
| `entra.admin_consent_error` · `-` · code, from a2 | What a non-administrator produces. The mapping expects `AADSTS90094` (card: "The Microsoft account that signed in cannot authorise apps…") |
| no row from a3 | A grant writes no error row; the card is the evidence |

The single-tenant case of open item 4 is not run here: making the production
registration single-tenant breaks Microsoft sign-in for every other directory.
Section 0 records the setting instead.

## (b) A person connects Outlook, and the nightly push runs

Open items 1 and 2 (the first creates), and 4 (a removed grant).

**b1 — connect and push.**
1. Sign in to Inflect as the ordinary user. Open **Schedule** (the calendar
   page) and click **Sync to my calendar**.
2. In the panel, click **Connect Outlook**. Microsoft asks for a sign-in and no
   consent.
3. Inflect shows "Your calendar is connected. Your deadlines are added at the
   next nightly update."
4. Wait for the 03:00 UTC push. In Outlook, the task's deadline is an all-day
   event titled "Task due: …", private, shown as free.

**Read.** `graph.insert` · `201` · `-` · `same_date`, one row per event created.
A `shifted_back` or `shifted_forward` row is open item 2's answer for a UTC
mailbox; see (e).

**b2 — a grant removed in the Entra portal.** Run this after b1.
1. In the Entra admin center: **Enterprise applications** → the Inflect app →
   **Properties** → **Delete**. That removes the app and every grant to it from
   the directory; Inflect still has its record of the consent.
2. In Inflect, as the ordinary user: **Sync to my calendar** → **Disconnect** →
   **Remove calendar connection**, then **Connect Outlook** again.
3. Note what Microsoft shows (a consent prompt, "Need admin approval", or a
   return to Inflect) and the Inflect message.
4. Afterwards, restore the grant: as the administrator, **Authorise again** on
   the card.

**Read.**

| Row | Means |
| --- | --- |
| `entra.personal_consent_error` · `-` · `AADSTS65001` / `consent_required` | The removal surfaced on the redirect; Inflect showed "Your organisation has not authorised Outlook for Inflect yet…" |
| `entra.exchange_error` · `400` · `AADSTS65001` | It surfaced at the code exchange. Since #5957 this also shows the `consent_required` message; before, it showed "The connection could not be completed." |
| no row, and a Microsoft consent prompt the person accepted | The directory lets people consent for themselves; the connect succeeded without the organisation's grant |

## (c) A repeated create — Graph's answer to a duplicate `transactionId`

Open item 1. **It cannot be produced on purpose from the product in the form
the writer was built for.** That form is a push that dies after Graph accepted
a create and before Inflect recorded it; the next run creates again with the
same `transactionId`. Nothing in Inflect crashes a push on request.

What the product CAN do is repeat a `transactionId`: the id is derived from the
workspace, the person, the provider and the deadline, so after a disconnect a
reconnect creates every deadline again under the ids it used before — for events
the disconnect deleted.

1. After b1, as the ordinary user: **Sync to my calendar** → **Disconnect** →
   **Remove calendar connection**. The panel says the events were removed.
   Check Outlook: they are gone.
2. Click **Connect Outlook** again.
3. Wait for the 03:00 UTC push, then check Outlook: are the events back?
4. Run `calendar-observations`.

| Row | Means |
| --- | --- |
| `graph.insert` · `201` · `same_date` | Graph made new events: it does not hold a deleted event's `transactionId` against a new create, at least after this long |
| `graph.insert_existing` · 2xx | Graph answered with the DELETED event. If the events are missing from Outlook, Inflect is recording ids of deleted events: report it |
| `graph.insert_duplicate` · 409/400 · code, then `graph.duplicate_not_found`, then `graph.insert` · `201` | Graph remembers the deleted event's id; the writer created the event again under a derived id. Check the events are back in Outlook, once each |
| `graph.insert` · 4xx · code, with no events back | A refusal the writer does not recognise as a duplicate. Report the code |

Repeat the same steps with **Google Calendar** if you can. Google keeps a
deleted event as cancelled under its id, so a reconnect's create answers
`google.insert` · `409` · `duplicate`. The writer then writes the event's
content to that id with `status: confirmed`, which un-cancels it. Check that
the events come back in Google Calendar, once each, and report what you see.

The same path brings back a deadline that left the calendar and returned
without a reconnect: a task marked done and then reopened, or reassigned away
and back. To check it, mark a pushed task done, wait for a push (the event
goes), reopen it, wait for the next push (the event comes back).

For the crash form, watch for it instead: a `graph.insert_existing` or
`graph.insert_duplicate` row in a week with no disconnect is the writer meeting
it for real. Run the check after any night whose push the worker restarted
during.

## (d) An event deleted by hand in Outlook

Open item 3.
1. After b1, in Outlook, delete the pushed event. Do NOT empty Deleted Items:
   the question is what a patch does to an event that is still there.
2. In Inflect, open the task and change its **Due Date** (**Edit task**, then
   **Save**) to another day in the next 90 days.
3. Wait for the 03:00 UTC push. Look in the Outlook calendar on the new date,
   and in **Deleted Items**.
4. Run `calendar-observations`.

| Row | Means |
| --- | --- |
| `graph.patch` · `404`, then `graph.insert` · `201` | Graph treats the deleted event as gone; the writer created it again on the new date. The design holds |
| `graph.patch` · `200` | The immutable id still resolved in Deleted Items and the patch changed it there. If the event is not in the calendar, this is the open item's bad case: report it |

Only the changed task is patched that night, so the `graph.patch` count should
be 1. A higher count means other deadlines changed too; repeat on a quieter day.

## (e) A mailbox in another time zone

Open item 2. Inflect creates all-day events from midnight to midnight UTC, and
does not read the mailbox's zone (`MailboxSettings.Read` is not requested).
1. In Outlook on the web as the ordinary user: **Settings** → **Calendar** (or
   **General**) → **Language and time** → **Current time zone**. Pick a zone
   well WEST of UTC, such as Pacific Time (UTC−8).
2. Create a new task assigned to that user with a due date in the next 90 days
   (see "What you need").
3. Wait for the 03:00 UTC push. In Outlook (web, and the desktop app if you
   have it), check the event's date: it must be the task's due date, as an
   all-day event, not the day before or the day after, and not a timed event
   from 16:00.
4. Repeat 1–3 with a zone well EAST of UTC, such as Tokyo (UTC+9), and a new
   task.
5. Run `calendar-observations`.

**Read.** The date you SAW is the answer. The row says what Graph stored:
`graph.insert` · `201` · `same_date` means Graph kept the UTC midnight it was
sent. Graph answers in UTC (the writer sends no `Prefer: outlook.timezone`), so
`same_date` does not prove Outlook shows the right day; `shifted_back` or
`shifted_forward` proves Graph moved it. Report the zone, the date shown and the
row for each.
