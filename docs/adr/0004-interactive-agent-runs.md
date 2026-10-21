# 0004 — A browser session's agent: the invariant holds, and which agent it binds

**Status:** accepted · **Date:** 2026-10-21 · **Issue:** #3868 · **Roadmap:** #3859

> **Status: historical record** — a decision taken on 2026-10-21 and the
> reasoning behind it, pinned to that date. Classified `historical` as ADR 0001
> is: an ADR records what was decided and why, and is not revised as the
> implementation lands. Where it describes work still to come, #3868 step 2 is
> current; where it and the code disagree, the code wins and the pull request
> that finds it says so here.

**Decision, in two parts.**

1. **The invariant already holds, so no fourth narrowing term is added to
   `resolveAutonomyCeiling`.** A person asking through an agent cannot reach
   data or operations they could not reach through the UI, because a session is
   its own principal and the propose class authorises on the principal.
2. **A session binds the tenant's designated interactive agent** — one agent per
   tenant, named by somebody holding `admin.agent_registry`, never chosen by the
   asker and never inferred from the question.

## Part 1 — the determination, and why it needed a test

#3868 asks for this **by test rather than by reading**, and the distinction
earned its place. The reading is unambiguous and correct:

| Step | Where | What it says |
| --- | --- | --- |
| the principal | `src/lib/mcp/auth.ts:312-318` | intersects with a credential's scopes only `if (keyCtx.apiKeyId)` — "a SESSION context … IS its own principal" |
| the tool's basis | `src/lib/mcp/tools/propose-tools.ts:118-135` | `basis: 'principal'`, `keys: ['risks.create']`, `mirrors: 'POST /api/t/:slug/risks'` |
| what that resolves to | `src/lib/mcp/authorize.ts:410-412` | `permissionsFor` returns `inv.principal.appPermissions` for that basis |
| the check | `src/lib/mcp/authorize.ts:1231-1237` | the same `assertPermission` the human route uses |

But the question is about the FUNNEL's behaviour, not one function's, and the
neighbouring suspension suite already records what a reading misses: *"a
deny-all at step 4 satisfies every refusal assertion in this file"*. A refusal
proves nothing on its own about WHICH control refused — so a funnel that refused
every propose call, for any reason, would satisfy the obvious test and leave the
invariant unproven in the only direction that matters.

`tests/unit/interactive-agent-authority.test.ts` is the determination, and every
case carries its own discriminator:

- a session's `principal` is the session, and the traced credential double is
  **never consulted** — if it ever is, the intersection is running for a session
  and this ADR's reasoning no longer holds;
- the agent's grant **exposes** `propose_risks` to a READER — exposure is not
  authority, and a test that conflated them would pass either way;
- a READER **is refused**, with an `AUTHZ_DENIED` row, so the refusal is
  attributed rather than merely counted;
- **an EDITOR with the SAME agent is admitted.** This is the case that makes the
  refusal evidence about the person's permissions rather than about propose tools
  in general;
- **every** tool in `PROPOSE_TOOLS` is on the principal basis, not just the one
  under test. The invariant must hold for the CLASS; one tool on the intersection
  basis would be a hole invisible from the other cases.

### Why no fourth term, stated as a property rather than an absence

`resolveAutonomyCeiling` (`src/lib/agentic/autonomy-ceiling.ts:172-177`) takes
exactly three terms — the risk-tier ceiling, the key's maximum, the agent's own
autonomy — and **the person's role is not among them.** So "an OWNER does not
raise a low agent ceiling" is not a behaviour to add; it is true of the
function's signature, and a fourth term for the person is what would make it
expressible. The test asserts both halves: that a low agent ceiling survives a
high tier ceiling and a high key maximum, and that the function takes those
three terms and no more — which is what makes "a fourth" correctly numbered in
#3868 and #3859.

The ceiling and the permission check answer different questions, and conflating
them is the mistake a fourth term would institutionalise. The ceiling bounds
**how far an agent may act without a person**; the permission check decides
**whether this person may do this at all**. A session has a person in it by
definition, so narrowing the ceiling by their role would be answering the second
question in the first question's machinery — and in the wrong direction, since
the person's presence is the thing that makes a run attributable.

## Part 2 — which agent a session binds

**There is no path today.** `getTenantCtx` never sets `agentId`, so a browser
session cannot carry one at all; the only existing seam that binds an agent to a
requester's context is the `INVOKE_AGENT` job
(`src/app-layer/jobs/agent-invoke-dispatch.ts:178-188`). That job is the
precedent, and it answers the question by **configuration a person wrote**: the
agent is named in the automation rule, and the context is built field-by-field
from `resolveTenantContext(tenantId, payload.ownerUserId)` — the rule author's
permissions as they stand TODAY, so a rule outliving its author's role narrows
with it.

A session should follow that precedent, not depart from it. Three candidates:

| | who names the agent | why not |
| --- | --- | --- |
| **(a) a tenant-designated interactive agent** | an `admin.agent_registry` holder, once | **chosen** |
| (b) the asker picks per conversation | the person asking | the asker would be choosing which policy card, which autonomy ceiling and which tool grants apply to their own request — selecting their own governance |
| (c) derived from the workflow | nobody; implied | an agent is an accountable thing with an owner, a card and a kill switch; deriving one from a workflow key means no person ever registered the agent that acted |

(a) is chosen, and the reason is that **every other authority in this subsystem
is per-agent, so the binding has to be a decision somebody made.** An agent
carries an owner who is accountable for it, a policy card, an autonomy level, a
risk tier, a kill switch and a grant set. Letting the asker pick (b) hands them
the choice of which of those apply — the asker would effectively be selecting
their own ceiling, which is the one thing the ceiling exists to prevent. Letting
the workflow imply one (c) means a run acts under an agent nobody registered,
and the register stops being the list of agents that can act.

One agent per tenant rather than per user, for the same reason the register is
per tenant: an agent's accountable owner is a person in the tenant, and a
per-user agent would multiply the register by the membership list while giving
each row the same card.

Three consequences worth stating, because each is a thing step 2 must not get
wrong by default:

- **An unset designation is a refusal, not a fallback.** "No interactive agent
  designated" must refuse with that named reason. Picking "the only ACTIVE agent"
  or "the most recently registered" would make the binding depend on the shape of
  the register, so a tenant registering a second agent would silently change
  which agent answers their people's questions.
- **The designated agent is governed like any other.** Retired, suspended,
  killed, breaker-latched, unscored, unclassified — each already refuses at the
  funnel, and the interactive path inherits every one of them rather than
  carrying its own list.
- **Both the person and the agent are in the audit trail.** The job writes
  `actorType: 'JOB'` precisely so the trail does not claim a person did something
  no person did. A session is the opposite case: a person IS there, so
  `actorType` stays `USER` and the agent is the `agentId` beside it. Neither
  field substitutes for the other.

## What this ADR does not settle

- **Step 2 is not built.** The usecase that starts a Flue run for a session, the
  `AGENT_INTERACTIVE_RUNS` flag, the twelve-step traversal test and the
  two-tenant isolation test are #3868 step 2. This ADR decides what step 2
  binds; it does not bind it.
- **Where the designation is stored** is step 2's schema decision. This ADR says
  it is a designation under `admin.agent_registry`, not where the column lives.
- **The test here exercises the tool door**, not the whole funnel. It is not the
  twelve-step trace the suspension suite pins, and it does not cover resource
  reads — a browser-initiated RUN is step 2's subject, and the file says so at
  the top rather than leaving its scope to be inferred.
