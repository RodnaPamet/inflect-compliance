# 2026-11-14 — Third-party application scans (`scanent-integrations/1`)

**Commit:** `feat(agents): ingest scanent's third-party application reports, with an Integrations tab`

## Design

scanent 0.15.0 signs a second report beside the agent report: the third-party
applications a directory (Entra, Okta, GitHub) has granted access to. Inflect
now ingests it, stores it, raises the planner's findings and shows the result
as an Integrations tab on `/agents/reports`. The shape is the harness ingest's,
step for step:

```
scanner ──POST signed report──▶ /api/t/:slug/admin/agents/integration-scans
                                 requirePermission('admin.integrations_ingest')
                                 readSignedReportBody (byte-capped stream)
                                       │
                                       ▼
                     ingestThirdPartyAppReport (usecases/third-party-app-scans.ts)
   trusted keys (AgentHarnessScannerKey, unrevoked) ─▶ verifyAndParseIntegrationsReport
   firstSecretShapedMember ─▶ signer → key ─▶ SCANNER_MISMATCH / SUBMITTER_MISMATCH
   replay ─▶ planIntegrationsScan(body, { unusedDays: DEFAULT_UNUSED_DAYS })
   write ThirdPartyAppScan, DiscoveredThirdPartyApp, ThirdPartyAppScanItem
   reconcile Finding (sourceKind THIRD_PARTY_APP) through FindingRepository
   logEvent THIRD_PARTY_APP_SCAN_INGESTED; recordThirdPartyAppScanOutcome
                                       │
/agents/reports?tab=integrations ◀── getThirdPartyAppInventory (inventory read)
```

The contract (schema, signature, secret walk) and the planner are the
package's; Inflect holds no copy. The same registered scanner key signs both
reports, and each verifier refuses the other's contract, so a harness report
posted here is a `SCHEMA` refusal.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma`, `auth.prisma` | The three models and their back-relations |
| `prisma/migrations/20261114120000_third_party_app_scans` | Tables, indexes, FKs, the RLS triple on each |
| `prisma/migrations/20261114120100_integrations_ingest_off_for_non_admin_custom_roles` | States the new key `false` on custom roles only non-ADMIN memberships carry |
| `src/lib/permissions.ts`, `src/lib/auth/api-key-auth.ts`, `src/lib/roles.ts`, `src/lib/custom-role-admin-base-rule.ts` | The key, its scope, its side-door classification, its base-rule classification |
| `src/lib/security/route-permissions.ts`, `src/lib/auth/guard.ts` | POST and GET rules above the agents catch-all; the static segment; AUDITOR's GET |
| `src/lib/agentic/scan-report-body.ts` | The byte-capped body read, shared by both ingest routes |
| `src/app/api/t/[tenantSlug]/admin/agents/integration-scans/route.ts` | The ingest and the scan list |
| `src/app-layer/usecases/third-party-app-scans.ts` | The only writer of the three tables; the inventory read |
| `src/lib/agentic/third-party-app-read-model.ts` | Client-safe view types and `thirdPartyScanCompleteness` |
| `src/lib/observability/integration-metrics.ts` | `third_party_app.scan.outcome` |
| `src/app/t/[tenantSlug]/(app)/agents/reports/integrations/*` | The tab |
| `messages/en.json`, `messages/bg.json` | The key's label and the tab's strings |

## Decisions

- **No re-export modules.** The harness contract's eight re-exports exist so
  ~100 importers kept their `@/` paths when the contract moved into the
  package. Nothing had a path to keep here, so the usecase imports
  `@rodnapamet/scanent-contract/integrations-*` directly, and the import-closure
  guard's list of eight is unchanged.
- **`integrations_ingest` is a side-door key**, not an admin-API-only one: the
  `admin:integrations_ingest` scope carries it, so an agent-bound API key
  acting for a membership posts past the edge's role gate, exactly as
  `admin:harness_ingest` does. The guardrail's rule 5 holds that honestly.
  Like `harness_ingest`, it is not in `WILDCARD_EXCLUDED_ACTIONS`: `*` and
  `admin:*` reach it, so keys already issued with a wildcard can post this
  report too (it still counts only when a registered scanner key signed it).
  No MCP tool requires it, so it is not a `ScopeCheckAction`.
- **The migration was needed even though no role stores the key.** An
  ADMIN-based custom role reads a missing key from ADMIN's defaults, which
  grant it; carried by a READER, that role would gain the key on deploy.
- **Resolution needs the application in the scan.** The brief allowed closing
  an absent application's findings when its source was read in full. The
  planner's own rule ("an application absent from a report is not concluded
  gone, unused or clean") and the harness ingest's ("an agent absent from a
  scan resolves nothing") both say no, so an absent application closes
  nothing. A present one closes only what its COMPLETE source concluded:
  anything in the plan's `notConcluded` for it or its source holds.
- **Empty-inventory references carry the scanner.** The planner keys that
  finding on the source kind, which every directory of that kind shares, so two
  scanners reading two Entra directories would close each other's. The stored
  reference is the planner's with `@<scannerAgentId>` appended.
- **Finding type:** `INTEGRATION_UNUSED` and `INTEGRATION_EMPTY_INVENTORY` are
  OBSERVATIONs; the grant findings are NONCONFORMITIES.
- **Items store names and classes only.** `grantsJson` keeps the planner's
  high and unknown permissions without the role id; publisher and owner count
  are NULL where the read did not establish them or the product does not expose
  them, and the read model tells the two apart with `NOT_EXPOSED_BY_PRODUCT`.
- **The class words are translated,** not taken from the package's English
  `CLASS_WORDS`, so the Bulgarian tab reads in Bulgarian; the product titles are
  proper names and come from `INTEGRATIONS_PRODUCT_TITLE`.
- **AUDITOR may GET the scan list,** as it may the harness list: the route takes
  the inventory view key, which AUDITOR holds.
