# 2026-11-01 — Agent oversight settings

**Commit:** see the pull request that adds this note.

## Design

Round 15's help guides for the agent pages found three gaps that were the
owner's to decide: a person could compose a change to an outside system and
approve it themselves (#4895), one person could propose and approve an
exact-value saved-parameter change (#4900), and Auditors held the inventory view
key but were refused the AI decision log, receipts and quarantine (#4896–#4898).
The owner chose to make each an Owner setting rather than fix one answer in
code.

Five boolean columns on `TenantSecuritySettings`, with one module as their only
writer:

```
Admin → AI features (Owner)  ──PUT /admin/agent-oversight──▶  setAgentOversightSettings
                                                               (tenant_lifecycle, a person)
                         readAgentOversightSettings ◀──────────┘
          ┌────────────────────┼─────────────────────────┐
 approveAgentProposal   approveParameterChange   mayReadOversightSurface
 (composer refused)     (exact-edit proposer     (decisions / receipts /
                         refused when on)          quarantine; register key
                                                   or view key + switch)
```

`AgentProposal.composedByUserId` records who composed a request, written only by
`external-write-compose.ts`.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261101170000_agent_oversight_settings/` | Five settings columns and `AgentProposal.composedByUserId`, all additive |
| `src/app-layer/usecases/agent-oversight-settings.ts` | Read, write, audit, and the one read rule for the three surfaces |
| `src/app/api/t/[tenantSlug]/admin/agent-oversight/route.ts` | Owner GET/PUT |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/AgentOversightSection.tsx` | The five switches on Admin → AI features |
| `src/app-layer/usecases/agent-proposals.ts` | `assertNotComposer` in the single approve path |
| `src/app-layer/usecases/external-tool-parameters.ts` | The exact-value proposer refusal |
| `ai-decision-log.ts`, `agent-action-receipt.ts`, `agent-proposals.ts` (quarantine) | Each read asks the rule |
| `src/lib/auth/guard.ts` | `AUDITOR_ADMIN_READ_PATHS` gains the quarantine read |
| decisions / receipts / quarantine pages, `AgentsViewsMenu` | Gate and menu entries follow `oversightReadsFor` |

## Decisions

- **Defaults keep today's behaviour except one.** The composer rule is on by
  default because the compose page already promised "somebody else approves it";
  every other switch is off, matching the access and rule each replaced.
  Composed requests written before the column existed have no composer and are
  not refused.
- **A rejection by the composer is allowed.** It withdraws a request nobody has
  acted on, so it needs no second person.
- **The read switches widen, never narrow.** The register key reads all three
  surfaces whatever the switches say; a switch can only admit the view key. So a
  misconfigured switch cannot lock an Admin out.
- **The rule lives in the usecases, and the routes ask a key that admits the
  view key.** The quarantine route's literal `requirePermission` moved from the
  register key to the view key so an Auditor can reach the usecase, which then
  refuses with an `AUTHZ_DENIED` row unless the switch is on. The edge allowlist
  gains that one exact path for the same reason.
- **The receipts API narrows.** It asked only `assertCanRead`, so every member
  could list and export receipts; it now follows the page (owner decision on
  #4897).
- **Refusals before a write transaction.** The exact-value refusal is asked
  before the approval's transaction so its audit row is not rolled back with it,
  and asked again inside against the row being approved.
