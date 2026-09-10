# 2026-09-10 — Suspension is a boundary control, and `requireRegisteredAgent: false` never said otherwise

**Commit:** `eb4d82a19` fix(mcp): a suspended agent governs, so its own controls apply again — issue #2399

`evaluateAgentRegistration` returned `agentId: null` for three different
situations — no agent bound, a bound id that resolves to nothing, and an agent
that exists but is not ACTIVE — and in a non-enforcing tenant it returned
`reason: null` for all three as well. Every consumer read the absent id as an
absent narrowing term, which is correct for one of those populations and is
allow-all for the other two. So suspending an agent did not merely fail to stop
it: it *widened* the credential.

This note records three things that the diff itself cannot: what the opt-out
flag actually promises, which `null`-keyed relaxations at the agent boundary
were examined and deliberately left alone, and the one asymmetry that was
flagged rather than settled.

---

## What `requireRegisteredAgent: false` promises

**A credential bound to NO registered agent is admitted, and is gated by its
scopes and its principal's permissions exactly as it was before the register
existed.**

That is the whole promise, and it is one sentence about one population. Every
argument in this codebase for `null`-means-no-term was written about it:
`agent-tool-exposure.ts:12-28`, `autonomy-ceiling.ts:114-142`,
`auth.ts:331-333`, `authorize.ts:171-175`. The failure it defends against is
**"turning the register off turns MCP off"** — the #2288 composition failure,
where two individually correct defaults met and produced a third behaviour
neither intended. That defence stands and must not be weakened.

**What it does not promise.** It never promised that the register's own
per-agent controls are inert. **Six** situations reached the same code as "bound
to no agent" and only one of them is: the other five are a bound id that names
no live row, a DRAFT agent, a SUSPENDED agent, a RETIRED agent, and a status
this build does not recognise. (The audits counted four, because
`unknown_status` had no name until `eb4d82a19` gave it one; it belongs in the
count, and it governs.) Reading `null` as "no narrowing" is right for the
population the sentence names and wrong for a stopped agent, because the agent
exists, was granted tools, was scored, was given a card — and then somebody
deliberately stopped it.

**What #2399 changed, precisely.** For a workspace that has turned the agent
register off, suspending an agent now refuses its credentials' **tool calls**,
and applies its autonomy ceiling, its policy card, its circuit breaker and its
agent-scoped kill switch again. Before, suspension recorded the state and
*widened* the credential: the tool allowlist, both autonomy terms, the policy
card, the breaker and the AGENT arm of the kill switch all dropped away at once.
`DRAFT` and `RETIRED` are unchanged. **Reading the framework catalogue and this
workspace's framework coverage is not refused, and neither is anything on the
REST surface — the register has never gated that.** A run already under way is
unaffected: this changes invocation assembly, not an in-flight run.

**Who is affected.** Only a workspace holding a `TenantApiKey` whose `agentId`
names an agent that is currently SUSPENDED. Three facts bound that population,
and all three are establishable from source without a database:

- `TenantApiKey.agentId` was added nullable with **no backfill**
  (`prisma/migrations/20260904160000_agentic_agent_registration_gate/migration.sql:51`
  adds the column; the migration's only two data statements are the
  `requireRegisteredAgent = false` update and the settings-row insert at 68 and
  72).
- `createApiKey` refuses to bind a key to a non-ACTIVE agent
  (`usecases/api-keys.ts:236-251`), and `agentId` is written **only** at
  creation (`api-keys.ts:267-276`). No update, rotate or revoke path writes it,
  so the binding is effectively write-once.
- The legacy-placeholder backfill lands its synthetic row at SUSPENDED
  (`20260904120000_agentic_agent_registry/migration.sql:262-287`) but its only
  two `UPDATE`s are `AgentProposal.agentId` and `WorkflowRun.agentId` (293, 299)
  — never a key binding. It could not have written one: that migration predates
  the column by one ordinal.

So the affected population is exactly: **keys minted against an ACTIVE agent
whose agent an operator later suspended.** It is not "every tenant older than
the register", even though the migration backfilled `requireRegisteredAgent =
false` for all of them. A workspace that never bound a key to an agent sees no
change at all.

**Why this is not the switch doubling as a kill switch.** Four reasons, in the
order they matter:

1. The promise's own scope is a credential *bound to no agent*. A key naming a
   suspended agent **is** bound; the widening existed only because the gate lied
   about that.
2. The product already constrains non-enforcing tenants from the register,
   today, with no flag check: `createApiKey` refuses to mint a key against a
   suspended agent (`api-keys.ts:236-251`), on the reasoning that it is "a
   configuration error worth failing loudly at creation rather than at first
   use". Nobody called that a kill switch for the product. That justification
   was *false* for a non-enforcing tenant when it was written; #2399 makes it
   true — **for SUSPENDED**. The comment at `api-keys.ts:244-246` names
   "SUSPENDED or RETIRED"; the RETIRED half stays false in a non-enforcing
   tenant after this fix. See the open question below.
3. The feared failure is a tenant-wide dark. This touches only agents an
   operator deliberately stopped, one row at a time, and never a key bound to
   nothing.
4. Today's behaviour is not neutrality, it is inversion. Suspending an ACTIVE
   agent made it *more* autonomous than any registered agent can ever be — the
   `min` collapsed to `UNCLAMPED`, which is `AUTONOMY_MAX = 6`
   (`autonomy-ceiling.ts:46-57`), above LOW's cap of 4 and CRITICAL's of 1
   (`MAX_AUTONOMY_BY_TIER`, `agent-risk-scoring.ts:381-386`). No reading of
   "unaffected" endorses that.

**What the fix still does not close, and the copy rule that follows.** The fix
denies **tools**. It does not close the resources door: a suspended agent that
is scored, unkilled, unlatched and inside its card can still read
`inflect://frameworks` and per-framework coverage — total, mapped, unmapped,
`coveragePercent` and the full `bySection` breakdown (`mcp/resources.ts:97-118`).
The exposure allowlist is deliberately not applied on that door, because there
is nothing to apply: `RegisteredAgentTool` rows name catalogue tools and
resources have no entries in it (`authorize.ts:828-833`). The restored ceiling
narrows it only for an **unscored** agent: `read` requires rung 1
(`AUTONOMY_REQUIRED_BY_CAPABILITY`, `autonomy-ceiling.ts:75-79`) and CRITICAL
caps at 1, so no *scored* tier is refused there, while a null tier resolves to
`DENY_CEILING` and is.

So: **never write "deny-all", "refused everything", or "stopped".** Write *every
tool call is refused; the resources door still serves the framework catalogue
and this workspace's framework coverage; the REST surface is unchanged; a run
already under way is not affected.*

**The decision rule, for the next question of this shape.** When a verdict is
consumed as an *authority-assembly input* and not only as a refusal decision,
its **shape** is load-bearing and every distinct situation needs its own name on
it. A `null` that means "no term" is safe only while every population it covers
genuinely has no term. Enumerate the populations, in the comment, by count — and
when the count changes, the comment is the diff.

---

## Every null-keyed relaxation at the agent boundary, and its verdict

The point of this table is not the list. It is that the next reader can tell
which entries were **examined and deliberately left alone** from those nobody
looked at. An entry in section A is a decision; the absence of an entry is not.

Line numbers for `agent-registration-gate.ts`, `mcp/auth.ts`, `mcp/authorize.ts`
and `mcp/resources.ts` are **post-`eb4d82a19`** — the commit moved them. Every
other citation is against the same file as it stands today.

### A. Correct, argued, and deliberately unchanged

| site | the null | why it stands |
|---|---|---|
| `agentic/agent-registration-gate.ts:95-101` (and the header at 16-27) | absent `TenantSecuritySettings` → ENFORCING | TIGHTENS. The two-step migration (`docs/implementation-notes/2026-09-04-agent-registry-surface.md:144-163`) is what makes it safe. **Do not touch.** |
| `agentic/autonomy-ceiling.ts:108-111` | null/unrecognised tier → `DENY_CEILING` | TIGHTENS, pinned by `tests/unit/agent-autonomy-ceiling.test.ts`. It is also what made the suspended case so visibly wrong: the same subsystem denied an unscored agent everything and handed a stopped one rung 6. |
| `agentic/policy-card-store.ts:97-101`; `agentic/policy-card.ts:286-293` | missing version row → `DENY_EVERYTHING`; unknown rung → refuse; unreadable caps → 0 | TIGHTENS. The house style this fix matches. |
| `agentic/approval-tiering.ts:128-152, 217-230` | `agentNamed` beside a nullable `agent` | TIGHTENS. **The precedent this fix pays forward** — a flag beside the id, not a sentinel inside it. |
| `mcp/tool-manifest.ts:196-208` | no pin → trust-on-first-use, not refused | Independent of caller identity: about the TOOL, not the agent. Survives unchanged. |
| `mcp/authorize.ts:565-567` (`assertAudience`); `mcp/token-exchange.ts:168-176` | a `null` audience is "unscoped", an empty one is refused at mint | Kept apart deliberately. Not an agent-keyed term. |
| `mcp/authorize.ts:1128-1134` (empty `authorize.keys` skips step 9); `mcp/authorize.ts:1218-1224` (`keyOf → null` keeps the row) | two unrelated nulls in the tail of the funnel | Both fenced: `tests/guards/mcp-tools-use-shared-authz.test.ts` requires keys OR a policy, and the redaction null is argued at `mcp/tools/types.ts:120-127`. Neither depends on agent identity. |
| `lib/auth/api-key-auth.ts:292-315` | a request with no api key skips `enforceApiKeyScope` | A session context is checked at steps 9/10 against the human's own permissions. The key term is *absent*, not narrow, and there is no key to bound. |
| `lib/auth/api-key-auth.ts:524-547` | the principal intersection applies only to agent-bound keys | Reads `apiKey.agentId`, not the verdict, so a suspended agent's key **stays** narrowed to its principal. One of the few terms suspension never dropped, and explicitly out of scope at 524-527. |
| `mcp/authorize.ts:828-833` | the resources door applies no exposure allowlist | Argued and correct: `RegisteredAgentTool` names catalogue tools, resources have no entries. **This is why the fix's copy must not say "deny-all".** |
| `mcp/auth.ts` — the resources audience skips the grant check in `exchangeMcpToken` | a suspended agent can still mint an `ifxt_` token for `MCP_RESOURCES_AUDIENCE` | Consistent with the row above and correct on its own terms. **Leave it** — and make sure no copy claims a suspended agent can mint nothing. |

### B. Same class as #2399 — an argument written for one situation silently covering a second

Everything marked FIXED is in `eb4d82a19`. Everything marked FILE SEPARATELY is
a real item that is deliberately not in this diff, with the reason it is not.

| site | the stretched argument | disposition |
|---|---|---|
| `agent-registration-gate.ts` — three situations, four identical nulls, `reason: enforcing ? … : null` | The header argued fail directions *for the enforcing path*. Nothing was written about what the verdict's SHAPE means to a non-enforcing caller. `AgentGateVerdict.agentId`'s own docstring ("when it resolved to a live ACTIVE one") **was** the collapse. | **FIXED — the root.** `AgentGateStanding` names all seven situations and is set unconditionally; `governedAgentIdOf` (`agent-registration-gate.ts:300-312`, a `switch` with no `default` so an eighth standing is a compile error) is the only place the SUSPENDED-only rule is spelled, and `subjectAgentId`'s docstring at 124-129 says so in the type. |
| `mcp/authorize.ts` step 4 — `grantedTools === null` → allow-all | `agent-tool-exposure.ts:14-22`: "exactly two ways to be in that state". There are **seven**, and `evaluateAgentRegistration` produces all of them. "A credential bound to no agent has no list to consult" is false for a suspended agent: it *is* bound and its rows exist. | **FIXED** — #2399's stated site. `grantedTools` now has three answers: a Set, an EMPTY Set (governs, not vouched), `null` (no governed agent). `isToolExposed` needed no change; an empty set already denied. |
| `mcp/auth.ts:331-348` — the mechanical producer of that null | The comment restated the two-population argument for code that produced null for five. | **FIXED**, and the three answers are enumerated in the comment. |
| `agentic/autonomy-ceiling.ts:139-142` — `riskTierCeilingFor(null)` → `UNCLAMPED` | "THE THIRD NULL" (114-138) names three populations; a stopped agent is a fourth, and for it "there is no agent, so nothing to have assessed" is **false**. | **FIXED via `governedAgentId`** (`auth.ts:396-401`). `riskTierCeilingFor` itself is **not** edited — it is correct for the three populations it names. |
| `agentic/autonomy-ceiling.ts:22-27` — "the AGENT term is always present for an agent-bound credential, so the result is still bounded" | Not merely uncovered — **falsified**. Suspension made both agent terms absent while the credential stayed bound. | **FIXED in the code.** The header sentence still needs correcting; see the cross-links below. |
| `mcp/auth.ts` — the policy card is not loaded | "A card that does not exist must never read as a card that forbids everything" is about an agent with **no** card. This is the inverse: the artefact exists, was authored, and was silently not applied. | **FIXED.** On the resources door it is the only remaining narrowing term for a scored agent. Two consequences accepted deliberately: `reserveDailyAction` now writes for a suspended agent's resource reads, and the metric sites below had to move. |
| `mcp/authorize.ts:976-977` — the breaker is skipped for a null agent | The `null`-is-not-a-refusal argument is about a null **latch** (an unobserved agent). This line returns before any latch is read. The breaker's own promise — *"'stopped' has to mean stopped or the word is doing no work"* — was proven only for a non-null `agentId`. | **FIXED.** `tests/unit/agent-circuit-breaker-gate.test.ts` gained the companion case: a SUSPENDED agent DOES read the latch. |
| `agentic/kill-switch.ts:201` via `mcp/authorize.ts:470, 529` — the AGENT arm cannot match | "Deliberately still covered by the TENANT and PLATFORM arms" is about a credential with **no binding**. It has nothing to say about a credential bound to an agent that has its own kill row. `("agentId" IS NULL OR "agentId" = $2)` with a NULL `$2` yields only the TENANT and PLATFORM arms. | **FIXED.** The worst of the siblings in incident terms: no `agent_killed` row was written, so the operator's own stop control left no evidence it fired — while `AgentKillSwitchAction.tsx` tells operators that kill-then-suspend is a normal sequence. |
| `mcp/authorize.ts:1061-1078` — `tool_not_granted` reused for a suspended agent | The file's own header and `assertAutonomy` both argue that a refusal naming the wrong term IS the defect. An operator sent to a grant list that is intact edits the wrong record. | **FIXED.** `agent_suspended` is its own `McpDenialReason`, with its own message and `extra: { standing }`. |
| `mcp/authorize.ts:754-759, 772` — `no_agent` / `'unattributed'` | The metric's own docstring argues against folding two populations; the code folded in a third — and 772 becomes actively wrong once the card is loaded. | **FIXED.** Both now key off `governedAgentId`. |
| `mcp/authorize.ts:1166` — no ledger write for a null agent | Correct for a human or an unbound key; for a stopped agent it disabled the input to the control that watches it. | **FIXED.** Moot on the tool door now that tools are refused, but the read and write halves of the breaker must not drift. |
| `mcp/auth.ts` + `startWorkflowRun` / `resumeWorkflowRun` — the engine discards the verdict | "The engine's own route has already decided whether the caller may start a run" names a decision **no route makes**: `startWorkflowRun` checks `mcp:orchestrate` or `assertCanWrite`, `resumeWorkflowRun` checks only `assertCanWrite`. | **CLOSED HERE BY CONSTRUCTION**, because the discriminator is unconditional and `buildMcpInvocation` is shared. Whether those routes should *refuse* is a **separate PR** — that is a new 403 for enforcing tenants. |
| `usecases/workflow-runs.ts:158` vs the card load in `mcp/auth.ts` | Not argued anywhere. The run row pinned a card version from `ctx.agentId` while the funnel loaded the card from `verdict.agentId`, so a run started by a suspended agent recorded "opened under card version N" in a write-once, hash-chained column and then executed with no card. | **CLOSED HERE as a side effect** — the card is now loaded from the governed id, so the pin and the enforcement finally agree. The only evidence-integrity item in this list. |
| `agent-tool-exposure.ts:12-28`, `autonomy-ceiling.ts:22-27` and `114-138`, `authorize.ts:171-175`, `auth.ts:331-333`, `authorize.ts:750-759`, `api-keys.ts:244-246`, `services/agent-risk-applicability.ts:73-79` | Eight spellings of one null, four of them incomplete enumerations. `api-keys.ts:244-246`'s justification was **false today** and the fix makes half of it true. | **COMMENTS ONLY — and they are the mechanism by which this defect class propagated.** Leaving them is leaving the next instance loaded. Note: `agent-risk-applicability.ts` **does** exist as of `ea9ca5bc6`, contrary to the audit note that placed it on a feature branch only; its ASI02 reader is a live consumer and its "grantedTools is null ⇒ TRUE for every tool" paragraph is falsified for a suspended agent. |
| `mcp/auth.ts:109-112` — `enforceMcpCapability` returns for a session ctx | "MCP is API-key only, but be defensive" is stale: the engine reaches `authorizeToolCall` with session contexts. Net effect is bounded by steps 9/10. | **FILE SEPARATELY.** Same stale-premise shape, no agent dimension. |
| `mcp/authorize.ts` — `assertCredentialLive` returns for a session ctx | True as far as it goes; the gap is that "checked upstream" was once, at run start, while the engine's premise elsewhere is that a run outlives its authorization. | **FILE SEPARATELY.** No revocation-shaped control exists for a session-driven run in flight. Pre-existing, same shape, out of scope. |
| `usecases/agent-proposals.ts:234-239` — the approval-tier lookup omits `deletedAt: null` | Contradicts the gate's own read (`agent-registration-gate.ts:215-216`, whose header at 24-27 says "a soft-deleted row passes nothing") and makes "the register cannot produce it" mean two things in two modules. | **FILE SEPARATELY.** Genuinely arguable the other way — a written proposal's terms may be better read from the row that made it — it is about soft-deletion rather than suspension, and it does not belong in an authorization-boundary diff. |
| `PUT /api/t/{slug}/admin/security-settings` — `requireRegisteredAgent` falls through a bare key loop | The only way to set this flag. No `.tsx` reads or writes it; no validation, no confirmation, no warning, in the same function that refuses `aiResidency: LOCAL_ONLY` without a gateway and `maxConcurrentSessions: 0` with a paragraph each. The audit row records **field names only**, so the trail cannot answer "when did this tenant stop enforcing". | **FILE SEPARATELY.** A real defect, and not an authorization-boundary change. It is also why nobody noticed this class for so long. |

---

## Open question — the RETIRED asymmetry

`governedAgentIdOf` returns the subject id for `vouched`, `suspended` and
`unknown_status`, and `null` for `no_binding`, `unresolvable`, `draft` and
`retired`. So **SUSPENDED governs and RETIRED does not**, and after this fix a
retired agent is strictly *looser* at the boundary than a suspended one: it
keeps `UNCLAMPED` autonomy, no policy card, no circuit breaker and an unmatched
AGENT arm on its own kill switch.

**This is recorded as an open question, not as a settled decision.**

**The honest reason it went this way.** Suspension is the containment gesture —
`agent-registration-gate.ts:24-27` calls SUSPENDED "deliberate containment" — so
an operator who suspends an agent is asking for its controls to bite. Retirement
is end-of-life: `retireRegisteredAgent` is on DELETE, it carries a precondition
(no proposals awaiting review), and the register keeps the row for history.
Nothing in "end of life" reads as "and meanwhile it should be more autonomous
than it has ever been", which is what the code now says.

**DRAFT needs no decision and RETIRED does.** DRAFT is unreachable by any
supported path: `createApiKey` refuses a non-ACTIVE binding, `agentId` is
written only at creation, `AGENT_LIFECYCLE_MOVES = ['ACTIVE', 'SUSPENDED']`
(`schemas/agent-registry.schemas.ts:156`) so ACTIVE→DRAFT is not expressible,
and the legacy backfill lands SUSPENDED without ever writing a key binding.
**RETIRED is reachable with live keys still bound.**
`retireRegisteredAgent` (`usecases/agent-registry.ts:369-384`) counts PENDING
proposals and nothing else — there is no precondition about bound credentials.
So an operator can retire an agent whose keys are live, and this fix leaves
those keys wider than the same operator would get by suspending.

**What would change it.** Any one of these settles it:

1. A product answer to "does retiring an agent revoke or unbind its keys?" If it
   does, the asymmetry evaporates: the population is empty and `retired` can
   stay non-governing on the grounds that no credential can reach it. That is
   the cheapest resolution and it belongs with `retireRegisteredAgent`, not
   here.
2. Otherwise, `retired` should govern, and it is one `case` label in
   `governedAgentIdOf` plus the matrix cell that already exists for it. Adding
   terms to a `min` cannot widen, so the change is one-directional by
   construction — the same argument that made the suspended ceiling safe.
3. A third answer — that retirement should refuse tools outright rather than
   merely govern — is a different change, because it would refuse in an
   enforcing tenant too, and `stateBody.RETIRED` promises the opposite
   ("activating it would put it back into service").

Until then, note the shape of the screen this produces: in a non-enforcing
workspace the agent detail tab shows a SUSPENDED-denies sentence next to a
RETIRED-widens sentence. That is honest, and it is the strongest argument for
settling this now.

---

## Cross-links the integrator should add

These three comments are where the next reader will actually be standing when
they ask "why does `null` mean no narrowing here?". Each should gain a pointer
to this note. The files are the authorization spine and are not this lane's to
edit; the exact anchors, post-`eb4d82a19`:

| file | anchor | what to add |
|---|---|---|
| `src/lib/agentic/agent-tool-exposure.ts` | `12-28` — the "## Where it does NOT apply, and why that is not a hole" block, whose "exactly two ways to be in that state" is the enumeration that was wrong | A line stating the count is **seven**, that the two named are the only ones with no list to consult, and `→ docs/implementation-notes/2026-09-10-suspension-is-a-boundary-control.md` |
| `src/lib/agentic/autonomy-ceiling.ts` | `121-128` — the "NO AGENT RESOLVED AT ALL" bullet of THE THIRD NULL; and the falsified sentence at `22-27` ("the AGENT term is always present for an agent-bound credential") | At `121-128`: that a suspended agent is *not* this population and is routed through `governedAgentId` before it reaches `riskTierCeilingFor`. At `22-27`: correct the sentence, and link the note |
| `src/lib/mcp/authorize.ts` | `171-175` — the `agentId` field docstring on `McpInvocation`, "`null` means the tenant is not enforcing the register" | That `null` means one of **six** non-vouched situations, that `governedAgentId` immediately below is what agent-keyed controls read, and the note link |

Related documents that should be checked off against this note rather than
silently left. Two of them carry the superseded "two ways to be in that state"
enumeration —
`docs/implementation-notes/2026-09-04-mcp-per-invocation-authorization.md:185-194`
and, in the source it paraphrases, `agent-tool-exposure.ts:12-28`. One carries
the opposite overclaim:
`docs/implementation-notes/2026-09-04-agent-registry-surface.md:119-125` says
"`suspendRegisteredAgent` **is** the kill switch … it takes effect at the MCP
gate on the very next request", which was false for a non-enforcing tenant when
it was written and is now true of tool calls only. And
`docs/implementation-notes/2026-09-06-agent-kill-switch-and-drill.md:35-36`
which cites "inert for a tenant with `requireRegisteredAgent` off" as a reason
the kill switch exists. Re-state that one, do not delete it: the other two
reasons survive — it acts mid-run and uncached, and it has tenant and
platform scopes — plus a third that was always true and never written down, that
it covers the resources door (`authorize.ts:840`, `assertNotKilled` on
`MCP_RESOURCES_AUDIENCE`), which suspension does not.
