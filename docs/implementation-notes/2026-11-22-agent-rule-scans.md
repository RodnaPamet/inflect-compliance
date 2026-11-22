# 2026-11-22 — Agent-surface rules scans (`scanent-agent-rules/1`)

## Design

The scanner's third signed report reaches Inflect. scanent's agent scanner runs
static rules (re-authored from Cisco AI Defense's mcp-scanner and the Agent
Threat Rules) over each MCP tool definition its `mcp` source reads, and signs
what fired into `scanent-agent-rules/1`, with the key and scan id of its agent
report. It posts it to a route of its own with a key of its own.

```
scanner ──POST agent-rule-scans (key: admin:agent_rules_ingest)──▶ route
  route ──requirePermission('admin.agent_rules_ingest')──▶ ingestAgentRuleReport
    trusted AgentHarnessScannerKey rows ─▶ verifyAndParseAgentRulesReport
    secret walk ─▶ signer/scanner/submitter binding ─▶ REPLAY
    planAgentRulesScan ─▶ AgentRuleScan + AgentRuleScanItem + Finding (AGENT_RULE)
  /agents/reports?tab=agent-surface ─▶ getAgentRuleInventory (inventory key)
```

It is the third-party application ingest's twin, step for step. What differs:

- **What a scan closes.** The report lists each MCP server it read
  (`servers[]`, COMPLETE or INCOMPLETE, with its tool count), and each finding
  names its server. A finding is resolved only when the SAME scanner's later
  scan read that server in full and the rule did not fire again. The server of
  a stored finding comes from the items of earlier scans: a reference
  (`agent-rule:<ruleId>@<locator>@<scannerAgentId>`) names one field of one tool
  on one server, so every item of it carries the same `serverRef`, and a
  `groupBy` over the candidates gives it without a per-finding read.
- **One finding per rule and field.** A report listing the same one twice
  raises it once; the item's `(tenantId, scanId, sourceRef)` unique holds it.
- **No text anywhere.** The report carries none; titles come from a code table
  and descriptions from identifiers.

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, `auth.prisma` | `AgentRuleScan`, `AgentRuleScanItem`, back-relations |
| `prisma/migrations/20261122120000_agent_rule_scans/` | The tables, indexes, FKs and the RLS triple |
| `prisma/migrations/20261122120100_agent_rules_ingest_off_for_non_admin_custom_roles/` | The new side-door key stated `false` where only non-Admins carry a role |
| `src/lib/permissions.ts`, `roles.ts`, `auth/api-key-auth.ts`, `custom-role-admin-base-rule.ts` | The key: role defaults, `AGENT_ADMIN_KEYS`, `SIDE_DOOR_ADMIN_KEYS`, the scope |
| `src/lib/security/route-permissions.ts`, `src/lib/auth/guard.ts` | POST and GET rules; the static segment and the AUDITOR read path |
| `src/app-layer/usecases/agent-rule-scans.ts` | The ingest, the list and the tab's read |
| `src/app/api/t/[tenantSlug]/admin/agents/agent-rule-scans/route.ts` | The route |
| `src/lib/agentic/agent-rule-read-model.ts` | The tab's plain types |
| `src/app/t/[tenantSlug]/(app)/agents/reports/agent-surface/AgentSurfaceTab.tsx`, `ReportsClient.tsx`, `page.tsx` | The tab |
| `src/lib/observability/integration-metrics.ts` | `agent_rule.scan.outcome` |

## Decisions

- **Its own key**, as the scanner design's decision 3 said: a key minted for
  one report does not post another. Classified with `integrations_ingest`.
- **OBSERVATION, never NONCONFORMITY.** A rule match is a suggestion a person
  confirms; a legitimate tool can describe reading a file.
- **`INFO` is stored `LOW`.** `FindingSeverity` has no INFO and the contract
  has no CRITICAL; nothing is raised in the translation.
- **The tab reads open findings, not the latest scan's items.** A finding the
  latest scan could not see (its server unread) is still open and still shown;
  showing only the latest scan's items would hide exactly those.
- **Built against an unreleased contract.** The package version that carries
  `agent-rules-*` is scanent 0.17.0, held for a patched base image; this
  change merges only once that release exists and `package.json` points at it.
