# Enabling the Flue engine

**Status:** DONE once for `inflect-ltd-mo94mi34` on 2026-09-24. Every code-side
gate is satisfiable; what remains is operational.

> **Six terms select the ENGINE. A seventh makes the agent able to DO anything.**
> Tool access is deny-by-default (`RegisteredAgentTool`), and no wiring term
> covers it. Measured: the first production run had all six terms green, ran on
> the Flue engine, was handed an empty tool catalogue, called nothing, produced
> no summary — and settled `COMPLETED` with `stepFailures: 0`. In the runs list
> that is indistinguishable from a posture review that worked. See step 7.

A Flue run happens only when **six** independent terms agree. Five are
configuration; the sixth is the workflow definition, and it was the one nobody
could see. Each term can only ever NARROW — none of them grants — so the order
below is the order in which to satisfy them, and any one left unset means every
run executes on the static engine, successfully and silently.

## The six terms

| # | Term | Where it lives | Who sets it |
|---|------|----------------|-------------|
| 1 | `AGENT_DRIVER_FLUE` | deployment env | operator |
| 2 | `TenantSecuritySettings.agentDriver = 'FLUE'` | per tenant | tenant admin |
| 3 | `DRIVER_IMPLEMENTED.flue` | the build | already `true` |
| 4 | a `WorkflowDefinition` with `driver: 'flue'` | the registry | already shipped: `posture-review` |
| 5 | an **ACTIVE, risk-assessed** `RegisteredAgent` | the register | tenant admin |
| 6 | an **API key bound to that agent** | `ApiKey.agentId` | tenant admin |

Terms 1–4 are ANDed by `resolveAgentDriver` and `selectRunDriver`. Terms 5 and
6 are a separate gate in `startWorkflowRun`, and they are the two that are easy
to miss.

## Term 6 is the one that surprises people

`startWorkflowRun` refuses a Flue run whose caller is not `vouched`:

    flue_requires_registered_agent

`evaluateAgentRegistration` resolves the agent from **`ctx.agentId`**, and a
browser session has none. So **a Flue run cannot be started from the runs page
by a human admin**, however the other five terms are set — the refusal is
unconditional and does not honour the tenant's `requireRegisteredAgent` toggle,
because a Flue run is an autonomous loop that chooses its own tool calls.

The caller must be an API key whose `ApiKey.agentId` names an ACTIVE registered
agent. `verifyApiKey` copies that column onto the context
(`src/lib/auth/api-key-auth.ts`), and `POST /api/t/:slug/agent-runs` accepts
bearer API keys through `getTenantCtx`. A STATIC run has no such requirement
and still starts from the page.

## Steps

### 0. Drill the kill switch first

`runKillSwitchDrillJob({ tenantId })`, with the tenant named EXPLICITLY.

The nightly 06:00 UTC sweep DISCOVERS tenants that have a non-placeholder
`RegisteredAgent`, so a deployment whose only register row is a legacy
placeholder is drilled every night and drills nobody: `AgentKillSwitchDrill`
had **0 rows** here despite the job running since it shipped, with no failure
and no Finding. Passing the tenant bypasses discovery; the target is a canary
that resolves to no registered agent, so no production agent is stopped.

Do it BEFORE activation, while nothing holds authority. A PASSED row records
`scopesHonoured={AGENT,TENANT,PLATFORM}`, `toolCallsAfterKill=0` and
`boundaryRefusalReason=agent_killed` — check those, not just the outcome.

### 1. Register the agent

Admin UI: **`/t/<slug>/admin/agents`** → Register agent.
API: `POST /api/t/<slug>/admin/agents` (`admin.agent_registry`).

`registerAgent` writes the `RegisteredAgent` **and** its EU AI Act `AiSystem`
entry in one transaction — the Act tier is classified from the operator's
Art 5 / Annex III / Art 50 answers and is never accepted from the client. The
agent arrives `DRAFT` with `riskTier = null`.

### 2. Risk-assess it

Admin UI: the agent's detail page → risk assessment.
API: `GET` / `PUT /api/t/<slug>/admin/agents/<agentId>/risk-assessment`.

Twenty IMDA questions across four dimensions; `PUT` upserts one answer at a
time and is idempotent. Completing it writes `riskTier`.

**These answers are judgements about the agent and belong to whoever is
accountable for it.** An `UNSCORED` tier maps to `DENY_CEILING`, so a
half-assessed agent is refused every tool at the boundary.

### 3. Activate it

Admin UI: the agent's detail page → status → Active.
API: `POST /api/t/<slug>/admin/agents/<agentId>/status`.

`activateRegisteredAgent` refuses with a 409 if `riskTier` is null:

> This agent has not been risk-assessed. […] an unassessed agent is refused
> every tool at the boundary anyway, so activating it would put a row in the
> register that cannot act.

### 4. Mint an API key bound to the agent

The binding lives on the KEY, not the agent, so rotation is a normal
many-keys-to-one-agent operation rather than a window in which the agent is
unregistered. Optionally set `maxAutonomyLevel` to narrow further — the
effective ceiling is `min(key, agent)`, and a key can only narrow.

### 4b. GRANT THE AGENT ITS TOOLS — the step the six terms do not cover

`grantAgentTool(ctx, agentId, { toolName })`, or the agent's Tools tab.

Deny-by-default: an agent with no grants is handed an empty catalogue and its
runs complete having read nothing. Grant exactly what the workflow declares
and no more — for `posture-review` that is `get_compliance_posture`,
`list_evidence_expiring`, `list_findings`, `list_tasks`.

`assertGrantWithinTier` and `assertGrantWithinDeclaredDataScope` refuse a grant
incoherent with the agent's tier or declared scope, so a refusal here is
information about the register rather than a failure.

### 5. Turn the tenant's driver toggle to FLUE

Admin UI: agent settings.
API: `POST /api/t/<slug>/admin/agent-driver` with the mode.

### 6. Set `AGENT_DRIVER_FLUE` on the deployment

Operator action, process-wide.

## Verifying before you commit to it

The agent settings page reports what a run would ACTUALLY execute on, and
names the term that narrowed it. Since #2844 the vocabulary covers all four
configuration terms, so an operator who has done 1–5 but not 6 sees
`ENV_DISABLED` rather than a chip claiming `flue` is in force.

Start with `posture-review`. It is READ-ONLY by design — no PROPOSE step, so
the first runs on an engine that has never executed in production cannot queue
a proposal, let alone commit one.

## A Flue run's conclusion is NOT on the run row, and that is deliberate

`WorkflowRun.summary` stays NULL for a Flue run. The static engine fills it
from its SYNTHESIS step; the Flue engine does not, and copying the text there
would be a **defect, not a fix**.

The model's free text is deliberately NOT egress-scanned, and what makes that
safe is a claim about where it can go: exactly one destination, the Art 12
`AiDecisionLog.outputSummary`, which `logAiDecision` sanitises and bounds to
500 characters. `WorkflowRun.summary` is rendered on the runs list and gets
none of that treatment. `tests/guards/flue-model-output-has-one-destination.test.ts`
exists to refuse the second sink.

So to read what a run concluded, read the decision log for that run —
`sessionRef` is the run id, and the settled text is on the LAST turn's row
(earlier turns carry `outputSummary: NULL` on purpose, so no row claims to
have produced the whole answer).

## What to watch on the first run

- `flue-driver: starting a run on the Flue engine` — logged at **WARN**
  deliberately, so the first production runs are not something an operator has
  to go looking for.
- `WorkflowRun.errorMessage` carries a one-sentence refusal for every Flue
  start refusal (`driver-plan.ts`), including residency ones — a LOCAL_ONLY
  workspace with no local gateway configured is refused rather than sent
  outside its boundary.
