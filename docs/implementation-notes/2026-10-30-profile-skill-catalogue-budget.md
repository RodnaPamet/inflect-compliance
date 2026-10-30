# 2026-10-30 — An agent profile version's skills fit its run's catalogue budget

**Branch:** `claude/profile-skill-budget-4523` — closes #4523.

## Design

A run mounts every skill it names as one always-present `name: description`
line, and is refused at admission when those lines exceed `MAX_CATALOG_BYTES`
(2 KiB). Since #4151 that includes an agent profile's run. The profile's save
checked only that each named skill existed, so a version naming too many skills
(the shipped corpus alone is 3,187 bytes) could be saved, submitted and
approved, and then never run.

The save and the approval now ask the run's own question, through code the run
shares:

```
                 measureCatalog(lines)  ← the ONE comparison (withinCatalogBudget)
                    ▲                ▲
assertCatalogWithinBudget      runCatalogue(repositoryNames, tenantLines)
        ▲                            ▲
resolveRunSkills (admission)   assertSkillsFit (agent-profiles.ts: save + approval)
                               mountableSkills (per-option catalogueBytes for the picker)
```

- `runCatalogue` builds the lines `resolveRunSkills` mounts for the same names:
  each repository skill's from the shipped corpus (`repositoryLines`, which
  `workflowCatalogs` now shares), each tenant skill's from its APPROVED
  version, read by `approvedTenantSkillsByNameWhere` — the filter the mount
  itself reads by.
- `assertSkillsFit` replaces `assertSkillsKnown`: unknown skills are still
  refused first (`SKILL_UNKNOWN`), then the measure, refusing
  `SKILL_CATALOGUE_OVER_BUDGET` with `catalogueBytes` and `budgetBytes`.
- Approval now calls it on the stored `skillRefs`.
- The view's `options.skills` carry each option's `catalogueBytes`, and
  `limits.skillCatalogueBudgetBytes` the budget. The editor adds the chosen
  ones up under the skills picker. The refusal is worded by the tab, in en and
  bg, from the figures in `details`.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/flue/skills/index.ts` | `withinCatalogBudget` and `measureCatalog`; `assertCatalogWithinBudget` goes through them |
| `src/lib/agentic/flue/skills/resolve.ts` | `runCatalogue`, `repositoryLines`; `workflowsOverBudget` uses the one comparison |
| `src/lib/agentic/flue/skills/tenant-mount.ts` | `approvedTenantSkillsByNameWhere`, shared by the mount and the save |
| `src/app-layer/usecases/agent-profiles.ts` | `assertSkillsFit` at save (both paths) and approval; per-option bytes and the budget in the view |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/*` | running total, translated refusal at save and approval, refs posted as names only |
| `messages/{en,bg}.json` | `agents.behaviour.refusal.SKILL_CATALOGUE_OVER_BUDGET`, `editor.catalogue`, `editor.catalogueOver` |

## Decisions

- **Approval measures again.** Something a version names can change while it
  waits. A tenant skill can be approved again with a longer description, and
  its own approval measures only the workflows it names (`workflowsOverBudget`),
  never the profiles that name it. A deploy can lengthen a shipped description.
  And a version saved before this change was never measured. Approval already
  re-checks tool grants for the same reason. Admission still measures a third
  time. Between approval and a run, the same changes can still happen. The
  issue accepted this.
- **Approval also refuses a tenant skill with no approved version**
  (`SKILL_UNKNOWN`). Such a skill has no line to measure, and the run refuses it
  anyway (`readRunSkillInputs`). This is new at approval; save always did it.
- **No mount gate at save.** The measure answers "would these fit". "May each
  one mount" (evaluation record, text scan, pin) stays admission's question,
  because a skill's record or text can change after approval. A repository
  skill the text scan refused costs nothing here, as in `workflowCatalogs`. No
  shipped skill is refused today.
- **The picker total informs and does not gate Save.** The per-skill figures
  and the budget come from the server. The client only adds them up for
  display. The save measures again and decides. This keeps the tab's rule that
  it computes nothing authoritative.
- **No migration for versions already over budget.** They read as before. A
  submitted one can no longer be approved, and is refused with the figures. One
  in force still runs into the run's own refusal, as before. Each is superseded
  by saving a version that fits, through the ordinary lifecycle. Section 9 of
  `tests/integration/agent-profiles.test.ts` walks that path on a row written
  without the check.
- `tests/integration/tool-runner-skills.test.ts` could no longer save an
  over-budget profile to show admission's refusal. It now saves one that fits,
  and then approves a longer version of a tenant skill it names. That is the
  path still left open in production.
