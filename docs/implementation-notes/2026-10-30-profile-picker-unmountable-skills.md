# 2026-10-30 — An agent profile cannot choose a shipped skill the mount gate refuses

**Branch:** `claude/profile-picker-unmountable-skills` (#4611). A follow-up to
#4523, #4589 and #4599, under the owner's decisions of 2026-10-30. It
supersedes #4598 and #4606, which #4589 and #4599 overtook.

## Design

#4589 prices a profile version's skills at save and approval
(`assertSkillsKnownAndWithinBudget`). #4599 has the picker and the save both
read `repositorySkillCatalogue()`, so a shipped skill the text scan refused is
not offered and is `SKILL_UNKNOWN` by name.

That map still held every skill the scan passed, including one the mount gate
refuses: a skill with no passing evaluation record for its text. Such a skill
could be chosen, saved and approved, and only admission refused the run.

`repositorySkillCatalogue()` now also requires `verdictFor(s).ok`. That is the
cached `checkSkillMountable` verdict `mountable()` refuses a run by, so the map
holds what its docstring always claimed: every MOUNTABLE shipped skill. The
picker, both save paths and approval read it, so none of them needs its own
change.

Its only caller is `agent-profiles.ts`, in the known check and in
`mountableSkills`, so the change is scoped to the profile surface by
construction. `repositorySkillNames()` is unchanged: a tenant skill may take
no shipped name, mountable or not.

The PR also carries the parts of #4598 and #4606 that main does not have:

- **The over-budget refusal is translated.** It is worded by the Behaviour tab
  from #4589's 409 details (`bytes`, `budget`), in en and bg, beside the skills
  field at save and in the approval notice. Main shows the server's English
  sentence in both places. #4599's running total, which keeps Save shut over
  the budget, is unchanged. The save-time refusal therefore arrives only when
  the skills cost more than the view said, and the approval-time one when a
  version got dearer after it was saved.
- **Coverage main lacks:**
  - a tenant option is priced like the shipped ones, and adds up with them to
    the save's figure;
  - the refused case at the first-version save, at approval of a version
    stored before the check, and at admission.

## What the gate reads, and what can change between save and run

`checkSkillMountable` reads two files in the skill's directory, both part of the
deployed build:

- the evaluation set named by `metadata.evaluation`, checked against the
  skill's name, `metadata.version` and the SHA-256 of its instructions;
- `evaluation-record.json`, whose copy of the set must equal the committed set,
  and whose pass rates are recomputed from the raw answers.

A version stores only `{ origin, name }`. So only a deploy changes the answer
between save and run:

- the text changes and the record no longer matches;
- a set gains a case;
- a record is removed;
- the thresholds rise.

The verdict is cached per process until restart, as for a run. Approval asks
again, and admission a third time.

## Decisions

- **The gate goes in `repositorySkillCatalogue()`, not beside it.** #4606 and
  #4611 first added `selectableRepositorySkillNames` and then
  `mountableRepositorySkillNames` in `resolve.ts`. With #4599's map in place,
  each of those was a second list of the same skills.
- **`SKILL_UNKNOWN` again.** "No skill the agent may mount is called …" is true
  of a skill the gate refuses, and the picker no longer offers one.
- **The figures, not the sentence.** The tab words the over-budget refusal
  itself. A body without the figures still falls back to the server's message.
