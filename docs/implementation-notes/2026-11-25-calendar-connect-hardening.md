# 2026-11-25 — Calendar connect hardening (epic #5937, step 1)

## Design

The per-user calendar connection existed (connect route, callback, token
storage, admin consent routes) but had four defects the epic's investigation
found: no PKCE, a token sealed under the global key outside both rotation
sweeps, a callback that left the person on a JSON error, and a sub-processor
row claiming writes that do not happen. This step fixes the four and writes the
design for steps 2–4 (`docs/calendar-push-design.md`). It adds no UI, no writer
and nothing that writes to a calendar.

```
POST /t/:slug/calendar/connect
  prepareCalendarOAuthFlow({slug, provider, userId})
    → flow id (state), PKCE pair; body signed (HKDF(AUTH_SECRET, 'inflect-calendar-oauth-flow-v1'))
  authorizeUrl: state + code_challenge (S256)          cookie inflect_cal_flow, path = callback only
                                   │
                         provider sign-in
                                   │
GET /api/integrations/calendar/callback
  readCalendarOAuthFlow(cookie, state)   ── refused → /t/<signed slug>|/tenants ?calendar=flow_invalid
  getTenantCtx; ctx.userId === flow.userId
  error param / consent re-check / exchange(code, flow.codeVerifier) / save
  every path → /t/<slug>/calendar?calendar=<outcome>, cookie spent
```

The token column joined `ENCRYPTED_FIELDS`, so the usecase hands the Prisma
extension plaintext JSON and the extension seals it `v2:` under the tenant DEK.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/calendar/token.ts` | `createPkcePair` / `pkceChallengeFor`; `codeChallenge` required on the authorize URL, `codeVerifier` required on the exchange; `CalendarNoRefreshTokenError` |
| `src/app-layer/integrations/providers/calendar/oauth-flow.ts` | New. The sealed, signed flow cookie (state, slug, provider, starter, verifier) |
| `src/app/api/t/[tenantSlug]/calendar/connect/route.ts` | Seals the flow, sends the challenge |
| `src/app/api/integrations/calendar/callback/route.ts` | Reads the flow, binds the person, redirects on every outcome from the public origin |
| `src/app-layer/usecases/user-calendar-connection.ts` | Plaintext to the extension; refuses an undecrypted read; `CALENDAR_CONNECTED` / `CALENDAR_CONNECT_FAILED` audit; `CALENDAR_CONNECT_OUTCOMES` |
| `src/lib/security/encrypted-fields.ts` | `UserCalendarConnection: ['tokenEncrypted']` |
| `src/app-layer/jobs/calendar-push.ts` | Stale "unresolved consent-model decision" comment corrected |
| `docs/sub-processors.md` | The `calendar` row says what is true: a token is stored, nothing is written |
| `docs/calendar-push-design.md` | New living design for steps 2–4 |

## Decisions

- **The manifest, not explicit per-tenant encryption.** Both rotation sweeps
  iterate `ENCRYPTED_FIELDS` and nothing else, so being in the manifest is what
  "covered by rotation" means. `TenantSecuritySettings.auditStreamSecretEncrypted`
  and `AutomationRule.webhookSecretEncrypted` are credentials already there.
  `IntegrationConnection.secretEncrypted`, which this module used to imitate,
  stays explicit and `v1:`; it has the same rotation gap and is out of scope here.
- **Old `v1:` rows: decrypt-old, write-new on next use; no backfill.** The
  extension reads `v1:` per value. The next write (a reconnect, or the writer's
  first refresh — access tokens last an hour) re-seals `v2:`. Until then the row
  is still in the master-KEK sweep, and nothing in the product starts a
  connection, so the population is near zero. A backfill would be a migration
  that decrypts credentials for no reader.
- **No migration.** The schema change is a doc comment.
- **A sibling of `sso-flow.ts`, not a call into it.** Its protocol union,
  cookie name and paths are SSO's; sharing them would couple a calendar change
  to SSO sign-in. A distinct HKDF label keeps the two flows from verifying as
  each other.
- **The starter is in the flow.** Without it, a browser whose session changed
  between connect and callback files one person's token under another.
- **Signed, not encrypted, cookie.** As SSO's: HttpOnly, sent only to the
  callback path. PKCE defends a leaked CODE; an attacker holding this cookie
  already holds the browser.
- **A rolling deploy drops in-flight flows.** A flow started on the old build
  set `cal_oauth_state`; the new callback refuses it `flow_invalid` and clears
  it. Ten minutes at most, and no UI starts flows.
- **The consent model is #1999's**, confirmed by the owner on 2026-11-25; the
  design note records it as decided and lists what steps 2 and 3 must handle.
