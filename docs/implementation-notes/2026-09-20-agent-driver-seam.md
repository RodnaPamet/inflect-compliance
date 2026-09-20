# 2026-09-20 — The agent driver seam: two switches, ANDed, neither able to widen

**Commit:** `<sha>` feat(agentic): agent driver seam — two-key gate, fail closed (2/3)

PR 2 of three. The gate that decides whether a tenant's agentic run is executed
by the walk in `workflow-registry.ts` or by an external agent runtime. **Every
answer it can give today is `static`** — the adapter lands in PR 3 — and the
seam is wired, exercised and audited anyway. That is the point of shipping it
separately.

## Design

    effective = 'flue'  iff  AGENT_DRIVER_FLUE is on
                        AND  TenantSecuritySettings.agentDriver = FLUE
                        AND  DRIVER_IMPLEMENTED.flue

The same shape as the autonomy ceiling, which is a MINIMUM over independent
narrowing terms so that no term can widen. Here each term is a veto:

- the **env switch** is the operator's — how a deployment that has not reviewed
  the runtime, or one mid-incident, turns the capability off for every tenant at
  once without a database write;
- the **tenant switch** is the customer's — a tenant that has not agreed to its
  agents being executed by third-party code does not get it because a
  co-resident tenant did;
- **`DRIVER_IMPLEMENTED`** is the build's, and it is the reason this PR is safe
  to merge before PR 3 exists.

`static` is what you get from: the flag unset, the flag set to something
unrecognised, the settings row absent, the column holding a value from a future
build, or junk. There is no input that produces `flue` by accident.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/agent-driver.ts` | the pure gate — no server imports, so a client component can hold it |
| `src/lib/agentic/agent-driver-policy.ts` | the server half: reads the settings row and `env`, emits the fallback log line |
| `src/app-layer/usecases/workflow-runs.ts` | resolves the decision at run start, beside the policy-card pin, and puts it in the audit row |
| `prisma/schema/enums.prisma` · `auth.prisma` | `AgentDriverMode`, and the column on `TenantSecuritySettings` |
| `tests/unit/agent-driver-gate.test.ts` | the grid |

## Decisions

### `DRIVER_IMPLEMENTED` — a capability that is declared and not built

Copied deliberately from `DIRECTION_IMPLEMENTED` in
`src/lib/identity/write-ladder.ts`, where `setIdentityWriteMode` refuses any
widen of a direction whose flag is false. That is what makes "the joiner is
switched off" a different kind of nothing from "the joiner does not exist".

Here it means both switches can be on and the answer is still `static`, with
`DRIVER_NOT_IMPLEMENTED` as the reason — which is a far better state than a
tenant flipping a toggle and getting a run that half-executes on an engine that
is not there. **One line moves when the adapter ships, and it moves in the diff
that makes it true.**

### The env flag is opt-IN, against the grain of its neighbours

`AI_RISK_ENABLED`, `AI_ASSISTANT_ENABLED` and `AI_QUESTIONNAIRE_ENABLED` all
`default('true')` and are read as "not disabled". `AGENT_DRIVER_FLUE` is
`optional()` and read as "not enabled", and only `'1'` / `'true'` count.

The distinction is what the flag governs. Those flags turn on features this repo
implements; this one decides whether code we did not write executes an agent.
`'yes'`, `'on'` and `'enabled'` are all refused, and the test enumerates them,
because they are what someone reaching for a boolean flag actually types.

The strictness lives at the READ rather than in the zod schema on purpose: a
schema that rejects `AGENT_DRIVER_FLUE=yes` turns a typo in a feature flag into
a process that will not boot. The right answer to a misspelled flag is "off",
not "nothing starts".

### The absent settings row resolves to STATIC — the opposite of its neighbour

`isAgentRegistrationEnforced` reads a missing `TenantSecuritySettings` row as
ENFORCING, because an absent row must not be a way to switch a control off.
This one reads a missing row as STATIC, for the same reason pointed the other
way: here the non-default GRANTS, so the absence must not be a way to switch a
capability on.

Both are fail-closed. They differ because *closed* means the safe end of the
switch, not a fixed value — and getting that backwards is how an absent row
becomes a bypass. The module header says so, because the next person adding a
flag to that table will be looking at whichever neighbour is nearest.

### The decision and its reason are produced together

An earlier shape had `resolveAgentDriver` and `staticDriverReason` as two
exported functions walking the same terms. That is the four-verbatim-copies
failure this repo has already paid for in the identity ladder: two functions
over one set of rules drift, and the one that drifts is the one nothing
enforces — the log line. They are one function returning `{ driver, reason }`.

The env switch is checked FIRST so its reason wins. With the deployment-wide
switch off, what the tenant chose is not the actionable fact, and reporting
`TENANT_NOT_OPTED_IN` would send an operator to edit a customer's settings row
to fix their own deployment's environment.

### Why resolve a decision that cannot yet change anything

Because a seam whose first exercise is the diff that also makes it load-bearing
has never been observed working. The decision is resolved at run start, carried
into the `WORKFLOW_RUN_STARTED` audit row alongside the policy-card pin, and
logged at WARN when configuration is ahead of code. So the gate is observable
before it can change behaviour, and PR 3 changes one boolean rather than
introducing a control path at the same time as the thing it controls.

It is in the hash-chained trail and not only in a log line because "which engine
executed this run" is a question an incident review asks about a run that
finished long ago, and log retention is not the audit trail's retention.

### The fallback is logged because silence is indistinguishable from a dead worker

Two of the identity ladder's refusals emit a metric and a log line and write no
row, and CLAUDE.md records the consequence: a tenant left at `DISABLED` looks
identical, from inside the product, to a dead worker. A driver fallback has
exactly that shape — the run still succeeds, so without the log nothing would
say that the engine the operator configured is not the engine that ran.

`DRIVER_NOT_IMPLEMENTED` and `UNRECOGNISED_SETTING` are WARN; the two ordinary
reasons are not logged at all, because an opt-out on every run of every
un-enrolled tenant is noise that would bury the two that matter.

## Two guards this change owed, and neither was predictable from the diff

Both were found by running the derived population rather than a habitual set.

**`sub-processor-coverage`** requires every env var in `src/env.ts` to be
triaged — named in `docs/sub-processors.md` or allowlisted with a written
reason. `AGENT_DRIVER_FLUE` is allowlisted: `@flue/runtime` is an in-process
library we import and run ourselves, not a hosted service, so the flag opens no
socket and sends no data anywhere. The reason says so explicitly, and says that
the model provider such a run would eventually call is a *separate* question
covered by the already-triaged inference vars — so this entry cannot later be
read as having cleared them.

**`no-raw-prompt-logging`** counts what its rule could not judge and pins the
set by exact equality. `agent-driver-policy.ts` joins fourteen agentic siblings
under `identifier bound elsewhere`: the rule does no data-flow analysis, so a
local named `tenantId` is indistinguishable from one named `prompt`. The fields
*are* named at the sink; what cannot be shown structurally is that the module
holds no model call, no transcript and no tool arguments for a prompt-shaped
value to come from.

Re-measuring its two constants turned up something worth recording. Taken the
prescribed way — float both, read the printed counts — this tree measures
**146 holes / 83 sinks** against the stored **143 / 78**. But an *unmodified*
main measures **81** sinks, not 78. `sinkSeen` is a FLOOR, so the three-sink
gap was invisible: earlier work had added sinks without the constant following,
and nothing failed, because a floor only notices a fall. This change contributes
+2 (its two `logger.warn` calls); the constant is set to the measured 83 rather
than to 80, closing the inherited slack in the same move.

## Rollback

Revert the commit and drop the column; `AgentDriverMode` would remain as an
unused type (Postgres cannot drop an enum value or a type still referenced by a
dropped-then-restored column without care, and there is nothing to gain from
removing it). Behaviour is unchanged either way: every run is executed by the
static engine today, before and after.
