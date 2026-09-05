# 2026-09-04 — MCP per-invocation authorization and deny-by-default tool exposure

**Commit:** _(this change)_ — Epic Agentic 2, stage 1 of 2. Subpoints 1, 4 and 5
of the authority-model PR; short-lived audience-scoped tokens (2), the
maximum-autonomy binding (3) and per-key revocation surfaced in `/admin/mcp` (6)
land on top of this.

## The defect

`verifyApiKey` builds a `RequestContext` whose `role` and `appPermissions` come
from the KEY'S SCOPES ALONE:

```ts
const appPermissions = scopesToPermissions(scopes);
const role = hasAdminScope ? 'ADMIN' : hasWriteScope ? 'EDITOR' : 'READER';
```

`apiKey.createdById` names the human the credential speaks for, and nothing
consulted their membership. Three consequences, all of them live:

- A key minted with `risks:write` by a **READER** resolved to `EDITOR` with
  `risks.create: true` — authority its principal never held.
- A key whose creator was later **DEACTIVATED or REMOVED** kept its full original
  reach. Offboarding a person did not offboard the agents acting for them.
- `createAgentProposal` makes **no policy assertion at all**, so a key with
  `mcp:propose` + `risks:read` could queue a risk proposal for a principal who
  cannot create a risk — and a human approver, seeing a legitimate-looking
  pending item, then creates it on their behalf. Propose-not-commit means the
  agent cannot commit; it never meant the agent could propose anything it liked.

Reads were worse than writes, because reads are where the data leaves and the
propose queue at least had a human in front of it. A `controls:read` key could
call `get_compliance_posture` and receive the risk, evidence, policy, task and
vendor sections of the executive payload, because the tool's gate covered one
domain and its payload covered seven.

## Design

### 1. Authority is an intersection — `src/lib/agentic/agent-authority.ts`

`resolveAgentAuthority` resolves the principal through **`resolveTenantContext`,
the same resolver `getTenantCtx` runs for a signed-in human**. That is
deliberate: the membership check, the DEACTIVATED / REMOVED refusals, the
soft-deleted-tenant refusal and the custom-role permission hydration are the ones
the product already ships, not a second copy that can drift.

It returns two views, because the credential's authority genuinely is two things:

| view | what it is | who uses it |
| --- | --- | --- |
| `ctx.appPermissions` | principal ∧ credential-scope, field by field | every read tool, and everything downstream that reads `ctx.appPermissions` |
| `principal.appPermissions` | the human's own set, unintersected | propose tools only |

The second exists because **the credential scope vocabulary has no verb for
"may propose"**. A propose key carries `mcp:propose` plus a domain READ scope and
deliberately no `<domain>:write`, since propose-not-commit means the credential
must be unable to write the entity directly. Checking `risks.create` against the
intersection would therefore deny every propose call ever made. The credential's
authority to propose is `mcp:propose` (enforced by `enforceMcpCapability`) plus
the domain read scope (`enforceApiKeyScope`); the principal's is `risks.create`.
Each tool names its basis, and the guard pins that every propose tool uses
`principal` and every read tool uses `effective` — getting either backwards is
silent, one denying everything and the other over-granting.

Two details in the arithmetic that a plausible implementation gets wrong:

- `intersectPermissionSets` builds its output from `PERMISSION_SCHEMA`, not by
  walking one input's keys. A set missing a domain must contribute **deny** for
  it; walking `a`'s keys would drop the domain entirely, and an absent key reads
  as "not restricted" to every consumer checking `?.[action] === true`.
- `intersectPermissions` is a field-by-field AND, **not**
  `computePermissions(lowerRole(a, b))`. `canAudit` is `role === 'AUDITOR' ||
  level >= 4`, so the lower of AUDITOR and EDITOR is AUDITOR, which grants an
  audit flag EDITOR does not hold. The conjunction cannot invent a flag; the
  role-ladder shortcut can.

**Fail direction.** A principal that no longer resolves is a refusal, not a
fallback to the key's own scopes. This is a real behaviour change for an existing
key whose creator has been offboarded: it stops working, with a `principal_*`
reason in the audit row naming the credential to rebind. The alternative — keep
serving it — is the whole defect.

### 2. One gate, reused — `src/lib/mcp/authorize.ts`

`requirePermission` was a route wrapper: resolve a context from `params` + `req`,
then decide. The decision is now `assertPermission` in
`src/lib/security/permission-middleware.ts`, and `requirePermission` calls it.
The MCP funnel calls the same function. There is no second decision to drift.

`authorizeToolCall` runs five steps, cheapest and least-revealing first, and
**credential checks before principal checks**:

1. exposure — is this tool on the agent's allowlist?
2. capability — does the credential carry `mcp:propose`? (propose tools)
3. resource scope — does the credential carry `risks:read`?
4. permission — `assertPermission` against the basis the tool names
5. policy — the shared `assertCanRead` / `assertCanWrite` the mirrored route
   applies, where `PermissionSet` has no key to name

The ordering is load-bearing. Steps 1-3 are configuration: a key scoped for
controls calling a risks tool is an integration that needs a wider key, and its
refusal should say "scope", by name. Steps 4-5 are the authority question, and a
refusal there means the human this agent speaks for genuinely may not. Reversed,
every under-scoped integration would surface as a generic "Permission denied" and
the trail would fill with rows that look like an agent exceeding its authority
when it was pointed at the wrong tool. That signal is the point of subpoint 5;
burying it in routine misconfiguration is how it stops being read.

**Where each tool's gate came from.** Every tool names the human route it
mirrors, and the guard refuses an empty `mirrors`:

| tool | gate | human equivalent |
| --- | --- | --- |
| `list_risks` | `risks.view` | `GET /risks` — `requirePermission('risks.view')` |
| `list_controls`, `search_controls`, `get_tenant_context`, `get_compliance_posture` | `controls.view` | `GET /controls` — `requirePermission('controls.view')` |
| `list_tasks` | `tasks.view` | `GET /tasks` — `requirePermission('tasks.view')` |
| `list_evidence_expiring` | `evidence.view` | `GET /evidence` — `getTenantCtx` + `assertCanRead` |
| `find_coverage_gaps`, `get_framework_status` | `frameworks.view` | `computeCoverage` — `assertCanViewFrameworks` |
| `list_findings` | `audits.view` + `assertCanRead` | `GET /findings` — `getTenantCtx` + `assertCanRead` |
| `propose_risks` / `propose_controls` / `draft_policy` | `risks.create` / `controls.create` / `policies.create` | the matching `POST`, all `requirePermission` |
| `propose_finding` | `audits.view` + `assertCanWrite` | `POST /findings` — `getTenantCtx` + `assertCanWrite` |

Two of those are judgement calls worth stating.

`search_controls` is backed by `getUnifiedSearch`, whose human route gates on a
read check across every entity type. The tool surfaces ONLY control hits, so the
narrower key for the one domain it exposes is the honest gate, not the union the
search route needs.

Findings have **no `findings` domain in `PermissionSet`** — they are audit-domain
artefacts, which is why the existing resource scope is already `audits:read`. The
tempting `audits.manage` is WRONG: an EDITOR holds `audits.manage: false` and can
create a finding through the human API, so the tool would refuse a proposal its
principal could commit. The honest gate is the domain key that exists plus the
shared policy the route actually applies. Adding a `findings.*` domain is the
right fix and is deliberately not smuggled in here — it changes what every
existing custom role resolves to.

### 3. The read case: gating the call is not enough

A `controls.view` check lets `get_compliance_posture` through, and the payload
then carries six more domains. So the tools declare projections and the funnel
applies them against the effective context
(`src/lib/mcp/tools/dashboard-redaction.ts`):

- **section redaction** — `riskBySeverity`, `stats.risks`, `evidenceExpiry`,
  `policySummary`, `vendorSummary` … each falls away with its domain key. The
  result carries a `redactedDomains` list so an agent knows it is reading a
  partial answer rather than a tenant with no risks. Absent, not zero: a zero
  would be a lie the agent reasons over.
- **row redaction** — `recentActivity` interleaves every domain in one array, so
  a section rule cannot express it. Each row is filtered by
  `AuditLog.entity` → domain key. An entity not in that map keeps its row, which
  is a decision: the feed also carries memberships, settings and audit
  housekeeping with no domain of their own, and dropping the unrecognised would
  empty the feed rather than filter it.

`controls.view` and `controlCoverage` are deliberately absent from the rules — it
is the tool's own gate, so a context that reaches the payload holds it, and a
rule that can never fire misleads its next reader.

### 4. Deny-by-default tool exposure — `RegisteredAgentTool`

A join table, not a `String[]` on `RegisteredAgent`, for three reasons that each
cost something later: an array has nowhere to record who granted a tool and when;
revoking from an array is a read-modify-write, so two concurrent revokes lose
one; and the composite `(agentId, tenantId)` FK — which makes a cross-tenant
grant unrepresentable rather than merely unlikely — cannot be expressed from
inside one.

`toolName` is a plain `String`, not an enum: a tool is code that ships with a
deploy, and an `ALTER TYPE` mid-rolling-deploy is the failure the
`@@map("WorkItem*")` pins already record. The usecase validates against the live
catalogue instead, and a grant for a tool later REMOVED is inert rather than an
FK error — the right direction, since nothing can call a tool that is gone.

`onDelete: CASCADE`, where `AgentProposal`'s equivalent FK is `RESTRICT`. A
proposal is HISTORY and must outlive the agent that made it; a grant is
AUTHORITY and must not.

**No backfill.** Granting every existing agent every tool would have made the
feature a no-op on the only tenants that have agents — a control shipped switched
off. It is affordable because the register itself is two migrations old.

**Where the allowlist does not apply, and why that is not a hole.** The list is a
property of an AGENT. A credential bound to no agent has no list, and there are
two ways to be in that state: the tenant enforces the register (the default), in
which case `assertRegisteredAgent` already refused the request; or the tenant has
explicitly turned the register OFF, in which case it has opted out wholesale and
the credential is gated by its scopes and its principal exactly as before.
Applying an empty allowlist to the second case would mean *turning the register
off turns MCP off* — the composition failure this branch's own third commit had
to undo once, where two individually correct defaults met to produce a third
behaviour neither intended.

`tools/list` is filtered to what the caller could actually call. Not a security
property — the funnel refuses either way — but a correctness one: an agent plans
against the catalogue, and advertising tools that 403 turns ordinary planning
into a stream of `AUTHZ_DENIED` rows, burying the signal they exist for.

### 5. Every denial is exactly one hash-chained row

`AUTHZ_DENIED`, the same action `requirePermission` writes, because it is the
same class of event. The permission branch writes it inside `assertPermission`
(`entity: 'Permission'`, key in `entityId` — identical to a denied human route);
every other branch writes it through `denyToolCall` (`entity: 'McpTool'`) or,
for an unresolved principal, `denyUnresolvedPrincipal` (`entity:
'TenantApiKey'` — the credential is what an operator acts on).

**Exactly one, and the count matters in both directions.** Zero means the denial
is invisible, which is what `enforceApiKeyScope`, `enforceMcpCapability` and a
bare `assertCanRead` inside a usecase all did before today. Two means the same
refusal is counted twice, and a signal that inflates is one an operator learns to
discount — the threshold gets raised and the next real one is under it.

The 403 body never echoes a permission key; `mcp-denial-audits.test.ts` checks
that over every refusal the surface can produce, not one of them.

### The `*` scope no longer grants agent governance

`scopesToPermissions(['*'])` returned `getPermissionsForRole('ADMIN')`, and ADMIN
holds `admin.agent_registry` and (now) `admin.agent_tool_exposure`. So a `*` key
**carried by an agent** could have activated its own registration and granted
itself every tool — and a deny-by-default allowlist its own subject can widen is
not an allowlist. Both flags are now denied to `*` explicitly, joining
`tenant_lifecycle` and `owner_management` as actions no bearer token performs.

The asymmetry with `compliance_dsar_manage` and `reports.schedule_external`,
which `*` still grants, is deliberate and stated in the module: those are
privileged operations on DATA; these two are authority over which principals may
act, which is a different kind of thing to hand a token. There is no production
automation to break — the register is two migrations old and unmerged.

### Permission key

`admin.agent_tool_exposure`, separate from `admin.agent_registry`. The register
decides WHETHER an agent may act — a binary set once and reviewed at audit time.
Tool exposure decides WHAT it may reach, and moves whenever somebody wires up an
automation. Folded together, every routine "let it read tasks too" would carry
the authority to activate an agent nobody had scored. The narrower key is also
the delegable one.

Its `ROUTE_PERMISSIONS` rule must sit **above** the generic
`admin/agents(/.*)?` entry — matching is first-wins, and reversed the separate
key would be present in the type and enforced nowhere.

## Files

| file | role |
| --- | --- |
| `src/lib/agentic/agent-authority.ts` | principal resolution + the intersection; the seam 3/10's riskTier cap plugs into |
| `src/lib/agentic/agent-tool-exposure.ts` | the deny-by-default allowlist read, fresh per request |
| `src/lib/mcp/authorize.ts` | the five-step gate, the one denial writer, the two redaction passes |
| `src/lib/mcp/auth.ts` | resolves authority + exposure, returns the `McpInvocation` every tool runs on |
| `src/lib/mcp/tools/types.ts` | the `authorize` / `redact` / `redactRows` contract |
| `src/lib/mcp/tools/dashboard-redaction.ts` | which dashboard sections and activity rows belong to which domain |
| `src/lib/mcp/tool-catalogue.ts` | leaf list of tool names, so an admin route need not import the tool graph |
| `src/lib/security/permission-middleware.ts` | `assertPermission` extracted so both callers share one decision |
| `src/app-layer/usecases/agent-tool-exposure.ts` | grant / revoke / list, audited |
| `src/app-layer/repositories/RegisteredAgentToolRepository.ts` | tenant-filtered queries |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/tools/route.ts` | the privileged grant surface |
| `prisma/migrations/20260904190000_agent_tool_exposure/` | table, composite FK, RLS triple, no backfill |

## Decisions

- **The principal is `TenantApiKey.createdById`, not `RegisteredAgent.ownerUserId`.**
  The owner is the accountable human for the agent's BEHAVIOUR; the creator is
  whose authority the credential borrows, and it is already what every audit row
  attributes to. Conflating them would make retiring a key's creator and
  reassigning an agent's owner the same operation, which they are not.
- **Resolution is once per HTTP request, enforcement once per tool call.** A
  JSON-RPC batch can carry many `tools/call`s; the principal's membership cannot
  change between them, but each tool's gate runs on its own.
- **Resources (`inflect://frameworks`) were not brought into the allowlist.**
  They already run `enforceApiKeyScope` plus `assertCanViewFrameworks`, which the
  intersected context now makes principal-bound — a real improvement with no code
  change. Extending deny-by-default to resources is the obvious next move and is
  left undone rather than guessed at.
- **The grant surface is the API only; there is no UI yet.** Deny-by-default
  means a registered agent reaches nothing until somebody grants it, and today
  that is `POST /api/t/:slug/admin/agents/:agentId/tools` per tool. That is
  deliberate for this stage rather than an oversight — the `/admin/mcp` surfacing
  is subpoint 6, landing with per-key revocation in the same place — but it is a
  real operability gap in the interim, and the denial audit row names the tool
  the agent wanted so an operator can act on it without guessing.
- **Three existing MCP suites gained a `TenantMembership` for the user their keys
  were minted by.** Those fixtures created a key for a user who was not a member
  at all, which used to work. The membership is what the fixture was always
  implying, and needing to add it is the change working.
