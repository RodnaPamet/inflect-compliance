# SharePoint Integration — Operator Guide

IC imports compliance evidence from SharePoint document libraries, keeps
linked policies in sync with SharePoint files, and exports frozen audit packs
to a library. SharePoint is reached **exclusively via Microsoft Graph**, reusing
the Entra ID OAuth foundation (EI-1) — no new IdP. Code:
`src/app-layer/integrations/providers/sharepoint/`.

## What IC may reach

Every Graph request resolves through `graphUrl()` in `client.ts`, which accepts
`https://graph.microsoft.com/v1.0/` and nothing else, so a server-supplied
paging or delta link cannot send the bearer token anywhere but Graph (#5321).
Reading is limited to the drives of the sites an admin approved under
**Sites**: browsing, evidence import, policy linking and upload all ask
`assertDriveAllowed`, and nothing is read while no site is approved. The site
list follows Graph's paging, and a save keeps an approved site the list did not
return.

## SP-1 — Connecting SharePoint (delegated consent)

SharePoint uses **delegated** Graph scopes (IC reads what the consenting admin
can read, not the whole tenant). The connection stores its **own** access +
refresh token, separate from the NextAuth session token — different scopes,
different lifecycle, same refresh mechanism (`refreshMicrosoftToken`).

### Prerequisites (one-time, in the Entra portal)
On IC's App Registration:
1. **Redirect URI** — add `{APP_URL}/api/integrations/sharepoint/callback`
   (a single, tenant-agnostic URI; the IC tenant rides in a signed cookie).
2. **API permissions** — add the **delegated** Microsoft Graph scopes
   `Sites.Read.All`, `Files.Read.All`, `Files.ReadWrite.All` (the last is for
   SP-4 policy write-back). Grant admin consent if your tenant requires it.

### Flow
1. Admin → **Integrations** → **Microsoft SharePoint** → **Connect**.
2. IC sets a 10-minute HttpOnly `sp_oauth_state` cookie (`<nonce>.<tenantSlug>`)
   and redirects to the Entra consent screen (`prompt=consent`).
3. Microsoft redirects back to the callback. IC verifies the `state` matches the
   cookie nonce, re-authorises the session as a tenant **admin**
   (`getTenantCtx` + `assertCanAdmin` — the URL is never trusted alone),
   exchanges the code for the token pair, and stores it **encrypted** in
   `IntegrationConnection.secretEncrypted`.
4. Admin picks which **sites** IC may access (**Sites**) and runs **Test**.

Access tokens are refreshed on expiry and the rotated pair is re-encrypted
transparently on the next Graph call.

## SP-2 / SP-3 — Evidence import and delta sync

From an evidence form, a person browses an approved library and imports up to
20 files at a time (`importSharePointItems`), with the controls, category and
description the form carries. Each file becomes an Evidence row through the
ordinary upload path, plus a sync mapping that records its drive item and cTag.

The `sharepoint-delta-sync-dispatch` job runs every four hours, one delta sync
per enabled connection (`runSharePointDeltaSync`):

- A **changed** file is re-imported as a new Evidence row that carries the
  previous row's control links; the old row keeps its own, because it remains
  the evidence for the period it covered. The mapping is claimed by a status
  transition, so two concurrent runs cannot both re-import it (#5193).
- A **deleted** file marks its mapping STALE.
- The delta token is stored per drive only when the walk succeeded. A walk that
  stops at its page limit (50 pages) hands back a resume cursor — the opaque
  token, prefixed with the Graph parameter it belongs to, never a URL — and the
  run reports itself truncated rather than clean (#5555).

## SP-4 — Policy document sync (bidirectional)

Link a policy to a SharePoint file on the policy's **Current** tab. Publishing the
policy **pushes** its content to the file; editing the file in SharePoint fires a
Graph change-notification that **pulls** a new policy version (DRAFT). A conflict
banner appears when the SharePoint copy is newer than the last sync — pull first.

> [!WARNING]
> Auto-pull needs a **publicly reachable** webhook: the Entra App Registration
> must allow `{APP_URL}/api/webhooks/sharepoint`, and in local dev `APP_URL` must
> be an `ngrok`/dev-tunnel URL. Linking + manual push/pull work without it; only
> the automatic pull-on-change requires the webhook + subscription.

Subscriptions are renewed daily by the `sharepoint-subscription-renew` cron
(Graph caps them at ~3 days). A notification whose file eTag equals the one
already stored — the echo of IC's own push, among others — does nothing.

A Markdown-linked policy syncs both ways. A Word-linked (`.docx`) policy is
SharePoint-authoritative: IC pulls it, converting DOCX to sanitised HTML with
mammoth, and stores the result as an HTML policy version, but never pushes back
into the `.docx`, which would corrupt it (`docx.ts`).

## SP-5 — Audit pack export

A FROZEN audit pack can be exported to a library
(`POST /api/t/:slug/audits/packs/:packId/sharepoint-export`, `admin.manage`;
`src/app-layer/usecases/audit-pack-sharepoint-export.ts`). The export is one
ZIP holding a README, a `pack.json` manifest, `items.csv` and the evidence files
under `evidence/`, including the generated exports the pack holds by storage
key, within a 200 MB cap on the bundled files; the manifest is always
included.

## Smoke verification (staging — real Graph)

The SP-1 code is unit-tested hermetically (injected `fetch`); the OAuth
round-trip + real Graph shapes can only be confirmed against a real tenant:

1. **Connect** end-to-end → the connection appears with status **Connected**.
2. **Test** → returns the resolved site name (confirms `Sites.Read.All`).
3. **Sites** → lists the tenant's sites (confirms `/sites?search=*`); save a
   subset and confirm the allowed-site count updates.
4. Revoke consent in Entra, **Test** again → a clear "reconnect" error (confirms
   the 401/403 branches), and reconnect restores it.
5. Capture a redacted `GET /drives/{id}/root/children` and `/root/delta` page to
   anchor the SP-2/SP-3 fixtures (mirror `tests/fixtures/entra/`).

> [!NOTE]
> The SharePoint token is **separate** from the session JWT. Disconnecting
> removes the stored token (SP-4 also revokes Graph subscriptions); it does not
> affect the user's IC sign-in.
