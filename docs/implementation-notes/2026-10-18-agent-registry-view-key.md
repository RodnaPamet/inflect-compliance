# 2026-10-18 — A view key for the agent inventory, and the run's input in the Flue prompt (#3710)

**Commit:** _(this PR)_ `feat(agentic): admin.agent_registry_view and the run's input in the Flue prompt (1d-reach)`

The reach half of step `1d` (#3668 / #3709). Step `1d` declared the two IAM
skills on `discovered-agent-review` and added `get_discovered_agent`, and a real
Flue run still could not read the agent it names: the model never saw the run's
input, and no key could reach the tool. The owner decided on 2026-10-18 to add a
view key, and widened it the same day (while reviewing `AI_ADMIN`, #3699) to
cover reading agent runs, proposals and the governance pack.

## Design

```
                       admin.agent_registry_view  (read-only; OWNER ADMIN AI_ADMIN AUDITOR)
                                  │
    inventory read ── mayReadAgentInventory = view OR agent_registry
       register list / row · harness scans · matrix · discovered-agent facts · pack
    activity read ─── mayReadAgentActivity  = admin.view OR view
       /agents/runs · /agents/runs/[id] · /agents/proposals · run stream · checkpoint
    every write ───── admin.agent_registry (unchanged), + evidence.edit to file the pack
                                  │
   bearer token ── admin:agent_registry_view ── the ONLY scope; * and admin:* do not carry it
                                  │
   agent key ─ mcp:read ─ grant (agent_tool_exposure) ─ named scope ─ principal holds view
             └─▶ get_discovered_agent ─▶ facts (THIRD_PARTY_INGESTED) ─▶ Flue run

   Flue: getRunRow ─▶ openDeclaredRunInput (sealed context, verified; requiredInput only)
                    ─▶ baseClean → neutralizeUntrustedText ─▶ fenced, labelled agent.run-input
                    ─▶ runMessage ─▶ dispatched AND digested (one binding)
```

The edge pre-filter admits an AUDITOR to a GET of the four inventory API routes
(`AUDITOR_ADMIN_READ_PATHS`), because the agent detail page's Overview tab reads
its row from the browser. Everything else under `/admin` still refuses AUDITOR.

## Files

| File | Role |
|---|---|
| `src/lib/permissions.ts` | The key, its holders, `mayReadAgentInventory`, `mayReadAgentActivity` |
| `src/lib/auth/api-key-auth.ts` | The `admin:agent_registry_view` scope, `WILDCARD_EXCLUDED_ACTIONS`, `*` subtraction, `ScopeCheckAction` |
| `src/lib/auth/guard.ts`, `src/middleware.ts` | `AUDITOR_ADMIN_READ_PATHS`, `AGENT_ADMIN_API_STATIC_SEGMENTS`, the method-aware AUDITOR branch |
| `src/app-layer/usecases/agent-registry.ts`, `agent-harness-{scans,matrix,facts}.ts` | The inventory reads; the matrix offers no accept action without the register key, and the scanner-key view stays on it |
| `src/app-layer/usecases/agent-governance-pack-export.ts` | Filing stays on the register key and `evidence.edit` |
| `src/app/api/t/[tenantSlug]/admin/agents/{route,[agentId]/route,harness-scans/route,reports/route}.ts` | GET takes view OR register; writes unchanged |
| `src/app/api/t/[tenantSlug]/agent-runs/[id]/{stream,checkpoint}/route.ts` | `admin.view` OR view |
| `src/lib/security/route-permissions.ts` | The declarative rules, above the register catch-all |
| `src/lib/mcp/tools/harness-tools.ts`, `src/lib/mcp/tools/types.ts` | The tool's key and named resource scope |
| `src/app/t/[tenantSlug]/(app)/agents/**`, `SidebarNav.tsx`, `admin/api-keys/page.tsx` | Page gates, per-surface write affordances, menu gates, the picker |
| `src/lib/agentic/flue/run-message.ts`, `execute.ts` | The run's declared input in the prompt |
| `src/lib/agentic/content-provenance.ts` | `agent.run-input`; `handlingFor` |
| `docs/agentic-harness-scanner-dpia.md`, `docs/data-retention.md`, `docs/agentic-iam-roadmap.md` | The DPIA names the model as a reader; the Art 12 summary is DSAR-relevant for the review; the key table |

## Decisions

- **`*` and `admin:*` do not carry the view key.** The governance flags are
  subtracted from `*` because they are self-modification; the view key writes
  nothing, so that is not the reason here. The reason is that every key already
  issued would start reading the inventory, owner references included, on the
  deploy that added the key, and nobody minting them decided that. Excluding it
  from `*` alone would have been cosmetic — `admin:*` is a wildcard too — so the
  exclusion is a named list (`WILDCARD_EXCLUDED_ACTIONS`) that both
  `scopesToPermissions` and `enforceApiKeyScope` read. The change is additive for
  every existing key, and the DPIA's reader is a key minted for the read.
- **Every inventory read admits the register key too.** A custom role saved
  before the key existed takes it from its base role, which is false on a
  READER or EDITOR base. The activity read admits `admin.view` for the same
  reason: nobody who read runs or proposals before loses them.
- **Filing the pack stays on the register key.** Reading it moved; filing writes
  a permanent Evidence row, and the view key grants no write. AUDITOR and
  AI_ADMIN lack `evidence.edit` either way, so they read the pack and file
  nothing. Moving the export route would only have widened it for a custom role
  holding the view key and `evidence.edit` without the register key, at the cost
  of the invariant the hardening checklist asks for.
- **The edge admits AUDITOR to four GETs.** Without it the agent detail page's
  Overview tab, which fetches its row from the browser, would be refused at the
  edge for the role the key was made for. Exact templates, GET and HEAD only,
  and `[agentId]` excludes the static siblings by name, pinned to the
  filesystem. The handler stays the authority.
- **The tool names a named resource scope.** `admin:read` is `admin.view`, the
  admin console; requiring it would have made an agent key hold the console to
  read one discovered agent. `ScopeAction` admits `agent_registry_view`, and the
  read-suite guardrail admits a named group only when every flag it grants is a
  `_view`.
- **The matrix offers no shortfall action to a view-only reader.** The accept
  usecase refuses a caller without the register key before it asks whose agent
  it is, so an affordance computed for them would be shown and refused.
- **Only declared input reaches the prompt, and only from a verified context.**
  A definition with no `requiredInput` never opens the context, so its message
  and its decision digest are byte for byte what they were. The input is already
  scanned at admission (`guardUntrustedInput`); here it is cleaned before it is
  neutralised (NFKC can create a reserved token), fenced in the risk-assessment
  markers and followed by the same data-only rule a tool result carries.
- **A value too long to carry whole refuses the run.** A truncated identifier is
  a different identifier, and a run asked to review the wrong agent is worse
  than one refused by name.
- **The DPIA's transfer is closed by naming it, not by a code gate.** On an
  `EXTERNAL` residency tenant a Flue run sends the owner reference to the
  external model provider. The owner decided (2026-10-18) that naming that data
  on the provider's existing row in `docs/sub-processors.md` is enough, with no
  separate notice window and no gate in the read tool, so condition 12 is met by
  that row rather than by a residency check in code. A gate that redacted
  `ownerRef` for external residency was the alternative, and was declined.
- **The view key does not reach the canvas review or AGENT campaign subjects.**
  The checkpoint route admits it, so its declared authority matches the
  proposals page it mirrors, but the processes canvas still offers the review on
  `admin.view`. An `AGENT` campaign's subjects stay narrowed to the reviewer and
  the register key, as 0e decided; widening either is its own decision.
