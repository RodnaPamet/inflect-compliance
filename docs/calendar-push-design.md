# Calendar push — design

> **Status: living design** — the connection (connect, callback, token
> storage), the writer (step 2: the nightly push of a person's own deadlines,
> and disconnect) and the Microsoft admin consent page (step 3) are built; the
> Connect control is not. Epic #5937 tracks the steps, one pull request each.
> The `Current state` section is true today; the `Roadmap` section holds the
> open items of steps 2 and 3 and the plan for step 4.

What this feature is for: a person connects their own Google or Microsoft
calendar, and the compliance deadlines they are responsible for appear in it,
kept current, and removed when they stop applying or the person disconnects.

Companion documents: [`calendar-surface-do-not-touch.md`](calendar-surface-do-not-touch.md)
(the parts of the calendar that are already right and must not be "fixed"),
[`sub-processors.md`](sub-processors.md) (the `calendar` row, which says what
the writer sends), and
[`data-retention.md`](data-retention.md) (`UserCalendarConnection`,
`UserCalendarEventMapping`).

## The consent model (decided)

**Owner decision 2026-11-25, confirming #1999.** It is not an open choice, and
steps 2 and 3 are planned on it.

| Provider | Who consents | What each person does |
| --- | --- | --- |
| Microsoft (Graph) | A workspace admin, ONCE, for the whole Entra organisation, through `/adminconsent` (a delegated `AllPrincipals` pre-grant) | Signs in to Microsoft and receives their OWN delegated token; no consent prompt |
| Google | Each person, for themselves | Signs in and consents on Google's screen |

The model was chosen in PR #1999 (commit `69ffed127`, "OAuth token lifecycle —
per-user for Google, admin-consented for Microsoft") and the tenant-wide
consent record and the four OAuth routes were added in PR #2000 (commit
`97420704a`). The fact it rests on: admin consent for a DELEGATED permission
removes the person's consent PROMPT, not the FLOW. Every person still signs in
and every token is that person's own; nothing is done on anybody's behalf
without them signing in.

Alternatives, recorded only as context:

- **Per-person consent for Microsoft too.** Works wherever the customer's
  directory lets users consent to `Calendars.ReadWrite`. Many enterprise
  directories disable user consent, and there every person would hit "Need
  admin approval" with no route forward from inside Inflect.
- **Application permissions (`Calendars.ReadWrite` as an app role).** One
  grant writes to EVERY mailbox in the directory without anybody signing in.
  Far wider than the feature needs, and an admin would rightly refuse it.

Points about the chosen model that steps 2 and 3 must handle (none of them
argues for a different model):

1. **Inflect's record of the grant is a memory, not a fact.** `TenantCalendarConsent`
   records that the admin-consent callback said `admin_consent=True`. An admin
   who later removes the grant in the Entra portal is not seen; each person's
   next sign-in then fails at Microsoft. Since step 3 the person's callback
   maps Entra's missing-consent answer to its own outcome, `consent_required`
   (see "Callback"), so the Connect control can say "ask your administrator to
   authorise again" instead of "something went wrong". The mapping is from
   Microsoft's documented codes and is not yet verified against a real
   directory (Roadmap, "Step 3 — open items").
2. **The registration must be multi-tenant.** Admin consent in a customer's
   directory needs the app registration (`MICROSOFT_CLIENT_ID`) to accept
   other directories, and the user flow is sent to the authority recorded at
   consent (`TenantCalendarConsent.externalTenantId`). A single-tenant
   registration would make the consent page fail for every customer but one.
3. **`/adminconsent` grants everything the registration declares.** The
   calendar shares its app registration with Microsoft sign-in, so the grant
   covers sign-in's permissions too (harmless: they are user-consentable), and
   Microsoft documents that re-running it MAY revoke other tenant-wide grants
   for the same app. The consent card says so beside the button.
4. **The admin-consent callback had the defects the user callback had before
   step 1**: an unsigned `cal_admin_state` cookie scoped to `/`, a redirect
   built from `url.origin`, and a thrown error that left the admin on a JSON
   body. Step 3 fixed them the same way (see "Admin consent (Microsoft)").

**Google** needs its OAuth app verified for the `calendar.events` scope, which
Google classes as sensitive (not restricted, so no third-party security
assessment): a verified domain and privacy policy, a scope justification and a
demonstration video. Until verified, people see the "unverified app" screen
and the app is capped at 100 external users. A customer's Google Workspace
admin may also have to mark the app trusted in their API controls.

## Current state (true today)

### Connect

`POST /api/t/:slug/calendar/connect?provider=google-calendar|outlook-calendar`,
gated by `CALENDAR_BASELINE_PERMISSIONS` (the person must be able to see at
least one calendar source). For Microsoft it refuses with 403 unless the
workspace's admin consent is recorded, and sends the person to the directory
the consent was granted in.

It returns `{ authorizeUrl }`, and sets the sealed flow cookie
(`oauth-flow.ts`, the SSO flow cookie's pattern):

- `inflect_cal_flow`, HttpOnly, SameSite=Lax, Secure in production, scoped to
  `/api/integrations/calendar/callback` only, ten minutes;
- its body names a random flow id (sent to the provider as `state`), the
  workspace slug, the provider, the member who started it and the PKCE
  verifier, and is HMAC-signed with a key derived from `AUTH_SECRET` (its own
  HKDF label, so an SSO flow never verifies as a calendar flow).

Both providers get an S256 PKCE challenge (`createPkcePair`, `token.ts`); the
verifier is never in a URL or a response body.

### Callback

`GET /api/integrations/calendar/callback` ends in a redirect on every path, to
`/t/<slug>/calendar?calendar=<outcome>` (or `/tenants`, the workspace picker,
when no signed flow names a workspace — an unsigned cookie's slug is never
trusted). The origin is `resolvePublicOrigin`, the same one the connect route
built `redirect_uri` from. The flow cookie is spent whatever happens.

| Outcome | When |
| --- | --- |
| `connected` | The token was exchanged and stored |
| `flow_invalid` | Flow cookie absent, forged, expired, for another `state`, carrying no usable verifier, or started by a different member than the session |
| `connect_declined` | The provider answered `error=access_denied` (for Microsoft, unless its AADSTS number says the organisation has not consented) |
| `provider_error` | Any other provider error, or neither a code nor an error |
| `consent_withdrawn` | Microsoft: the admin consent was withdrawn between connect and callback |
| `consent_required` | Microsoft: Entra answered that the organisation has not consented — `error=consent_required`, or an `error_description` starting `AADSTS65001` or `AADSTS90094` |
| `no_refresh_token` | The exchange issued no refresh token |
| `connect_failed` | No tenant context (signed out, not a member), or the exchange or the save failed |

The set is `CALENDAR_CONNECT_OUTCOMES` in `usecases/user-calendar-connection.ts`.
Nothing the provider sent is reflected: not its error code, not its
`error_description`.

Failures after the tenant context resolves are audited as
`CALENDAR_CONNECT_FAILED` (outcome, provider, and the provider's error code
when it is OAuth-shaped) and a stored connection as `CALENDAR_CONNECTED`
(provider, scope count). Neither row nor any log line carries the code, a
token, the verifier or a provider description.

### Token storage

`UserCalendarConnection.tokenEncrypted` holds `{ accessToken, refreshToken,
expiresAt }` as one JSON string, and is in the Epic B manifest
(`ENCRYPTED_FIELDS`): the encryption extension seals it under the workspace's
DEK (`v2:`), and both rotation sweeps cover it — `jobs/key-rotation.ts`
(`v1:` values, master-KEK rotation) and `jobs/tenant-dek-rotation.ts` (`v2:`
values, a workspace's DEK rotation).

Before #5937 the usecase sealed it with `encryptField` (the global KEK, `v1:`)
and the model was outside the manifest, so neither sweep touched it. Rows from
then are still `v1:` and still read, because the extension dispatches per value
on the envelope prefix. Each moves to `v2:` on its next write: a reconnect, or
the writer's first token refresh — access tokens live an hour, so the first push
run refreshes every live connection. No backfill was written:
until a row moves it stays covered by the master-KEK sweep, and the population
is small (no control in the product starts a connection).

Reading a token needs the workspace's DEK to resolve: a request context
(`runInTenantContext`), or a job context with a NON-bypass source
(`runInTenantJobContext`). Under a bypass source the extension hands back the
ciphertext; `readCalendarToken` refuses it rather than parse it.

Revoking keeps the row and writes the token as `''`.

### Admin consent (Microsoft)

`POST|GET|DELETE /api/t/:slug/admin/calendar/consent` (`admin.manage`) start,
read and withdraw the workspace's grant; Entra returns to
`/api/integrations/calendar/admin-callback`. The consent card on Admin →
Integrations calls them.

**Start.** `POST` refuses with 409 (`MICROSOFT_CLIENT_NOT_CONFIGURED`) when the
deployment has no Microsoft app registration (`microsoftCalendarClientConfigured`
in `token.ts`: an empty value, or an example file's placeholder, `REPLACE_ME…`
or `your-…`), rather than send the admin to a page that fails at Microsoft.
Otherwise it returns `{ consentUrl }` and sets the sealed flow cookie
(`admin-consent-flow.ts`, the personal flow's pattern):

- `inflect_cal_admin_flow`, HttpOnly, SameSite=Lax, Secure in production,
  scoped to `/api/integrations/calendar/admin-callback` only, ten minutes;
- its body names a random flow id (sent to Entra as `state`), the workspace
  slug and the administrator who started it, and is HMAC-signed with a key
  derived from `AUTH_SECRET` under its own HKDF label — distinct from the
  personal connect flow's and SSO's, so neither verifies as the other.

No PKCE: `/adminconsent` returns no authorization code. The pre-step-3 cookie
`cal_admin_state` (at `/`) is cleared by the start and by every callback.

**Callback.** Every path ends in a redirect to
`/t/<slug>/admin/integrations?calendar=<outcome>` (or `/tenants` when no signed
flow names a workspace), on `resolvePublicOrigin`, and spends the flow cookie.
The session must be the administrator who started the flow and must still hold
`admin.manage`; the callback asks the key again with `assertPermission`, so a
refusal writes the same `AUTHZ_DENIED` row the route gate would.

| Outcome | When |
| --- | --- |
| `consent_granted` | Entra answered `admin_consent=True`, and the grant is recorded with the directory Entra named |
| `consent_declined` | `error=access_denied` or `permission_denied` (the `/adminconsent` endpoint's documented failure), `AADSTS65004`, `AADSTS65001` or `consent_required` |
| `not_directory_admin` | `AADSTS90094`: the account that signed in cannot grant organisation-wide consent |
| `app_not_in_directory` | `AADSTS700016`, `unauthorized_client` or `invalid_client`: the registration is not available to that directory (point 2) |
| `provider_error` | Any other error, no `admin_consent=True`, or a `tenant` that is not a directory GUID |
| `flow_invalid` | Flow cookie absent, forged, expired, for another `state`, or started by a different member than the session |
| `not_permitted` | The session no longer holds `admin.manage` |
| `consent_failed` | No workspace context (signed out, not a member), or the grant could not be recorded |

The set is `CALENDAR_ADMIN_CONSENT_OUTCOMES` in
`src/lib/calendar-admin-consent-outcomes.ts`, read by the callback and the card
alike. Entra's answer is read by `readEntraError` (`entra-errors.ts`) from its
OAuth `error` code and the `AADSTS<digits>` number at the START of
`error_description`, and from nothing else in the description; neither the
description nor anything else Entra sent is reflected, logged or audited. A
`tenant` is stored only as the GUID Entra sends, because later authorize URLs
go to it.

A grant is audited `CALENDAR_ADMIN_CONSENT_GRANTED` and a withdrawal
`CALENDAR_ADMIN_CONSENT_REVOKED`, as before. A failure after the workspace
context resolves is audited `CALENDAR_ADMIN_CONSENT_FAILED` (category `access`,
the outcome, Entra's OAuth code and AADSTS number when code-shaped).

**The card.** `CalendarConsentCard` on Admin → Integrations, for holders of
`admin.manage` (the routes' only gate, so the card asks
`useOffersAdminApiWrite({ key: 'admin.manage' })` and nothing more):

- the status — authorised, not authorised, or revoked — and, once granted,
  when, by whom (the member's name, else their email) and in which directory;
- **Authorise for your organisation** (**Authorise again** while granted: the
  remedy when a person's sign-in reports `consent_required`), which POSTs and
  follows `consentUrl`, with point 3 stated beside it in plain words;
- **Revoke authorisation**, behind a danger-toned confirmation. Not an undo
  toast: revoking stops everybody's Outlook pushes and nothing in Inflect puts
  it back (re-authorising is another Microsoft sign-in by a directory
  administrator), which `docs/destructive-actions.md` lists as the case for a
  confirmation. The verb is the canonical `Revoke` (an authority is
  invalidated), not "Withdraw";
- when the deployment has no Microsoft client, a note saying so in place of
  the button (a grant recorded earlier can still be revoked);
- the callback's outcome, one message per outcome in `en` and `bg`, shown to
  every viewer (a callback can land somebody who has just lost the permission)
  and then removed from the URL.

A viewer without `admin.manage` sends no read and is offered no control.

### Push (step 2)

`calendar-push-dispatch` runs daily at 03:00 UTC and enqueues one
`calendar-push-tenant` per workspace with a live connection. That job visits
the workspace's live connections one person at a time
(`jobs/calendar-push.ts`), and for each:

1. reads the token with `runInTenantJobContext({ tenantId, source:
   'calendar-push' })` — the job's own, non-bypass source, so the workspace's
   DEK resolves — together with, for Microsoft, the directory the token was
   issued in (`TenantCalendarConsent.externalTenantId`, the authority a refresh
   must go to);
2. builds the provider's writer over it;
3. runs `sweepUserCalendar` with a Prisma-backed `MappingStore` on
   `UserCalendarEventMapping` (`usecases/calendar-mapping-store.ts`, one short
   transaction per call, never held across a provider request);
4. stamps `lastPushedAt`.

Each person's run is wrapped in `runUserPushGuarded`, so one person's failure
never stops the next: a refused token revokes that connection (once, token
destroyed, row kept), a throttle stops that person's run for the night, and
anything else is counted `failed`. The orchestration is
`usecases/calendar-push-person.ts`.

#### What is pushed

- **Sources.** What `getComplianceCalendarEvents` returns for the person, under
  their live membership (`resolveMemberContext` via `generatePushableEvents`),
  from the start of the current UTC day over the next `PUSH_WINDOW_DAYS` (90).
  The calendar's per-source authorization (do-not-touch §1) is the only
  authority. The window starts at the start of the day, not at the job's
  03:00, because day deadlines are stored at UTC midnight: a window from `now`
  would delete a deadline from the person's calendar on the day it falls due.
  A deadline whose day has passed leaves the window and is removed on the next
  run.
- **Only what is still to do (owner decision 2026-11-25).** A deadline whose
  item is finished (`status: 'done'`) is not pushed, and one already pushed is
  removed at the next run. A person whose deadlines are all done still sees
  their sources: their set is empty, never `no-visible-sources`.
- **Only the person's own deadlines (owner decision 2026-11-25).** A deadline
  is pushed only when the person is its owner or assignee — the calendar
  page's "My deadlines" semantics, `ownerUserId === userId`. The aggregation
  applies it (`ownedBy`), after its per-source permission gate and before its
  total cap. `training` carries no owner (do-not-touch §6) and is never
  pushed. What leaves for Google or Microsoft is the person's own work and
  nobody else's.
- **Fields.** An all-day event on the deadline's date. Title: the deadline
  kind and the item's own title, composed as the calendar page composes it.
  Description: the item's detail line and an absolute link to it, built from
  `APP_URL` (no link line when that is unset — a relative link is useless in a
  calendar outside Inflect). No attendees, no location, shown as free
  (`transparency: transparent` / `showAs: free`), private
  (`visibility: private` / `sensitivity: private`), the calendar's default
  reminders. A private marker holds the event's client id
  (`extendedProperties.private.inflectEventId` on Google, a single-value
  extended property on Graph), so support can tell ours from the person's own.
  A duration source (an audit cycle) is pushed as one all-day event on its
  start date.
- **Language (owner decision 2026-11-25).** The product's own wording — the
  deadline kind ("Evidence review"), the link line ("Open in Inflect: …") — is
  written in the workspace's `Tenant.defaultLocale` from the
  `workspaceText.calendarPush` catalogue (`en`, `bg`), read once per workspace
  per run. The aggregation takes it as `locale`. A job sees no browser cookie,
  and the reader of the event is reading the workspace's record. The titles of
  the items themselves are the workspace's own text and go as written. The
  English wording is the calendar page's English, unchanged; a unit test holds
  the two catalogues equal for every event type in both languages. The detail
  line is data and is not translated (one source, a treatment plan, writes
  "`<strategy>` strategy" there).
- **Identity.** A mapping row is keyed on the event TYPE and the entity id, not
  the entity type: one row can carry two deadlines (a risk's review and target
  dates, a vendor's review and contract renewal), which keyed on the entity
  would share one calendar event and overwrite each other every night.

#### The writers

`CalendarWriter` is `insert({ clientEventId, event }) → { remoteEventId }`,
`patch({ remoteEventId, event }) → void | { remoteEventId }` and
`remove({ remoteEventId })` (`usecases/calendar-reconcile-sweep.ts`). The two
implementations are `integrations/providers/calendar/google-writer.ts` and
`graph-writer.ts`, over a shared seam (`calendar-http.ts`): every request goes
through `createResilientFetch` over the bounded fetch, so 401/403 become
`IntegrationAuthError` and an exhausted 429 `IntegrationRateLimitedError`, the
two errors the sweep treats as connection-level. A 401 is retried once with a
freshly refreshed token; a second 401 is the provider's real answer.

| | Google Calendar API v3 | Microsoft Graph v1.0 |
| --- | --- | --- |
| Calendar | `primary` | `/me/events` (the default calendar) |
| Insert | `POST events` with `id = clientEventId` | `POST /me/events` with `transactionId = clientEventId`; every request sends `Prefer: IdType="ImmutableId"` |
| A retried insert | `409` → the event exists under OUR id: `remoteEventId = clientEventId` | 2xx with an id → that id. `409`, or a `400` whose error code names a duplicate → found by our marker (`$filter` on the single-value extended property); not found → a per-event failure. **Unverified against a real mailbox** — see the Roadmap |
| Update | `PATCH events/{id}` with `status: confirmed` (an event deleted by hand is kept by Google as `cancelled`) | `PATCH /me/events/{id}` |
| Update of a gone event | `404`/`410` → created again under `recreatedClientEventId(old id)`; the sweep records the new id | `404` → the same |
| Delete | `DELETE events/{id}`; `404`/`410` is done | `DELETE /me/events/{id}`; `404`/`410` is done |
| Throttle | `429`, and `403` with reason `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded`, which the writer hands the resilient layer as a 429 so a busy morning is not read as a lost credential | `429` with `Retry-After` |

#### Idempotency and reconciliation

`UserCalendarEventMapping` is the record of every pushed event; the
deterministic `clientEventId` makes a retried create a no-op; `contentHash`
detects a change without reading the remote; a failed remote delete keeps the
row in `PENDING_DELETE` for the next run; a person who may see nothing any more
(`refused` / `no-visible-sources`) has everything removed. An event the person
edited by hand is overwritten on the next change to the deadline and otherwise
left alone; one they deleted by hand is re-created when the deadline changes.

A source that FAILED or hit its per-source cap, or a total cap that bit, may
not have been read in full, so the deletes it would imply are HELD for that run
(`held` on the generation, `holdDeletes` on the reconciler): an absent event
there may simply be unread, and deleting it tonight would re-create it
tomorrow. A permission the person LOST is never held — that source is omitted,
not failed, and its deletes are the revoke direction. The generation reads the
aggregation's `failedSources`; it read a field the response never carries
before step 2, so an outage could have been taken for a lost permission.

#### Rate limits

A person's writes are sequential, and people are visited sequentially. Each
run makes at most `PUSH_ACTIONS_PER_PERSON_PER_RUN` (50) provider calls per
person; removals go first, so the cap never holds a removal behind a backlog of
new deadlines, and new deadlines go nearest first. A first push of a long
backlog spreads over several nights. Inside one call the resilient layer makes
at most two attempts and absorbs a `Retry-After` of at most five seconds; a
longer one ends that person's run as throttled, and the next run resumes from
the mapping table.

#### Token expiry and revocation

`resolveCalendarAccessToken` refreshes inside a 60-second skew and persists a
rotated token BEFORE using it (Microsoft invalidates the old refresh token);
that write is also what moves a pre-#5937 `v1:` row onto the workspace key. A
refusal (`400 invalid_grant`, or `401` after a fresh refresh) is
`IntegrationAuthError`; `calendar-consent-health.ts` marks the connection
revoked once, destroys the token and stops scheduling it. Events already pushed
stay in the calendar while there is no token to reach them; the mapping rows
are kept, so a reconnect resumes and the next run patches or removes them by
their stored ids.

The push stops at once when the workspace's Microsoft organisation consent is
withdrawn in Inflect, or was never recorded (owner decision 2026-11-25): the
person's run sends nothing and reports `consent-withdrawn`, and the connection
and its token are kept, so a re-grant resumes it. It does not wait for
Microsoft to refuse the next refresh. A disconnect is not held: its removals
take the person's own events out of their calendar, at their request.

### Disconnect

`DELETE /calendar/connections?provider=…` (`disconnectCalendar`) removes the
pushed events FIRST — up to `DISCONNECT_INLINE_REMOVALS` (25) in the request —
and destroys the token only when none is left; for Google it then revokes the
grant at `oauth2.googleapis.com/revoke` (best effort; the local token is gone
whatever Google answers). Microsoft has no per-token revocation for a delegated
grant, so the token is only destroyed. The answer is `204`.

When some removals fail or are left over, or the provider throttles, the
connection is marked as disconnecting (`UserCalendarConnection.disconnectRequestedAt`)
and KEEPS its token; the answer is `202` with `{ status: 'disconnecting',
removed, remaining }`. The nightly run retries only the removals for it (no
generation), and revokes when they are done or after `DISCONNECT_RETRY_DAYS`
(7) from the first request, whichever is first. What could not be removed stays
recorded in the mapping table, and `GET /calendar/connections` reports how
many per provider (`undeletedEventCount`); the Connect control (step 4) tells
the person. A token refused during a disconnect can remove nothing, so the
connection ends at once and the events stay recorded. A reconnect clears the
disconnecting state. Every disconnect is audited `CALENDAR_DISCONNECTED`
(provider, outcome, counts — never a token, an event id or a title).

## Roadmap (future direction)

### Step 2 — open items

Step 2 shipped (see "Push" and "Disconnect" above). What it could not settle:

- **Graph's answer to a duplicate `transactionId` is unverified.** Microsoft's
  documentation says Graph de-duplicates a create on `transactionId` and does
  not say what the duplicate POST answers. The writer was built with no access
  to a real mailbox and handles every plausible shape (an id → taken; `409` or
  a duplicate-coded `400` → looked up by our marker; anything else → a per-event
  failure retried next run). Which shape Graph returns is to be recorded
  against a real mailbox, and the writer narrowed to it.
- **Graph all-day events in UTC are unverified.** Events are created with
  `isAllDay` and midnight-to-midnight `UTC`. Whether Outlook shows them on the
  same date for a mailbox in another time zone has not been observed. Reading
  the mailbox's own zone needs `MailboxSettings.Read`, which is not requested.
- **A Graph patch of an event the person deleted by hand is unverified.** With
  immutable ids the event may still resolve from Deleted Items, where a patch
  would not put it back in the calendar.
- **No more frequent revoke-only sweep (owner decision 2026-11-25).** Removing
  events a person may no longer see could run more often than the daily push;
  the owner chose to keep one daily run, removals first under the per-person
  cap, so the lag is at most a day.

### Step 3 — open items

Step 3 shipped (see "Admin consent (Microsoft)" above). What it could not
settle:

- **Entra's error answers are mapped from documentation, not observation.**
  The step had no Entra directory to sign in to, and Microsoft was not
  contacted. `readEntraError` follows the `/adminconsent` endpoint's documented
  failure (`permission_denied`), OAuth's codes and the AADSTS reference
  (`65004` declined, `65001` and `90094` consent missing, `700016` app not in
  the directory). Which codes Entra actually sends — for an admin who cancels,
  a non-administrator at `/adminconsent`, a single-tenant registration, and a
  person whose organisation's grant was removed — is to be recorded against a
  real directory, and the table narrowed to it.
- **A removed grant may surface at the code exchange, not the redirect.** With
  user consent allowed, Entra may show the person a consent prompt instead of
  an error; with it disallowed, it shows "Need admin approval" and may not
  redirect at all, or redirect as a decline. If Entra instead issues a code and
  refuses the exchange with `AADSTS65001`, the callback reports
  `connect_failed`: the exchange's error body is not read.

### Step 4 — the Connect control on `/calendar`

- **Offered only where the server would accept it.** A server read (an
  extension of `GET /calendar/connections`) returns, per provider, whether a
  connect is possible and why not: the provider's client is not configured in
  this deployment, or Microsoft has no admin consent recorded. The page never
  computes this itself.
- **Connect / disconnect.** Connect POSTs and follows `authorizeUrl`;
  disconnect is `DELETE` behind a confirm (`Remove calendar connection` —
  disconnect deletes the pushed events).
- **Connected state.** Provider, connected since, last pushed, and a
  revoked connection's "reconnect".
- **The result message.** One message per `CALENDAR_CONNECT_OUTCOMES` value,
  in `en` and `bg`, read from `?calendar=` and then removed from the URL.
- **Phone.** The control sits in the page header's actions
  (`PageActions` + `OverflowAction`) and renders at 360 px.
