# Google OAuth verification for the calendar

> **DRAFTS FOR THE OWNER.** The scope justification, the privacy-policy section
> and the video shot list below are drafts written from what the code does
> today. Edit them, then submit them yourself. Google's form fields and their
> wording change; check every item here against the Google Cloud console at the
> time you submit. This page was written without access to that console.

Calendar push asks Google for one scope, `https://www.googleapis.com/auth/calendar.events`
(`GOOGLE_CALENDAR_SCOPES` in `src/app-layer/integrations/providers/calendar/token.ts`).
Google classes it as **sensitive**. Until the app passes Google's verification
for it, people who connect see Google's "unverified app" screen, and the OAuth
client is limited to 100 external users. This is item 6 of #5957.

## Owner decisions (2026-11-25)

- **The scope is `calendar.events`.** Verification goes ahead with it, as
  `GOOGLE_CALENDAR_SCOPES` already asks. No narrower scope is adopted, so
  nobody already connected has to reconnect.
- **The OAuth client is still in Testing, and that is the first thing to
  change.** In Testing, Google's refresh tokens expire after seven days, so
  every Google calendar connection stops within a week of being made, and the
  panel shows it as stopped. Set the publishing status to **In production**
  before anyone relies on the push. Until verification passes, people still
  see the "unverified app" screen and the client stays capped at 100 users,
  but connections stop expiring.
- **The public home page and privacy policy are pages of the app**:
  `<your app URL>/about` and `<your app URL>/privacy`, public without signing
  in, in English and Bulgarian. The policy covers the whole product and
  carries the calendar section and Google's Limited Use statement.

The OAuth client is the deployment's `GOOGLE_CLIENT_ID`. It also serves
**Sign in with Google**, whose scopes (`openid email profile`, `src/auth.ts`)
are not sensitive.

## What Google asks for

Each item is on the OAuth consent screen (Google Auth Platform: Branding,
Audience, Data access) or in the verification request. Check the current names
in the console.

| Item | What to have ready |
| --- | --- |
| Publishing status | **In production**, user type **External**. While the app is in Testing, Google issues refresh tokens that expire after seven days, so every connection would stop each week (the panel shows it as stopped) |
| App name, logo, support email | As people see them on the consent screen. A logo is reviewed too |
| Application home page | `<your app URL>/about` |
| Privacy policy link | `<your app URL>/privacy` |
| Terms of service link | Optional |
| Authorized domains | Your domain, verified in Google Search Console by an owner of the Google Cloud project |
| Redirect URIs (on the OAuth client) | `<your app URL>/api/integrations/calendar/callback` (the calendar, `CALENDAR_CALLBACK_PATH`) and `<your app URL>/api/auth/callback/google` (sign-in) |
| Scopes (Data access) | `.../auth/calendar.events` only, never the broader `.../auth/calendar`. Sign-in's `openid`, `email`, `profile` |
| Scope justification | The draft below |
| Demo video | An unlisted YouTube video; the shot list below |
| Contact email | Where Google's reviewers write; answer them from it |

**Before you submit: verify the app's domain.** Both pages are served by the
app itself, so the domain Google is told about is the app's own production
domain. An owner of the Google Cloud project verifies it in Google Search
Console and adds it under Authorized domains. Read both pages on the production
domain, signed out, before starting the request; the policy's text is
`external.privacyPolicy` in `messages/en.json` and `messages/bg.json`.

After verification, a customer's **Google Workspace administrator** may still
have to allow the app: Admin console → **Security** → **Access and data
control** → **API controls** → **Manage third-party app access**, find the app
by its client ID, and mark it **Trusted** (or Limited). Tell customers so.

## DRAFT — scope justification (`calendar.events`)

> Inflect is a compliance management application. A person can choose to copy
> the compliance deadlines they are responsible for — tasks assigned to them,
> reviews and renewals of items they own — into their own Google Calendar, so
> those dates appear next to the rest of their work.
>
> Inflect uses `calendar.events` only to create, update and delete the events
> it adds itself, in the person's primary calendar. It does not read, list,
> search or change any other event, and it does not use the person's calendar
> data for anything else. Each event is an all-day event on the deadline's date,
> marked private and shown as free, with no attendees and no location, and
> carries a title, a one-line description of the item and a link back to it in
> Inflect. Once a night Inflect updates the events whose deadline changed and
> removes those that no longer apply: the item was finished, the deadline
> passed, or the person may no longer see the item. When the person disconnects,
> Inflect deletes every event it added and revokes its access at Google.
>
> Inflect requests `calendar.events` and not the broader `calendar` scope,
> because it never creates, shares or deletes calendars and never reads
> calendar settings.

A reviewer may ask why an even narrower scope was not used (Google has added
some, for example `calendar.events.owned`). The owner decided on 2026-11-25 to
verify with `calendar.events`. Answer with the paragraph above: Inflect only
writes, by id, events it created itself in the person's primary calendar, and
reads nothing else. If a reviewer requires a narrower scope, switching is a code
change to `GOOGLE_CALENDAR_SCOPES` and a reconnect for everyone already
connected.

Facts it rests on, for a reviewer's follow-up questions:

- The Google writer (`google-writer.ts`) sends exactly three requests: a create
  (`POST …/calendars/primary/events`), an update of one of its own events by id
  (`PATCH`), and a delete of one by id (`DELETE`). It sends no list or get.
- What is pushed is the person's own open deadlines over the next 90 days
  (`docs/calendar-push-design.md`, "What is pushed").
- Events: `visibility: private`, `transparency: transparent`, the calendar's
  default reminders, a private extended property holding a hashed id that
  marks the event as Inflect's.
- On disconnect the refresh token is revoked at `oauth2.googleapis.com/revoke`.

## Privacy policy: calendar data

The calendar section is published in the app's privacy policy
(`<your app URL>/privacy`, section "Google and Microsoft accounts"), with
Google's Limited Use statement word for word. Its text is
`external.privacyPolicy.sections.google` in `messages/en.json` and
`messages/bg.json`; `tests/rendered/public-legal-pages.test.tsx` renders it.
Keep it consistent with `docs/sub-processors.md` (the `calendar` row) and
`docs/data-retention.md` (`UserCalendarConnection`, `UserCalendarEventMapping`)
whenever the calendar push changes.

## DRAFT — demo video shot list

Google asks to see the consent flow and every use of the scope. Record in
English, in one browser window, with the address bar visible. A nightly update
sits between the connect and the events, so the video is cut; say so in a title
card at the cut. Use a test workspace and a test Google account.

| # | Screen | Show |
| --- | --- | --- |
| 1 | Your public home page | The app name, what it does, the privacy policy link |
| 2 | Inflect, signed in: a task's page | A task assigned to you with a **Due Date**: the deadline that is copied |
| 3 | **Schedule** (the calendar page) | The header button **Sync to my calendar** |
| 4 | The panel **Your calendar** | Its points: only your own deadlines, private and shown as free, in the workspace's language, removed when you disconnect; "Google asks you to agree for yourself when you connect." |
| 5 | Click **Connect Google Calendar** → Google's consent screen | The app name, and the address bar showing the `client_id` and the `calendar.events` scope. Pause on the permission line |
| 6 | Back in Inflect | "Your calendar is connected. Your deadlines are added at the next nightly update." |
| 7 | Title card | "After the nightly update" |
| 8 | Google Calendar | The all-day event on the due date. Open it: title, description, the link to Inflect; visibility private, shown as free |
| 9 | Click the link in the event | It opens the task in Inflect |
| 10 | Inflect: mark the task done; title card "after the nightly update"; Google Calendar | The event is gone: finished deadlines are removed |
| 11 | Inflect: **Sync to my calendar** → **Disconnect** → the dialog → **Remove calendar connection** | "Google Calendar is disconnected. The events Inflect added were removed." |
| 12 | Google Calendar, then Google Account → **Security** → third-party connections | No Inflect events left; Inflect no longer listed as having access |

Shot 12's Google Account page name changes; find it at submission time.
