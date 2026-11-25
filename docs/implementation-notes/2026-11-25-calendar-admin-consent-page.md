# 2026-11-25 — Calendar admin consent page (epic #5937, step 3)

## Design

Microsoft's consent model is decided: an administrator of the customer's
Microsoft organisation consents once (`/adminconsent`), and each person then
signs in for their own token. The routes for that grant existed with no page,
and the admin callback still had the defects step 1 removed from the personal
callback. This step adds the page and hardens the callback the same way.

```
Admin → Integrations: CalendarConsentCard  (admin.manage)
  GET  /api/t/:slug/admin/calendar/consent   → consents (+ grantedBy) + microsoftClientConfigured
  POST …/consent → 409 MICROSOFT_CLIENT_NOT_CONFIGURED | { consentUrl }
       prepareCalendarAdminConsentFlow({slug, userId})
         cookie inflect_cal_admin_flow, path = admin callback only, 10 min,
         HMAC(HKDF(AUTH_SECRET, 'inflect-calendar-admin-consent-flow-v1'))
                                   │
                    Entra /adminconsent (state = flow id)
                                   │
GET /api/integrations/calendar/admin-callback
  readCalendarAdminConsentFlow(cookie, state)  ── refused → /t/<signed slug>|/tenants ?calendar=flow_invalid
  getTenantCtx; ctx.userId === flow.userId; assertPermission('admin.manage')
  error → readEntraError(code, AADSTS number) → outcome; admin_consent=True + GUID tenant → record
  every path → /t/<slug>/admin/integrations?calendar=<outcome>, cookie spent
  DELETE …/consent ← "Revoke authorisation" behind a danger ConfirmDialog
```

The personal callback gained one outcome, `consent_required`, read through the
same `readEntraError` (design point 1).

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/calendar/admin-consent-flow.ts` | New. The sealed admin flow cookie (state, slug, the administrator) |
| `src/app-layer/integrations/providers/calendar/entra-errors.ts` | New. `readEntraError`: OAuth code + leading AADSTS number → kind; `isEntraTenantId` |
| `src/app-layer/integrations/providers/calendar/token.ts` | `microsoftCalendarClientConfigured` |
| `src/lib/calendar-admin-consent-outcomes.ts` | New. The callback's closed outcome set, read by server and card |
| `src/app-layer/usecases/tenant-calendar-consent.ts` | `recordAdminConsentFailure` (audit `CALENDAR_ADMIN_CONSENT_FAILED`), `getAdminConsentOverview` |
| `src/app/api/t/[tenantSlug]/admin/calendar/consent/route.ts` | Seals the flow; refuses an unconfigured client; GET returns the card's read |
| `src/app/api/integrations/calendar/admin-callback/route.ts` | Reads the flow, binds the administrator, re-asks the key, redirects on every outcome |
| `src/app/api/integrations/calendar/callback/route.ts` | Microsoft errors read through `readEntraError`; `consent_required` |
| `src/app-layer/usecases/user-calendar-connection.ts` | `consent_required` in `CALENDAR_CONNECT_OUTCOMES` |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/CalendarConsentCard.tsx` | New. The card |
| `messages/en.json`, `messages/bg.json` | `admin.calendarConsent` |
| `docs/calendar-push-design.md`, `docs/user/guide/admin/integrations.md` | Step 3 moved to Current state; the help page |

## Decisions

- **Its own cookie, path and HKDF label**, not a mode of `oauth-flow.ts`. The
  two callbacks answer different authorities, and a flow sealed for one must
  not verify at the other (a unit test presents one at the other).
- **The callback re-asks `admin.manage`** rather than trust the start. The grant
  is recorded under its author, and authority can be removed inside the
  ten-minute window. `assertPermission` writes the same `AUTHZ_DENIED` row the
  route gate would; the outcome is `not_permitted`.
- **Only the GUID Entra sends is stored as the directory.** Later authorize URLs
  go to it. An absent `tenant` is stored as null, as before (the person's flow
  then uses `MICROSOFT_TENANT_ID`); a present non-GUID is `provider_error`.
- **Entra's description is read for its leading AADSTS number and nothing
  else.** It is Microsoft's prose and can name a directory or a UPN; the audit
  row keeps the OAuth code and the AADSTS number only, each dropped unless
  code-shaped. The mapping is from documentation; no directory was reachable.
- **`AADSTS90094` means different things on the two flows**: a
  non-administrator at `/adminconsent` (`not_directory_admin`), a missing
  organisation grant on a person's sign-in (`consent_required`).
- **"Not configured" includes the example files' placeholders.** The env schema
  makes an empty value impossible in production; a copied `REPLACE_ME_…` is the
  realistic case, and `/adminconsent` with it fails at Microsoft naming nothing
  the admin can fix. POST refuses it too, so the card's note is not the only
  defence.
- **Revoking is a confirmation, not an undo toast**, and its verb is `Revoke`.
  It stops everybody's Outlook pushes and cannot be put back from Inflect.
- **The outcome message shows to every viewer**, and the read and the controls
  only to `admin.manage`: `not_permitted` lands somebody who just lost the key.
  The parameter is read once into state and then removed from the URL with
  `history.replaceState`, which Next's `useSearchParams` follows.
- **The legacy `cal_admin_state` cookie is cleared with `path: '/'`.** A bare
  `cookies.delete(name)` names no path, and the browser scopes the expiry to the
  responding route's directory, leaving the cookie at `/`.
- **A rolling deploy drops in-flight admin flows**: a flow started on the old
  build carries `cal_admin_state`, which the new callback refuses
  `flow_invalid`. Ten minutes at most, and until this step no page started one.
