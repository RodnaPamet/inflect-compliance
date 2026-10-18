# 2026-10-18 — First IAM skills on a declared workflow (#3668, step 1d)

**Commit:** _(this PR)_ `feat(agentic): declare the two IAM skills on a discovered-agent review, with output contracts (1d)`

Step `1d` of the agentic AI for IAM roadmap (#3654). The two IAM skills that
`0b` drafted, `harness-level-assessment` and `nhi-ownership-attribution`, are
declared by a workflow for the first time, read one discovered agent's facts,
and have output contracts the scanner ingest and the registration intake (`2a`)
can parse their answers through.

## Design

```
startWorkflowRun(ctx, 'discovered-agent-review', { discoveredAgentId })
  │  assertRequiredInputPresent ── missing/blank/non-string → 400, NO row
  │  (budget, concurrency, input scan, card pin, driver)
  │  flue? → registered agent vouched → pinSkillsOrRefuse(def.skills)
  │                                       └ mount gate on the committed records
  ▼  createSealedRun(… mountedSkills = [harness-level-assessment, nhi-ownership-attribution])

READ  discoveredAgent ── get_discovered_agent (MCP read tool, admin.agent_registry)
                           └ getDiscoveredAgentFacts: one DiscoveredAgent + its
                             newest scan item, re-validated; observations, not answers
SYNTHESIS review ─────── says what was read; no level, no owner

skill answer (text) ──▶ parseHarnessAssessment / parseOwnershipAttribution
                         (src/lib/agentic/iam-skill-outputs.ts) ──▶ 2a intake
```

The skills' text and evaluation sets are unchanged. Both sets already covered
the four case kinds, and both committed records pass the gate, so the step
declares the skills rather than rewriting them.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/workflows/discovered-agent-review.ts` | The workflow: Flue, the two skills, `requiredInput: ['discoveredAgentId']`, one read and one synthesis |
| `src/lib/agentic/workflow-registry.ts` | Registers it |
| `src/app-layer/usecases/agent-harness-facts.ts` | `getDiscoveredAgentFacts`: one discovered agent's facts, gated on `admin.agent_registry`, fail-closed |
| `src/lib/mcp/tools/harness-tools.ts` | `get_discovered_agent`, the read tool over it |
| `src/lib/mcp/tools/registry.ts`, `src/lib/mcp/tool-catalogue.ts` | Register the tool and its grantable name |
| `src/lib/agentic/content-provenance.ts` | `scanner.harness-report` source and the tool's corpus entry, both untrusted |
| `src/lib/agentic/harness-contract.ts` | `parseStoredHarnessTools`, beside the two stored-JSON parsers |
| `src/lib/agentic/iam-skill-outputs.ts` | The two output contracts |
| `tests/unit/agentic/iam-skill-outputs.test.ts` | The contracts' refusals, and the type-level closure of the attribution status |
| `tests/unit/agentic/discovered-agent-review-workflow.test.ts` | Gate, scan and mount over the shipped corpus |
| `tests/integration/discovered-agent-review.test.ts` | Admission refusal with zero rows, the pinned row, the facts read, the static run |

## Decisions

- **The read tool takes `admin.agent_registry`, the key every harness read
  takes, and no new key.** That makes it unreachable for any bearer token: no
  scope maps to the key and `*` subtracts it. A Flue run is always started by
  an agent-bound key, so on Flue the tool is not even offered. The alternative
  that would have made it reachable, `admin.agent_harness_ingest`, is the
  scanner's key, and handing it to an assessing agent would let that agent post
  reports. Who may read the agent inventory by token (a view key split from
  `admin.agent_registry`) is open in the roadmap, and it stays an owner
  decision rather than a side effect of this tool.
- **The Flue run input gap is reported, not fixed.** `runMessage` gives the
  model the description and the step labels and never the run input, because
  the Flue driver never opens the sealed context. Passing declared inputs
  through is a change to prompt assembly, the decision digest and an ESM-only
  module, which is a runtime seam of its own. With both gaps, a Flue run of the
  review has no agent to assess, and each skill's missing-input rule is what
  answers: it names the missing `discoveredAgent`.
- **The facts are observations, not answers.** The tool returns the scan's
  per-criterion observations as reported and the owner as the source records
  it, and leaves out the derived level and `blockingNextRung`: the assessment
  skill is told never to state a level, and handing it the stored one would
  turn the assessment into an echo of the number it checks.
- **The owner reference reaches the run's context.** The attribution needs
  the owner its source records, which is signal 1 of the skill. The DPIA
  (`docs/agentic-harness-scanner-dpia.md`) names two purposes for the owner
  reference, the `H1.owner` check and reconciliation against the register, and
  its condition 9 is about the ingest calling no model. A model reading the
  reference through this tool falls under the first purpose, and it is a new
  reader. The tool cannot reach a model today (above); the DPIA should record
  that reader before the key question is closed. On a static run the reference
  lands only in the encrypted run context and step output
  (`WorkflowRun.contextJson`, `WorkflowStep.outputJson`).
- **A met verdict without evidence is refused, not coerced.** The ladder reads
  it as not met, so accepting it would let an answer claim a pass the level
  derived from it does not contain. Refusal names the defect, and the reader
  re-asks.
- **The attribution status is the reconcile engine's outcomes minus
  `LINKED`.** Reusing the engine's vocabulary ties the rule to the one already
  held for legacy accounts: only a strong deterministic signal links, and a
  model is not one. `NON_PERSON` is excluded too, since a non-human identity is
  the subject, not a reason.
- **The grade and outcome are checked against the answer's signals.** A
  naming pattern never decides, a team tag names no owner, a tie is
  `AMBIGUOUS`, a departed person makes the agent an orphan, and `STRONG` needs
  an identity-owner or credential signal naming exactly one person the input
  said is active. Activity the input never stated is not active, so such a
  proposal is `WEAK` and the intake checks the membership.
- **The contracts are pure parsers.** The engine has no seam that holds a
  run's answer to a schema, and building one is not this step's to do; `2a`
  is the consumer.
- **No specialist was added.** `SPECIALISTS` narrows skills to what the
  parent declared, and none of the four is an IAM specialist; a delegate for
  this workflow is a decision for when one is needed.
