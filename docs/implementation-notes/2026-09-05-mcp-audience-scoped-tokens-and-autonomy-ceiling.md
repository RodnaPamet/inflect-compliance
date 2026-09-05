# 2026-09-05 — Audience-scoped MCP tokens, the autonomy ceiling, and revocation at the tool boundary

**Commit:** _(this change)_ — Epic Agentic 2, stage 2 of 2. Subpoints 2, 3 and 6
of the authority-model PR. Stage 1 (per-invocation authorization, deny-by-default
tool exposure, one audit row per denial) is
[`2026-09-04-mcp-per-invocation-authorization.md`](2026-09-04-mcp-per-invocation-authorization.md)
and is not restated here — read it first; this note only covers what it left open.

## What was left open, and what each gap actually was

Stage 1 made every tool call ask *"may the human this credential speaks for do
this?"*. Three things it did not ask:

- **What is this credential FOR?** `TenantApiKey` is a long-lived bearer token
  with no audience. A key minted so an agent could call `list_risks` is, byte for
  byte, a key that calls `propose_controls`, reads every MCP resource, and works
  against any MCP server that trusts this tenant's keys. Ambient authority with
  no audience is the confused deputy's supply line: whatever the agent is talked
  into doing, the credential in its hand is already sufficient for.
- **How far may this AGENT go?** `RegisteredAgent.autonomyLevel` existed and
  nothing read it. So an agent's authority travelled entirely with whoever held
  one of its keys, and a credential minted for a narrow read-only integration was
  indistinguishable at the tool boundary from the one the operator meant to be
  autonomous.
- **Is the credential still live RIGHT NOW?** Revocation was checked at
  authentication only. The workflow engine resolves ONE `McpInvocation` and then
  executes many steps on it, so a key revoked mid-run kept its authority to the
  end of the run. The comment in `workflow-runs.ts` defended this — *"a revoke
  lands on the next run, which is the same freshness a direct tool call gets
  between requests"* — which is the defect stated as a design: a run is exactly
  where the two differ, because a run keeps executing after the operator has
  acted.

## Design

### The funnel, after this change

`authorizeToolCall` in `src/lib/mcp/authorize.ts` is still the one gate. It now
runs eight steps, and the order is load-bearing:

```
1. AUDIENCE    was this token minted FOR this tool?        (in-memory)
2. LIVENESS    is the credential live right now?           (one indexed read, uncached)
3. EXPOSURE    is the tool on the agent's allowlist?       (in-memory)
4. AUTONOMY    is the rung within min(key, agent)?         (in-memory)
5. CAPABILITY  does the credential carry mcp:propose?
6. SCOPE       does the credential carry risks:read?
7. PERMISSION  may the PRINCIPAL do this? (assertPermission)
8. POLICY      the shared assertCanRead / assertCanWrite
```

Steps 1–6 are configuration questions and their refusals name a thing the caller
can fix; 7–8 are the authority question and refuse generically. Two placements
are deliberate:

- **LIVENESS at 2, not later.** It is the only term whose ANSWER CHANGES DURING A
  RUN — everything else was settled when the invocation was assembled — so it has
  to be re-asked, and asking it early means a revoked credential learns nothing
  about grants or ceilings on its way out. It is also the check an operator
  reaches for in an incident: "revoke the key" has to mean the next tool call.
- **EXPOSURE and AUTONOMY adjacent at 3–4.** Both are REGISTER facts. Grouping
  them keeps the reading "is this credential pointed at the right target and
  still valid → does the register allow this agent this reach → is the credential
  scoped for it → may the principal".

### Which gate each tool reuses

Unchanged from stage 1 and reproduced here only because the question is asked
directly. Every tool declares its gate as DATA (`authorize`), and the funnel is
the only thing that enforces it; an ESLint rule plus
`tests/guards/mcp-tools-use-shared-authz.test.ts` refuse a tool that performs its
own check or forgets to declare one.

| tool | keys / policy | basis | mirrors |
| --- | --- | --- | --- |
| `get_compliance_posture` | `controls.view` | effective | `GET /dashboard/executive` |
| `get_tenant_context` | `controls.view` | effective | `GET /dashboard` |
| `list_risks` | `risks.view` | effective | `GET /risks` |
| `list_controls` | `controls.view` | effective | `GET /controls` |
| `search_controls` | `controls.view` | effective | `GET /search` (control hits) |
| `find_coverage_gaps` | `frameworks.view` | effective | `GET /frameworks/coverage` |
| `get_framework_status` | `frameworks.view` | effective | `GET /frameworks` |
| `list_evidence_expiring` | `evidence.view` | effective | `GET /evidence` |
| `list_findings` | `audits.view` + `read` policy | effective | `GET /findings` |
| `list_tasks` | `tasks.view` | effective | `GET /tasks` |
| `propose_risks` | `risks.create` | principal | `POST /risks` |
| `propose_controls` | `controls.create` | principal | `POST /controls` |
| `draft_policy` | `policies.create` | principal | `POST /policies` |
| `propose_finding` | `audits.view` + `write` policy | principal | `POST /findings` |

**The tools with no clean human equivalent, and the gate chosen for each.**
Every tool names a real route, so none is ungated — but three cases are not a
one-to-one mirror and the choice is worth recording:

- **`get_compliance_posture` / `get_tenant_context`.** Their payloads span six or
  seven domains while the nearest human route is one dashboard endpoint. Gating
  on `controls.view` alone would hand a controls-scoped agent the risk, evidence,
  policy, task and vendor sections. The answer is not a wider gate — it is
  per-domain REDACTION (`redact` / `redactRows`), applied in the funnel after the
  usecase runs, so the CALL is gated at the dashboard's own key and the PAYLOAD is
  cut down to what the principal may see. Gating the call and returning only what
  the caller may read are different claims, and the second one is where the data
  actually leaves.
- **`list_findings` / `propose_finding`.** `PermissionSet` has no `findings.*`
  key, so the human routes gate on `getTenantCtx` + `assertCanRead` /
  `assertCanWrite`. The tools declare `policy: 'read' | 'write'` and the funnel
  calls the SAME shared assertion — rather than inventing a findings key that
  would exist only for agents and could drift from the route.
- **The MCP RESOURCES surface** (`inflect://frameworks`, `…/requirements`) has no
  route of its own at all; it is grounding context assembled from the frameworks
  usecases. It is covered under "the second door" below.

### The second door: resources

`/api/mcp` has two doors — `tools/call` and `resources/read` — and only one of
them was fully gated. Resources were protected by `enforceApiKeyScope` ALONE: a
throw that wrote no `AUTHZ_DENIED` row, applied no allowlist and consulted no
ceiling. Both doors now enter through `authorizeResourceRead`, so a resource
refusal audits exactly like a tool refusal and the audience, liveness and
autonomy checks apply there too. The scope refusal is audited as well.

The deny-by-default EXPOSURE allowlist is deliberately still NOT applied to
resources, and the reason is that there is nothing for it to name:
`RegisteredAgentTool` rows name tools from the grantable catalogue, resources
have no entries in it, and inventing a parallel grant vocabulary is a register
change rather than a gate change. Recorded rather than papered over — a resource
read is scope-gated, audience-gated, ceiling-gated and audited, but not
allowlisted.

### Token audience design (RFC 8693)

`POST /api/mcp/token` takes a long-lived key as the SUBJECT TOKEN and returns a
short-lived `ifxt_…` ACCESS TOKEN scoped to a named audience.

```
payload = base64url({ v, tid, kid, aid, aud[], res, iat, exp, jti })
token   = "ifxt_" + payload + "." + base64url(HMAC-SHA256(k, payload))
k       = HKDF(DATA_ENCRYPTION_KEY, "inflect-mcp-token-exchange-v1")
```

Five properties, and how each is made true rather than asserted:

1. **Audience-bound.** `aud` is inside the signed payload, so the holder cannot
   edit it — a swapped audience fails the SIGNATURE, not merely the comparison.
   `authorizeToolCall` compares the tool it is about to run against it.
2. **Narrowing only.** Requested audiences are intersected with the agent's tool
   grants AT MINT TIME, so exchange can never widen what deny-by-default exposure
   already allows. A token for an ungranted tool is refused at issue — with the
   same `tool_not_granted` audit row a call would have written.
3. **Server-bound.** `res` pins `urn:inflect:mcp`; a token is not replayable
   against another MCP server even if that server shared this signing key.
4. **Short-lived, on an INJECTED CLOCK.** 5 minutes by default, 15 maximum. Every
   expiry comparison — mint, verify, and the per-call re-check in the funnel —
   reads a `now()` the caller supplies. A test that cannot control the clock
   cannot prove an expiry inside a 300-second window without sleeping, so in
   practice it stops testing the expiry at all.
5. **No upstream token is ever forwarded.** `mintExchangedToken` takes IDS, not a
   token. It is structurally unable to embed, echo or forward the subject token
   because it never receives one — the route verifies the subject token and
   passes what it LEARNED. Re-exchange is refused for the same reason: a token
   minted for `list_risks` cannot be traded for `list_controls`.

An exchanged token is accepted at `/api/mcp` and NOWHERE ELSE. `getTenantCtx`'s
API-key path recognises `iflk_` only, so an `ifxt_` at `/api/t/**` is a 401 — a
credential minted for one MCP tool is not a credential for the REST surface
either. It also means a workflow run cannot be STARTED with an exchanged token,
so orchestration has no way to launder a narrow audience into a wide one.

**Stateless, on purpose.** A token table would give revocation for free, and it is
not needed: the token names its issuing key, and per-key revocation is re-checked
at every tool boundary anyway, so the table would be a second revocation
mechanism answering a question the first already answers on the same request.
What it WOULD add is a tenant-scoped model, RLS policies, a retention
classification and a growth surface for tokens that live five minutes. Nothing
reversible is persisted, so there is no token at rest to encrypt; the signing key
is HKDF-derived from the master KEK under its own purpose string and is never
stored.

### The autonomy ceiling

`effective = min(TenantApiKey.maxAutonomyLevel, RegisteredAgent.autonomyLevel)`,
computed once per invocation in `buildMcpInvocation` and checked per tool call
against the rung the tool's class requires (read 1, propose 2, orchestrate 3; a
tool may override with `authorize.autonomy`).

A key can only NARROW. That direction is the whole point: it makes the authority
a property of the AGENT rather than of the bearer, so "what may this agent do"
stops depending on which of its keys somebody is holding. A ceiling above the
agent's own level is refused at key CREATION rather than clamped at runtime — the
runtime `min` would make a stored 6 harmless, but the register is where an
operator reads an agent's authority off, and a number there that is not the
effective one is a register that misinforms.

**The two nulls in this subsystem mean opposite things, and that is the trap:**

| null | meaning | fail direction |
| --- | --- | --- |
| `TenantApiKey.maxAutonomyLevel` | no key-level narrowing | contributes no term; the agent term still bounds it |
| `RegisteredAgent.riskTier` | UNSCORED | **DENY** — an agent nobody has assessed is the one that should not be running |

An absent NARROWING is not an absent ASSESSMENT. Both are stated together in
`src/lib/agentic/autonomy-ceiling.ts` rather than in two files that never meet.

### The 3/10 seam

3/10 introduces the operational risk scorer, and the scored `riskTier` will cap
how far an agent may be driven. That cap composes as one more term inside the
same `min`. The seam is `ceilingForRiskTier(tier)`:

- it already encodes **NULL ⇒ `DENY_CEILING`**, and is unit-tested for it, so
  3/10 inherits the decision rather than re-making it. Mapping an unscored agent
  to "LOW" would be the exact inversion — the least-assessed agent getting the
  friendliest treatment, with nothing downstream looking wrong;
- `DENY_CEILING` is `-1`, BELOW `AUTONOMY_MIN`, so a comparison written as
  `required <= ceiling` cannot let a rung-0 tool through a deny;
- every SCORED tier returns `UNCLAMPED` today, because the tier→rung table is
  3/10's decision to make, not this commit's;
- it is deliberately **not wired** into the live call site. Every agent in every
  register is currently unscored — `createRegisteredAgent` leaves the tier NULL
  on purpose — so folding it in before the scorer ships would take the entire MCP
  surface dark for every tenant. That is a product outage, not a control. The
  call site passes `RISK_TIER_CEILING_UNWIRED` and says so; 3/10 replaces that
  one argument with `ceilingForRiskTier(agent.riskTier)` and nothing else moves.

The composition is nonetheless proved, in both a unit and an integration test:
the same arithmetic the funnel runs, with the tier term folded in, refuses an
agent the live ceiling admits.

### Revocation at the tool boundary

`checkCredentialLiveness` re-reads `(id, tenantId)` on every tool call, uncached.
The uncached read IS the feature: everything else on the invocation was settled
when it was assembled, and caching this — even for the length of one execution —
reintroduces exactly the window the subpoint exists to close.

It lives in `src/lib/agentic/`, not beside the funnel that calls it, because
`tests/guardrails/mcp-server-coverage.test.ts` refuses ANY Prisma import under
`src/lib/mcp/`. That guard is deliberately blunt and being blunt is most of its
value; an exception carved for a good reason is an exception the next reader has
to evaluate.

**Why the test is a spy and not a status code.** A status-code assertion cannot
distinguish "checked at the tool boundary" from "checked at dispatch" — both
refuse the next REQUEST. So the property is stated as *no further tool executed*:
a three-step workflow, `jest.spyOn(listRisksTool, 'run')`, the key revoked from
inside the first step, and an assertion that the spy was called exactly once.

Note the deliberate NON-symmetry recorded in `mcp-denial-audits.test.ts`: a key
revoked BEFORE a request is refused at authentication with a 401 and writes NO
tool-level row. There must not be one — adding a second row for the same refusal
is precisely the inflated signal that suite's one-row bracket exists to prevent.

## Files

| file | role |
| --- | --- |
| `src/lib/mcp/token-exchange.ts` | NEW. Mint / verify / audience-match, all on an injected clock. |
| `src/lib/agentic/autonomy-ceiling.ts` | NEW. The ceiling algebra, the per-class rungs, and the 3/10 seam. |
| `src/lib/agentic/agent-credential-state.ts` | NEW. The uncached per-call liveness read. |
| `src/app/api/mcp/token/route.ts` | NEW. The RFC 8693 endpoint; `API_KEY_CREATE_LIMIT`, not the mutation tier. |
| `src/app-layer/schemas/mcp-token-exchange.schemas.ts` | NEW. RFC field names; `actor_token` refused rather than ignored. |
| `src/lib/mcp/authorize.ts` | Audience, liveness and autonomy steps; `authorizeResourceRead`; three new denial reasons. |
| `src/lib/mcp/auth.ts` | Accepts `ifxt_` tokens; `exchangeMcpToken`; threads the audience, ceiling and clock onto the invocation. |
| `src/lib/mcp/resources.ts` | Enters through the shared gate; its scope refusal now audits. |
| `src/lib/auth/api-key-auth.ts` | `verifyApiKey` and the new `resolveApiKeyById` share one liveness tail. |
| `src/lib/agentic/agent-registration-gate.ts` | The verdict carries `autonomyLevel`, read from the row it already loads. |
| `src/app-layer/usecases/api-keys.ts` | `maxAutonomyLevel` on create (validated against the agent); `listAgentCredentials`. |
| `src/app-layer/usecases/workflow-runs.ts` | Comment corrected: the settled terms are per-execution, revocation is per call. |
| `src/app/t/[tenantSlug]/(app)/admin/mcp/page.tsx` | The credential panel — state and EFFECTIVE ceiling. |
| `prisma/migrations/20260905090000_agent_key_max_autonomy/` | The column, its range CHECK, and the requires-an-agent CHECK. |

## Decisions

- **Stateless tokens over a token table.** Argued above. The deciding factor was
  that the table's one advantage — revocation — is already delivered by the
  per-call liveness re-read on the same request, so it would have been a second
  mechanism for one question.
- **The audience is checked BEFORE exposure.** A token presented at the wrong tool
  is a fact about the request itself, independent of who the agent is or what it
  is granted, so refusing it first leaks nothing about grants.
- **`null` and `[]` audiences are kept distinct.** `null` is "raw key, no
  narrowing" — the pre-exchange behaviour every existing integration relies on.
  `[]` is refused at mint. Collapsing them makes the check a formality in
  whichever direction you collapse them.
- **The autonomy rung comes from the tool's CLASS, with a per-tool override,
  rather than a required field on all fourteen tools.** The class is already
  declared data, and fourteen hand-written copies of `1` are fourteen chances to
  write `6`. An unrecognised class resolves to the HIGHEST rung, so a capability
  added without a default is refused to low-autonomy agents rather than admitted
  to all of them.
- **A key ceiling above its agent is refused, not clamped.** See the ceiling
  section: the stored number and the effective number have to be the same thing.
- **`maxAutonomyLevel` requires an agent binding, enforced by a CHECK
  constraint.** A ceiling with no agent term to be the lower of would read as the
  whole of the authority rather than a narrowing of it — the exact state the
  column exists to end — so it is unrepresentable rather than discouraged. Same
  principle as `provenance = 'THIRD_PARTY' ⇒ vendor` on `RegisteredAgent`.
- **The `capabilityClass` passed to the funnel is separate from `capability`.**
  `capability` is a CREDENTIAL check and read tools deliberately carry none (the
  endpoint gate already accepted `mcp:read` OR `mcp:propose`, and re-checking
  would newly refuse propose-only keys the read tools they can call today).
  Deriving the autonomy class from it would have made every read tool resolve to
  the orchestrate rung.
- **`mcp-denial-audits` seeds its subject agent at rung 2 now, and a rung-1
  sibling beside it.** An agent registered below the rung a propose tool needs
  trips the autonomy gate first and masks every refusal that suite is actually
  about. The rung-1 case is tested on purpose rather than as a fixture side
  effect.
- **No migration for `AgentRiskTier`, and no backfill for `maxAutonomyLevel`.**
  Writing a plausible ceiling onto existing keys would invent an operator decision
  nobody made, and the value would then look deliberate.
