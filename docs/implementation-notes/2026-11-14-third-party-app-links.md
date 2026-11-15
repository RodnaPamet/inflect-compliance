# 2026-11-14 — What-is-this and deactivate links on the Integrations tab

**Commit:** `feat(agents): what-is-this and deactivate links on the Integrations tab`

## Design

The Integrations tab on `/agents/reports?tab=integrations` lists the
third-party applications a directory (Entra, Okta, GitHub) granted access to.
The owner asked, per row, for a way to learn what the application is and to
deactivate it. Decision: a deep link to the vendor's own page. Inflect stays
read-only — no write path, no new permission, no new connector.

```
scanent-integrations/1 report
  └─ ingest (only writer) ── DiscoveredThirdPartyApp.publisherAppId / publisherAppSlug
                                   │  (latest scan wins, null included)
getThirdPartyAppInventory ─────────┘
  └─ thirdPartyAppLinks({ applicationId, publisherAppId, publisherAppSlug })
       └─ ThirdPartyAppRow.manageUrl / aboutUrl ── IntegrationsSection: two external links
```

| Product | Manage / deactivate | What is this? |
| --- | --- | --- |
| GitHub `github:<org>:installation:<id>` | `https://github.com/organizations/<org>/settings/installations/<id>` | `https://github.com/apps/<slug>` when a valid slug is stored |
| Entra `entra:<dir>:sp:<object>` | Entra admin centre enterprise-application blade by `objectId` + `appId`, only with a valid application id | — |
| Okta `okta:<host>:app:<id>` | `https://<first label>-admin.<rest of host>/admin/apps/active` | — |

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `DiscoveredThirdPartyApp.publisherAppId`, `.publisherAppSlug` (nullable, non-secret) |
| `prisma/migrations/20261114150000_third_party_app_publisher_ids/` | The two `ADD COLUMN`s; RLS unchanged |
| `src/lib/agentic/third-party-app-links.ts` | Pure, client-safe link builder and the allowed-host predicate |
| `src/lib/agentic/third-party-app-read-model.ts` | `ThirdPartyAppRow.manageUrl`, `.aboutUrl` |
| `src/app-layer/usecases/third-party-app-scans.ts` | Ingest stores the publisher ids; inventory read builds the links |
| `src/app/t/[tenantSlug]/(app)/agents/reports/integrations/IntegrationsSection.tsx` | Vendor-console column and the note above the table |
| `messages/en.json`, `messages/bg.json` | The column, link, new-tab and note strings |

## Decisions

- **Links, not writes.** A deactivate button would need a directory write
  credential per product, a write ladder and a permission; the owner chose
  none of that. The note above the table says deactivation happens in the
  vendor's console and the next scan shows the result.
- **Built on the server, from validated parts.** The builder copies the few
  contract patterns it needs rather than importing
  `@rodnapamet/scanent-contract`, whose integrations modules require `crypto`;
  it re-checks the stored values because a column is not a verified report. Any
  part that does not match exactly yields `null`, so a row shows no link rather
  than a guessed one. The hosts are fixed literals (or the Okta org host with
  `-admin` inserted after its first label), never a value from the report.
- **Entra needs both ids.** The enterprise-application blade is addressed by
  the service principal's object id AND the application id; without a valid
  application id there is no link rather than a blade that will not open. No
  "about" link: Entra has no stable public page per application.
- **Okta links the application list, not the application.** Okta's
  per-application admin URL needs the app's internal name, which the report
  does not carry; the active-apps list is where an administrator deactivates it.
  An admin host whose first label would exceed 63 characters is not built. An
  org whose own first label already ends in `-admin` still gets `-admin`
  inserted — the scanner is configured with the org host, not the admin host.
- **Latest scan wins, null included.** The publisher ids are what the directory
  says now; a scan that no longer carries one clears the link rather than keep a
  stale one.
- **No backfill.** Existing rows read NULL (no link) until their directory's
  next scan.
