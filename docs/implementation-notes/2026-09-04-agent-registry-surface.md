# 2026-09-04 — the agent register, stage 2: the surface that makes it load-bearing

**Commit:** `<pending> feat(agentic): the agent register's surface — registration, the gate, and runtime attribution`

Stage 1 (`2026-09-04-agent-registry-schema.md`) landed `RegisteredAgent`, its RLS,
and the minimum write seam. This is the half that makes the register mean
something: a way to author an entry, a gate that consults it, and an invariant
that every runtime record an agent leaves behind resolves back to it.

## The architecture decision, restated with its reasoning

`RegisteredAgent` is a **SIBLING** of `AiSystem` with a **REQUIRED 1:1 link**
(`aiSystemId String` NOT NULL, `@@unique([aiSystemId])`), not a discriminated row
on `AiSystem`. Three independent judges converged on it, having verified the
advocates for both shapes.

- **Migration risk did not decide it.** `AiSystem` holds ZERO production rows
  across 7 tenants, so "the table is already populated" was not an argument in
  either direction. Shape decided it.

- **"Inherits the registry UI for free" is false.** All five columns on the
  AI-system list are EU AI Act semantics — `riskTier` is the Act's tier,
  `classificationClauseId` renders as "Basis", `deploymentRole` renders as
  "Role" — the sole filter is the Act tier, and the detail page is in
  `WAVE_2_DEFERRED` with no tab bar. There was no UI to inherit. Separately,
  `AiSystemRequirementLink` has ZERO read sites in `src/`
  (`framework/coverage.ts` joins `ControlRequirementLink` instead), so the
  per-agent coverage query a later prompt needs has to be written under either
  option.

- **`ownerUserId` settled it.** On `AiSystem` it is `String?` with no
  `@relation`. On a shared table the "required for agent rows" rule could only
  be a partial CHECK, so Prisma would type it `string | null` **forever** — and
  the downstream rule "the second approver must not be the agent's registered
  OWNER" would then read `owner && owner === ctx.userId`, which PASSES when the
  owner is unknown. That fail-open shape already ships in this repo at
  `evidence.ts:534` and twice in `gap-assessment-assignment.ts`. On a sibling it
  is `String` with a real FK and the null is unrepresentable.

- **House precedent agrees.** Discriminators sit on OPERATIONAL tables
  (`Asset.type`, `Task.type`); principals get their own table (`AuditorAccount`,
  `TenantDeviceToken`). This subsystem makes an agent a principal with a kill
  switch, and a kill switch on a row in a regulatory register is a category
  error.

- **The authorization surface.** `POST /api/t/:slug/ai-systems` carries no
  `requirePermission` (only `assertCanWrite`), so extending that table would
  have made a surface any write-capable member can insert into the
  authorization subject for MCP tool exposure.

The link stays REQUIRED so the one real inheritance survives: every agent IS in
the EU register, `ai-system-conformity`'s `riskTier === 'HIGH'` path stays
reachable for agents, and per-agent framework coverage has somewhere to hang.

**OPEN QUESTION, recorded and deliberately not resolved.** Must an agent be
registrable WITHOUT an EU AI Act classification? If yes, `aiSystemId` becomes
optional and this degrades to a plain sibling. Built NOT NULL because with zero
production rows relaxing later is a one-line migration and tightening later is
not.

## Design

```
   operator                                       an agent's credential
      │                                                    │
      ▼                                                    ▼
POST /api/t/:slug/admin/agents                       POST /api/mcp
  requirePermission('admin.agent_registry')            authenticateMcpRequest
      │                                                  1. verifyApiKey
      ▼                                                  2. mcp:* capability
  registerAgent(ctx, input)                              3. assertRegisteredAgent  ◀── the gate
      │  ONE transaction                                        │
      ├─ assertAgentOwner        (ACTIVE membership)            ├─ requireRegisteredAgent?
      ├─ assertVendorInTenant    (cross-tenant FK hole)         ├─ key → agent bound?
      ├─ authorAiSystemEntry     (the real Act classifier)      ├─ agent ACTIVE?
      └─ RegisteredAgentRepository.create  → DRAFT, unscored    └─ else 403 + AUTHZ_DENIED
                                                                       │
                                                            ctx.agentId ▼
                                                   AgentProposal.agentId / WorkflowRun.agentId
                                                   (enforced by local/require-agent-attribution)
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma` | `TenantApiKey.agentId` (composite FK) + `TenantSecuritySettings.requireRegisteredAgent` |
| `prisma/schema/agentic.prisma` | `RegisteredAgent.apiKeys` back-relation |
| `prisma/migrations/20260904160000_agentic_agent_registration_gate/` | the column, the FK, the flag, and the two-part backfill |
| `src/lib/agentic/agent-registration-gate.ts` | the gate: evaluate, enforce, and audit the refusal |
| `src/lib/mcp/auth.ts` | third gate wired after key verification + capability |
| `src/app-layer/usecases/agent-registry.ts` | `registerAgent`, `activateRegisteredAgent`, owner/vendor checks, the retire refusal |
| `src/app-layer/usecases/ai-system.ts` | `authorAiSystemEntry` extracted so both callers share one classifier seam |
| `src/app-layer/schemas/agent-registry.schemas.ts` | `RegisterAgentSchema`, `SetAgentLifecycleSchema`, `AGENT_LIFECYCLE_MOVES` |
| `src/app-layer/usecases/agent-proposals.ts`, `workflow-runs.ts` | both write sites set `agentId` |
| `src/app/api/t/[tenantSlug]/admin/agents/**` | list + register, read/amend/retire, lifecycle |
| `src/lib/permissions.ts`, `src/lib/security/route-permissions.ts` | the `admin.agent_registry` key and its rule |
| `src/app/t/[tenantSlug]/(app)/admin/agents/**` | the register page, its filters, and the registration modal |
| `eslint-rules/rules/require-agent-attribution.js` | the AST rule |
| `src/app-layer/usecases/tenant-security-settings.ts` | the flag becomes operable |

## Decisions

### Retiring an agent with open proposals: REFUSE, not cascade

A PENDING `AgentProposal` is not a record of something that happened. It is a
request that, when a human approves it, runs the REAL create-usecase. So an
agent with a pending queue still has reach into the tenant's data — its
authority outlives the click that retired it. Two ways to close that:

- **Cascade** — reject every pending proposal as a side effect of retirement.
  Rejected. It is a bulk mutation of a HUMAN REVIEW QUEUE performed by a
  lifecycle action, and the reviewer who was mid-decision on one of those
  proposals is never told. "I retired an agent and my review queue emptied" is a
  worse surprise than any error message.

- **Refuse** — name what is in the way and let the operator clear it. Chosen.

The refusal is only tolerable because there is an immediate answer to the
emergency it might otherwise block. `suspendRegisteredAgent` is the kill switch:
it takes effect at the MCP gate on the very next request, it is reversible, and
it carries **no precondition at all**. So the pairing is: SUSPEND stops an agent
now, RETIRE closes its file once its queue is settled. An operator who has to
make it stop is never blocked by this refusal — they are one route away from the
control that actually stops it, which is the one they wanted.

"Open" means `PENDING` only. ACCEPTED / REJECTED / EDITED are decided; they are
history, and history is what the register must keep. Retirement leaves the
proposals in place for the same reason: they are the agent's audit trail.

### The credential binding lives on the KEY, not the agent

`TenantApiKey.agentId`, not `RegisteredAgent.apiKeyId`. Rotation is the ordinary
case: an agent needs a new credential issued while the old one is still
accepted, so the relation has to be many-keys-to-one-agent. A single `apiKeyId`
on the agent would make every rotation a window in which the agent is, by the
gate's own definition, unregistered — and the gate would refuse exactly the
traffic an operator was in the middle of migrating.

Composite FK to `(id, tenantId)`, so a key can never name another tenant's
agent. `ON DELETE RESTRICT`: an agent with live credentials cannot be deleted out
from under them.

### An absent settings row reads as ENFORCING, and the migration is what makes that safe

`TenantSecuritySettings` rows are written lazily — `mfa.ts`,
`tenant-security-settings.ts` and `identity-write-policy.ts` upsert them, and
nothing creates one at tenant creation. So "no row" is the state of every tenant
nobody has configured, **including every tenant created after this shipped**.
Reading it as "off" would make the documented default (new tenants ON) true only
of tenants whose admin had happened to open a settings page.

That same rule is what forces the second half of the backfill. An existing tenant
with no settings row would read as ENFORCING the moment this deployed, and its
running integrations would start getting 403s. So the migration does two things,
and the second is not tidiness:

1. sets every EXISTING settings row to `false`;
2. INSERTs a row, also `false`, for every tenant that had none.

Without (2) the column default does the opposite of what (1) was written to
achieve, for precisely the tenants nobody has configured — the quiet ones, which
is the worst population to break.

The flag is named positively (`requireRegisteredAgent`) rather than inverted
(`allowUnregisteredAgents`). The inverted spelling gives the same absence
semantics for free, but every read site then has to negate it, and a negated flag
read under pressure is how a kill switch gets inverted.

### The two unknowns fail in opposite directions, on purpose

- An absent settings row → ENFORCING (above).
- An unknown or non-ACTIVE agent status → REFUSED. DRAFT is not a usable state
  (an agent arrives unscored), SUSPENDED is the kill switch, RETIRED is the end
  of its life. Only ACTIVE passes, and a soft-deleted row passes nothing.

### The refusal writes `AUTHZ_DENIED`, the same action `requirePermission` writes

Not a new vocabulary. It is the same class of event, and a security reviewer
filtering the trail for denied access should not have to know that agents have
their own word for it. The `detailsJson` carries `gate: 'agent_registration'` and
a `reason` — `no_agent_binding` / `agent_not_found` / `agent_not_active` — because
"nobody registered this key" and "the kill switch is down" need opposite operator
responses. The row names the CREDENTIAL in `entityId`, because that is what an
operator has to bind or revoke; when there is no agent, that absence is the
finding.

The write is best-effort and the throw happens regardless: an audit outage must
not turn a refusal into an admission. That is how `requirePermission` handles its
own denial row.

This repo has been here before, which is why the integration test asserts the
ROW and not the status code. The legacy `requireAdminCtx` helpers threw a 403 and
wrote nothing, and the whole of Epic D.3 was undoing that. A test that checked
only the 403 would pass against a gate with the same defect.

### Runtime attribution is an ESLint rule, not a regex

`AgentProposal.agentId` and `WorkflowRun.agentId` are NULLABLE — they had to be
(added to populated tables in the transaction that back-filled them), and a
human-started workflow run genuinely has no agent. So the type system cannot ask
for the field. `local/require-agent-attribution` asks instead.

It demands the field is **named**, not that it is non-null. `agentId: null` for a
human-started run is the correct value, and a rule that refused it would push
writers toward inventing an agent to satisfy the linter — the exact failure it
exists to prevent. What it refuses is silence: a write site that never considered
attribution, whose row is then indistinguishable from a pre-register one.

A rule rather than a `tests/guards` regex because the check is syntax, and per
`eslint-rules/README.md` an AST rule survives renaming, reformatting, comment
edits and helper extraction where a regex survives none of them. It needs more
than a `no-restricted-syntax` selector because it has to find the `data` property
and then inspect its members.

A top-level or `data`-level spread is accepted, and that is a real hole. Following
a spread to its source is cross-statement data flow this rule does not do, and
flagging every spread would make it unusable in the repository layer.
`tests/guards/agent-runtime-records-resolve-to-registry.test.ts` covers the gap
the way ESLint cannot: it runs the rule over the population **git** defines, with
a planted-violation proof that the detector fires and a paired negative that it
stays quiet on the shape the real seams use. A parse failure in that sweep
THROWS rather than returning zero violations — espree cannot read a type
annotation, so without that every TypeScript file would "lint clean" by failing
to be read at all.

### `admin.agent_registry` is its own permission key

Not `admin.manage`. An ACTIVE row in this register is what lets a credential
through the `/api/mcp` gate, so the key is the authority to decide which
autonomous agents may act inside the tenant. Folding it into the general admin
flag would have made that decision a side effect of holding any admin authority.
OWNER and ADMIN hold it; it is deliberately NOT one of the two OWNER-only flags,
because those are about the tenant's own existence and its owners, and an agent
register is neither.

It is NOT split view/manage the way the DSAR pair is. There is a real case for an
AUDITOR reading the register — it is the inventory an audit asks for — and the
split is the obvious next move. It is left undone rather than guessed at: a
`_view` flag nobody grants is indistinguishable from one nobody needed.

### Registration authors the register entry rather than taking one

`registerAgent` runs `classifyAiSystem` from `@/lib/eu-ai-act/classification` —
the deterministic classifier authored from Regulation (EU) 2024/1689 — over the
operator's Art 5 / Annex III / Art 50 answers, and links the obligations that
tier pulls in. `RegisterAgentSchema` has **no field for a tier**, so a client
cannot state one.

`authorAiSystemEntry` was extracted from `createAiSystem` and takes an ALREADY
OPEN transaction rather than opening its own. That is the point: two
`runInTenantContext` calls would be two transactions, and a failure between them
would leave an orphan AI system in the register — a fabricated entry, which is
the thing running the real classifier was supposed to prevent.

### The two ids the foreign key would have accepted

Both are usecase checks because the DATABASE cannot own them, and both produce a
row that reads as entirely legitimate:

- `ownerUserId` is a plain FK to the GLOBAL `User` table, so the constraint
  accepts another tenant's user. The register would then say an agent is owned by
  somebody who is not a member, cannot see it, and will never act on it — and
  that column is what the downstream two-person rule compares against.
- `vendorId` is a plain FK too, and **Postgres runs FK checks as the table
  owner**, so RLS does not stop a cross-tenant supplier being named as
  accountable for an agent. The read that would expose it is then hidden by the
  same RLS that failed to prevent it.

The owner check reuses `assertOwnerInTenant` from `vendor-link-targets.ts` rather
than growing a fourth copy of the same ACTIVE-membership lookup.

### Existing MCP suites were opted out, not worked around

Three integration suites (`mcp-propose`, `mcp-read-suite`, `mcp-server`) create
fresh tenants and mint bare keys, so the new default made them enforcing. Each
now writes `requireRegisteredAgent: false` in its seed with a comment saying why.
That is the honest reading: those fixtures predate the register and test a
different property. Loosening the default to make them pass would have been the
alternative, and it would have shipped the feature switched off.
