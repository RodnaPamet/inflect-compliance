# Calendar push — design

> **Status: living design** — the connection (connect, callback, token
> storage, admin consent routes) is built and hardened; the writer, the admin
> consent page and the Connect control are not. Epic #5937 tracks the steps,
> one pull request each. The `Current state` section is true today; the
> `Roadmap` section is the plan for steps 2–4.

What this feature is for: a person connects their own Google or Microsoft
calendar, and the compliance deadlines they are responsible for appear in it,
kept current, and removed when they stop applying or the person disconnects.

Companion documents: [`calendar-surface-do-not-touch.md`](calendar-surface-do-not-touch.md)
(the parts of the calendar that are already right and must not be "fixed"),
[`sub-processors.md`](sub-processors.md) (the `calendar` row, which must be
updated in the same pull request that first writes to a calendar), and
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
   next sign-in then fails at Microsoft. Today the callback reports that as
   `provider_error`. Step 3 maps Entra's missing-consent answer to its own
   outcome, verified against a real directory, so the page can say "ask your
   administrator to authorise again" instead of "something went wrong".
2. **The registration must be multi-tenant.** Admin consent in a customer's
   directory needs the app registration (`MICROSOFT_CLIENT_ID`) to accept
   other directories, and the user flow is sent to the authority recorded at
   consent (`TenantCalendarConsent.externalTenantId`). A single-tenant
   registration would make the consent page fail for every customer but one.
3. **`/adminconsent` grants everything the registration declares.** The
   calendar shares its app registration with Microsoft sign-in, so the grant
   covers sign-in's permissions too (harmless: they are user-consentable), and
   Microsoft documents that re-running it MAY revoke other tenant-wide grants
   for the same app. Step 3's page says so beside the button.
4. **The admin-consent callback has the defects the user callback had before
   step 1** (below): an unsigned `cal_admin_state` cookie scoped to `/`, a
   redirect built from `url.origin`, and a thrown error that leaves the admin
   on a JSON body. Step 3 fixes them the same way.

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
| `connect_declined` | The provider answered `error=access_denied` |
| `provider_error` | Any other provider error, or neither a code nor an error |
| `consent_withdrawn` | Microsoft: the admin consent was withdrawn between connect and callback |
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
run after step 2 ships refreshes every live connection. No backfill was written:
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
`/api/integrations/calendar/admin-callback`. No page calls them.

### Push

`calendar-push-dispatch` runs daily at 03:00 UTC and enqueues one
`calendar-push-tenant` per workspace with a live connection. That job
enumerates the workspace's connections and writes nothing (`pushed: 0`).
`generatePushableEvents`, `reconcileCalendarEvents` and `sweepUserCalendar`
exist and are unit-tested, and have no production caller. There is no
`CalendarWriter` implementation. **Nothing is written to any calendar.**

## Roadmap (future direction)

### Step 2 — the writer

#### What is pushed

- **Sources.** What `getComplianceCalendarEvents` returns for the person, under
  their live membership (`resolveMemberContext` via `generatePushableEvents`),
  over the next `PUSH_WINDOW_DAYS` (90). That keeps the calendar's per-source
  authorization (do-not-touch §1) as the only authority.
- **Owned deadlines only — recommended, and an owner decision.** An OWNER or
  ADMIN can see every deadline in the workspace; pushing all of them would put
  hundreds of other people's tasks into one personal calendar. The
  recommendation is the calendar page's "My deadlines" semantics: push a
  deadline only when the person is its owner or assignee. `training` cannot
  take part (do-not-touch §6) and is not pushed. This also keeps what leaves
  for Google or Microsoft to the person's own work.
- **Fields.** An all-day event on the deadline's date (a deadline is a date,
  and a timed event would move across a timezone boundary). Title: the
  aggregation's title. Description: its detail line and a link to the item in
  Inflect, built from the public origin. No attendees, no location, shown as
  free (`transparency: transparent` / `showAs: free`), private visibility, the
  provider's default reminders. A private marker identifies the event as
  Inflect's (`extendedProperties.private` on Google, a single-value extended
  property on Graph), so support can tell ours from the person's own.
- **Language.** The aggregation's prefixes ("Evidence review: …") are English
  today. Pushed text uses the workspace's `Tenant.defaultLocale`, the language
  the product writes into the workspace's records, not the browser cookie a
  job cannot see. Translating the prefixes means giving the aggregation a
  locale parameter; the titles of the items themselves are the workspace's own
  text and stay as written.

#### The `CalendarWriter` contract

The interface already exists in `usecases/calendar-reconcile-sweep.ts`:
`insert({ clientEventId, event }) → { remoteEventId }`,
`patch({ remoteEventId, event })`, `remove({ remoteEventId })`. Two
implementations, under `integrations/providers/calendar/`, each taking an
access-token supplier (`resolveCalendarAccessToken` with `persist` bound to
`updateCalendarToken`) and going through `resilientFetch`, so 401/403 become
`IntegrationAuthError` and 429 becomes `IntegrationRateLimitedError` — the two
errors the sweep treats as connection-level.

| | Google Calendar API v3 | Microsoft Graph v1.0 |
| --- | --- | --- |
| Calendar | `primary` | `/me/calendar` (the default) |
| Insert | `POST events` with `id = clientEventId` (lowercase hex is valid base32hex) | `POST /me/events` with `transactionId = clientEventId`, header `Prefer: IdType="ImmutableId"` |
| A retried insert | `409` → the event exists under OUR id: `remoteEventId = clientEventId` | Graph de-duplicates on `transactionId`; the exact answer to a duplicate is verified against a real mailbox in step 2 and recorded in its PR |
| Update | `PATCH events/{id}` | `PATCH /me/events/{id}` |
| Delete | `DELETE events/{id}`; `404`/`410` is done | `DELETE /me/events/{id}`; `404` is done |

Graph does not accept a caller-chosen event id, which `calendar-event-reconcile.ts`'s
idempotency note assumes of both providers; `transactionId` is Graph's
equivalent, and the immutable-id header keeps the stored id valid when the
person moves the event between calendars.

#### Idempotency and reconciliation

Unchanged from what exists: `UserCalendarEventMapping` is the record of every
pushed event; the deterministic `clientEventId` makes a retried create a no-op;
`contentHash` detects a change without reading the remote; a failed remote
delete keeps the row in `PENDING_DELETE` for the next run; a person who may see
nothing any more (`refused` / `no-visible-sources`) has everything removed. An
event the person edited by hand is overwritten on the next change to the
deadline and otherwise left alone; one they deleted by hand is re-created only
when the deadline changes (a `patch` of a deleted event returns 404/410, which
the writer turns into a fresh insert).

#### Rate limits

Google applies a per-user-per-minute quota and a daily project quota, and
answers `403 rateLimitExceeded` / `429`. Graph allows four concurrent requests
per mailbox and a request budget per app per mailbox per ten minutes, and
answers `429` with `Retry-After`. So: writes for one person are sequential;
each run caps the actions per person (a first push of a long backlog spreads
over several nights instead of meeting the quota); a rate-limit answer is
connection-level, stops that person's run, and the next run resumes from the
mapping table. No retry inside a run honours a provider's `Retry-After`
beyond the job's own budget.

#### Token expiry and revocation

`resolveCalendarAccessToken` refreshes inside a 60-second skew and persists a
rotated token BEFORE using it (Microsoft invalidates the old refresh token).
A refusal (`400 invalid_grant`, or `401` after a fresh refresh) is
`IntegrationAuthError`; `calendar-consent-health.ts` marks the connection
revoked once, destroys the token and stops scheduling it, and the person sees
"reconnect". Events already pushed stay in their calendar while there is no
token to reach them; the mapping rows are kept, so a reconnect resumes and the
next run patches or removes them by their stored ids.

#### Wiring into `calendar-push-tenant`

For each live connection, inside `runUserPushGuarded` (one person's failure
never stops the batch):

1. read the token with `runInTenantJobContext({ tenantId, source: 'calendar-push' })`
   — a non-bypass source, or the DEK does not resolve and the read is refused;
2. build the provider's writer;
3. `sweepUserCalendar({ tenantId, userId, provider }, { store, writer })`, with a
   Prisma-backed `MappingStore` on `UserCalendarEventMapping`;
4. stamp `lastPushedAt`.

The job returns the counts the sweep reports. The REVOKE direction (removing
events a person may no longer see) is cheap to compute and only its deletes
reach a provider, so step 2 also considers a second, more frequent schedule
that runs the sweep with inserts and patches suppressed.

#### Disconnect

`DELETE /calendar/connections?provider=…` deletes the pushed remote events
FIRST and drops the token after (`deleteAllForDisconnect`, then
`revokeCalendarConnection`). Reversed, the events are stranded with no
credential left to reach them. When some deletes fail, the connection is
marked as disconnecting, keeps its token, and the nightly run retries only the
deletes; after a bounded number of days the token is dropped anyway and the
person is told which events could not be removed. Google's token is then also
revoked at `oauth2.googleapis.com/revoke`; Microsoft has no per-token
revocation for a delegated grant, so the refresh token is simply destroyed.

The same pull request updates the `calendar` row of `sub-processors.md` to say
what is written.

### Step 3 — the Microsoft admin consent page

A card on Admin → Integrations, shown to holders of `admin.manage` (the
routes' gate): whether the workspace has granted, when, by whom and in which
directory; "Authorise for your organisation" (POST, then the browser follows
the returned URL to Entra) and "Withdraw" (DELETE, destructive vocabulary).
The page states point 3 above beside the button. In the same pull request the
admin callback gets the user callback's hardening: a sealed, signed flow
cookie scoped to its path, `resolvePublicOrigin`, a redirect on every failure
to `/t/<slug>/admin/integrations?calendar=<outcome>`, and Entra's
missing-consent answer mapped to its own outcome (point 1).

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
