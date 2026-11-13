# 2026-11-13 — Org-level turn caps: delegations and tool calls per turn (#4594, Step 2e PR B)

**Commit:** `feat(agents): org-level turn caps — delegations and tool calls per turn (#4594)`

## Design

Owner decision 3 of 2026-11-13, designed in "Org-level turn caps" of
`docs/claude-tool-runner-design.md` (#5494). This is pull request **B**, first
deploy only. Pull request C (the sub-agents) follows it.

Two numbers bound what one model turn may start:

| Cap | Org ceiling | Workspace narrowing |
| --- | --- | --- |
| Delegations per turn | `Organization.agentMaxSubagentsPerTurn`, NOT NULL DEFAULT 3, CHECK 0..10 | `TenantSecuritySettings.agentMaxSubagentsPerTurn`, relaxed to nullable (values untouched) |
| Tool calls per turn | `Organization.agentMaxToolCallsPerTurn`, NOT NULL DEFAULT 1, CHECK 1..10 | `TenantSecuritySettings.agentMaxToolCallsPerTurn`, new, nullable, CHECK 1..10 |

The value that applies is `min(ceiling, workspace)`; NULL follows the ceiling;
no organization means the product defaults (3, 1) are the ceiling; an absent
settings row narrows nothing. The defaults are today's behaviour, so nothing
moves on deploy.

```
Organization (ceiling) ─┐
                        ├─ readTurnCaps(tenantId)  ── one query, never throws
TenantSecuritySettings ─┘     │  failed read → 0 delegations, 1 tool call (WARN)
                              ▼
                     resolveTurnCaps (pure, ESM-safe)
                        │                       │
            Flue driver: delegations      Tool Runner, once per segment:
            → bindRun.maxSubagentsPerTurn   lockedParams.tool_choice
              (delegation-gate unchanged)   + TurnCallCounter in each tool's run
```

**Tool Runner enforcement.** `lockedParams` takes the cap: at 1,
`tool_choice` is `{ type: 'auto', disable_parallel_tool_use: true }` byte for
byte; above 1 it is `false`. Dispatch stays serial (the run's `SerialQueue`).
Every tool's `run` — funnel tools and `activate_skill` — charges STEPS, then
asks `admitToolCall()`, which counts the turn's calls in a segment-lived map
keyed `parent:<turn>`. A call past the cap gets a tool error naming the cap and
a FAILED `TOOL_CALL` step, `refused: TOOL_CALLS_PER_TURN_EXCEEDED`, with the
cap in its output; the funnel is never asked and no other allowance is charged.

**Writers.** `usecases/org-agent-turn-caps.ts` is the only writer of the org
columns, behind `PUT /api/org/[orgSlug]/agent-turn-caps`
(`requireOrgPermission('canManageAgentSwitches')`, asked again in the
usecase; `.strict()` body, at least one key), audited
`ORG_AGENT_TURN_CAPS_CHANGED` after commit. The workspace narrows on the
patch-shaped `PUT admin/security-settings`; a value above the organization's
current ceiling is a 400 with `details.reason =
TURN_CAP_ABOVE_ORGANIZATION_CEILING` and the ceiling, and a change writes
`AGENT_TURN_CAPS_CHANGED` beside `SECURITY_SETTINGS_UPDATED`.

**UI.** The org settings page's Agent features section gains a "Per-turn
limits" group (two `NumberStepper`s, each saving its own key; lowering asks
first). The workspace security page gains an "Agent per-turn limits" card:
follow the organization or a lower limit, the value that applies and its
basis, and "narrowed by your organization" when the ceiling binds.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261113120000_org_agent_turn_caps/migration.sql` | enum value, two org columns + CHECKs, the new workspace column + CHECK, the fan-out column relaxed |
| `prisma/schema/auth.prisma`, `enums.prisma` | the columns and `ORG_AGENT_TURN_CAPS_CHANGED` |
| `src/lib/agentic/turn-caps.ts` | pure resolver, ranges, the per-turn admission and its refusal sentence |
| `src/lib/agentic/turn-caps-policy.ts` | `readTurnCaps` (never throws) and `readTurnCapInputs` (throws, for writers); replaces `subagent-fanout-policy.ts` |
| `src/lib/agentic/flue/execute.ts` | binds the resolver's delegation value |
| `src/lib/agentic/tool-runner/{execute,params,tools,skills}.ts` | caps read once per segment; `tool_choice`; the per-turn admission in every tool |
| `src/app-layer/usecases/org-agent-turn-caps.ts`, `src/app/api/org/[orgSlug]/agent-turn-caps/route.ts` | the org writer and its route |
| `src/app-layer/usecases/tenant-security-settings.ts`, `schemas/tenant-security-settings.schemas.ts` | the workspace narrowing, its refusal, its audit event, and the resolved caps on read |
| `src/app/org/[orgSlug]/(app)/settings/OrgAgentSwitchesSection.tsx`, `page.tsx` | the Per-turn limits group |
| `src/app/t/[tenantSlug]/(app)/admin/security/AgentTurnCapsCard.tsx`, `page.tsx` | the workspace card |
| `src/app/org/[orgSlug]/(app)/audit/AuditLogTable.tsx` | the org audit row in words |

## Decisions

- **First deploy only.** The migration relaxes the fan-out column (`DROP NOT
  NULL`, `DROP DEFAULT`) and leaves every stored 3 in place; the existing
  `>= 0` CHECK already admits NULL, so it is the design's "NULL or >= 0" as
  written. The second, data-only migration that sets the stored 3s to NULL is
  NOT in this change; it is merged once this build is live everywhere.
- **Measured, not assumed: what an older client does with the relaxed column.**
  A probe with main's generated client (Prisma 7.10.1) against the migrated
  database showed that it still WRITES 3 on create (it sends the schema's
  default itself, so `DROP DEFAULT` does not reach it) and that a full-row read
  of a NULL in its required `Int` returns `null` rather than throwing. The old
  `readFanOutCap` then reads `null ?? 3`. So a NULL written by the new build
  during the roll does not break an old container; the two-deploy split is kept
  anyway, because the design asked for it and it costs nothing.
- **The second deploy has a question to answer first.** This change adds the
  column's first writer since #3473. Once it is live, a stored 3 is no longer
  certainly the migration's default: a workspace may have saved 3 on purpose,
  and nulling every 3 would erase that choice (it would follow a ceiling the
  organization may later raise). The data migration should null only the 3s no
  `AGENT_TURN_CAPS_CHANGED` row set, or the design should say the loss is
  accepted.
- **A refused call counts nothing.** The per-turn map counts admitted calls, so
  the model's "already made N" is the cap, and a refusal does not push later
  turns over. Each refusal is still one STEPS charge, as every recorded step is.
- **`activate_skill` counts against the tool-call cap** (the design names
  it), and its refusal records no skill name: the name is the model's.
- **The shared loop body and the STEPS charge before every model call
  (owner decision 4) are C's**, with the nested loop that motivates them
  ("3. The nested loop" in the design). B changes neither loop's per-message
  checks.
- **The workspace refusal is a 400 `BAD_REQUEST` with `details.reason`**, the
  codebase's shape for a named refusal, rather than a new error code.
- **`readTurnCapInputs` uses the global client**, as the switches' reader does:
  `Organization` is under org RLS that a workspace admin's tenant context does
  not satisfy, so a tenant-context read would see no organization and report
  the product defaults.
