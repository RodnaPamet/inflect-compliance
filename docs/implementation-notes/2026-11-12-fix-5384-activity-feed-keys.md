# 2026-11-12 — The activity feed applies the agent-register, access-review and findings keys (#5384)

**Commit:** `fix(mcp): filter agent-register, access-review and findings rows out of get_tenant_context by their own read keys (#5384)`

## Design

#5371 made `TENANT_CONTEXT_ROW_REDACTION` cover every model of the governed
compliance domains. Three domains were still outside it: the agent register
(every `agentic.prisma` model, read under `admin.agent_registry_view` OR
`admin.agent_registry`), access reviews (`access_reviews.view`), and findings,
which sat on `audits.view` although the findings register is read under
`findings.view` (#4574). An `McpToolManifestPin` row, written by every MCP call
that pins a tool, reached every key that could read the audit log.

The agent inventory's read is a DISJUNCTION (`mayReadAgentInventory`), and a
row rule took one key. So the rule now takes one key or an array meaning "any
one of":

```
keyOf(row) → PermissionKey | readonly PermissionKey[] | null
                  │                   │                  └─ kept (unchanged)
                  │                   └─ kept if ANY is held; [] is held by nobody
                  └─ kept if held (unchanged)

ACTIVITY_DOMAIN_ENTITIES group name ── a PermissionKey ──────────────▶ that key
                                    └─ an ACTIVITY_KEY_SETS name ──▶ its array
   agentInventory = [admin.agent_registry_view, admin.agent_registry]   (mayReadAgentInventory)
   agentActivity  = [admin.view, admin.agent_registry_view]             (mayReadAgentActivity)
```

The open-findings count (`stats.openFindings`, which is `db.finding.count`)
moves to `findings.view` in both dashboard tools' section rules, with the
`Finding*` rows.

## Files

| File | Role |
| --- | --- |
| `src/lib/mcp/tools/types.ts` | `McpRowRedactionRule.keyOf` may return an array: any one of the keys |
| `src/lib/mcp/authorize.ts` | `applyRowRedaction` keeps an array-keyed row when any key is held; an empty array drops it |
| `src/lib/mcp/tools/dashboard-redaction.ts` | `ACTIVITY_KEY_SETS`; agent-register, access-review and findings groups; `openFindings` under `findings.view`; the three access-review models leave `ACTIVITY_ENTITY_UNGOVERNED` |
| `tests/unit/mcp-activity-entity-domain.test.ts` | `agentic.prisma` and every `Agent*` model in the population; the key sets checked against the two predicates over every input; READER/EDITOR/AUDITOR feeds; access-review and findings rules; the stat |
| `tests/unit/mcp-row-redaction.test.ts` | The any-of arm of `applyRowRedaction`, empty set included |
| `tests/integration/mcp-tool-authz-per-invocation.test.ts` | Through `/api/mcp`: a key with no inventory or findings scope loses those rows; the same principal with both scopes reads them |

## Decisions

- **An array on the rule, not an equivalence table.** Making
  `admin.agent_registry` satisfy `admin.agent_registry_view` everywhere would
  have been smaller for the inventory, but runs and proposals are read under a
  different pair (`admin.view` OR the view key). One "any of" arm covers both, in the redaction pass, with no table of
  key implications that some other caller could start relying on.
- **The pairs mirror the predicates, and a test holds them to it.** The unit
  test enumerates every combination of `admin.view`, `agent_registry` and
  `agent_registry_view` and requires the feed to agree with
  `mayReadAgentInventory` and `mayReadAgentActivity`. The arrays cannot be
  derived from the predicates, so they are checked against them instead.
- **The default for an agentic model is the inventory read; a model whose own
  read surface differs takes that surface's gate.** Runs and proposals take
  the activity pair (`/agent-runs`, `/agent-proposals`), proposal sample audits
  `admin.agent_registry` (their only route), and `ExternalWriteJournal` / `ExternalToolPriorStateRead` take
  `admin.tenant_lifecycle` beside `IdentityWriteJournal`, the key of their
  policy surfaces. `AgentActionReceipt`, declared in `automation.prisma`, is
  agent data and takes the inventory read. The three global models with no
  `tenantId` (`AgentAssessmentDomain`, `AgentAssessmentQuestion`,
  `PlatformAgentKillSwitch`) are mapped as well: mapping costs nothing, and the
  test needs no exception for them.
- **Tenant skills take `admin.agent_registry`, not their own skill keys.** The
  skill read takes either `admin.agent_skill_author` or `…_review`, but both
  are ADMIN-API-only keys by the owner decision of 2026-10-30, and
  `admin-membership-only-keys-are-dead-elsewhere` refuses any machine surface
  (`src/lib/mcp/` included) that names them: a tool call acts through no edge,
  so naming a key there makes it live for memberships the decision refuses it
  to. The register key is the nearest key that is not on that list: OWNER,
  ADMIN and AI_ADMIN hold it with the skill keys, AUDITOR holds none of them.
- **Access reviews: the shared models stay on `access_reviews.view`, the
  AGENT-only ones take the register read.** `AccessReview`,
  `AccessReviewDecision` and `AccessReviewConnectedDecision` are shared by
  member, connected, legacy and AGENT campaigns, and a row cannot reliably say
  which — the scope or `subjectAgentId` is in `detailsJson` on a create, and
  absent from an update's changed-fields diff. So an AGENT campaign's root and
  connected decisions are visible to every role, as `access_reviews.view` is.
  `AccessReviewAgentPack`, `AccessReviewAgentNarrowing` and
  `AccessReviewDecisionSampleAudit` exist only for AGENT campaigns and take the
  inventory read. The reviewer half of their real gate ("the campaign's
  reviewer or a register reader") depends on the campaign and is not applied:
  the assigned reviewer who is not a register reader loses those rows from the
  feed, which is a narrowing.
- **`AuditWorkpaperFinding` stays on `audits.view`.** It is the workpaper's
  link row, read with the workpaper, not a findings-register row.
- **Every built-in role holds `findings.view` and `access_reviews.view`**, so
  those two moves change the feed only for custom roles and API keys; the
  agent-register move removes inventory rows from every API key without
  `admin:agent_registry_view` (no scope carries `admin.agent_registry`, and no
  wildcard carries the view key) and from a custom role that holds neither
  inventory key. READER and EDITOR hold neither too, but `canAudit` already
  gives them an empty feed; the unit test pins the row rule for them anyway.
