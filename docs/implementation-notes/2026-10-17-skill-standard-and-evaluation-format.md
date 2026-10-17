# 2026-10-17 — The skill standard, the evaluation format, and a per-workflow budget (#3661)

**Commit:** _(this PR)_ `feat(agentic): the skill standard and the evaluation format (0b)`

Step `0b` of the agentic AI for IAM roadmap (#3654).

## Design

```
SKILL.md ──loader──▶ LoadedSkill ──resolveSkillsFor──▶ a run's mounted set   (budget: per run)
   │ metadata.evaluation                     ▲
   ▼                                         │ assertWorkflowCatalogsWithinBudget (budget: per workflow)
evaluation-set.json ── checkEvaluationSet ──▶ ok | NAME/VERSION/HASH mismatch
   + a model's answers = evaluation record ── checkEvaluationRecord ──▶ rates recomputed | refusal
```

The standard (`docs/agent-skill-standard.md`) states nine rules and names, for
each, the code that enforces it or the step that builds the enforcement. The
loader validates four optional metadata keys. The evaluation format separates a
SET, authored with the skill, from a RECORD, which only a model run can produce.
Two IAM skills are drafted with their sets and are declared by no workflow.

## Files

| File | Role |
|---|---|
| `docs/agent-skill-standard.md` | The nine rules, the frontmatter, sets and records |
| `src/lib/agentic/flue/skills/index.ts` | Optional metadata validation; the corpus-wide budget check removed |
| `src/lib/agentic/flue/skills/resolve.ts` | `workflowCatalogs`, `assertWorkflowCatalogsWithinBudget` |
| `src/lib/agentic/flue/skills/evaluation-record.ts` | Set and record schemas, hash tie, recomputed rates |
| `src/lib/agentic/flue/skills/harness-level-assessment/` | Drafted skill and its evaluation set |
| `src/lib/agentic/flue/skills/nhi-ownership-attribution/` | Drafted skill and its evaluation set |
| `src/app-layer/usecases/agent-skills.ts` | The Skills tab reports the largest per-workflow catalogue |

## Decisions

- **The catalogue budget moved from the corpus to the workflow** (owner
  decision, 2026-10-17). The corpus stood at 1,688 of 2,048 bytes, so the two
  drafted skills could not be added and the planned eight-skill IAM catalogue
  never could. The cost is paid only for what a run mounts, which the resolver
  already capped; the corpus-wide check limited what the product can know as if
  every skill were in every prompt. The test that asserted a run could mount the
  whole corpus now asserts the opposite: a run over budget is refused.
- **A set carries no answers.** Writing expected answers into the repository and
  calling them a pass would be an evaluation nobody ran. Answers arrive only in
  a record, with the model revision and the time it ran.
- **All four kinds of case are required.** A skill evaluated only on happy paths
  is unevaluated on the cases that matter: refusal, injection, missing input.
- **A case with no expectation is refused**, because it passes any answer.
- **The set is tied to the instructions by hash**, so an edit to a skill is a
  refusal until somebody revisits its cases.
- **The drafted skills are inert by declaration, not by location.** They sit in
  the corpus, visible on the Skills tab as declared by no workflow, and a test
  asserts no workflow declares them. Step 1d declares them after 1b's gate and
  1c's scan exist.
