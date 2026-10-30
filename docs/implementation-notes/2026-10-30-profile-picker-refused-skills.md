# 2026-10-30 — An agent profile cannot choose a shipped skill no run could mount

**Branches:** `claude/profile-picker-refused-skills` (#4606) and
`claude/profile-picker-unmountable-skills`. Follow-ups to #4523, two owner
decisions of 2026-10-30: first the skill the text scan refused, then the skill
the mount gate refuses.

## Design

The Behaviour tab offered every name in `repositorySkillNames()`. That list
includes shipped skills a run cannot mount, for two reasons:

- the text scan refused the skill;
- the mount gate refuses it, because no passing evaluation record matches its
  text.

Such a skill could be chosen and saved, and only admission refused the run.
`runCatalogue` counted a refused skill as 0 bytes. No shipped skill fails
either check today, so nobody has hit it.

The profile surface now reads `mountableRepositorySkillNames()` in
`resolve.ts`. It asks the run's own two questions, from the run's own cache:

- **Text scan:** the skill is in `SkillCorpus.skills`, not in `.refused`. This
  is the cached corpus `lookup` refuses a run by.
- **Mount gate:** `verdictFor(skill).ok`. This is the cached
  `checkSkillMountable` verdict `mountable` refuses a run by.

Both profile call sites read it:

- `mountableSkills` offers only those names.
- `assertSkillsFit` (both save paths and approval) treats any other shipped
  name as unknown. It refuses the skill by name as `SKILL_UNKNOWN`, before the
  catalogue measure.

This supersedes one sentence of the #4523 note
(`2026-10-30-profile-skill-catalogue-budget.md`): "No mount gate at save …
A repository skill the text scan refused costs nothing here". For a profile,
save and approval now ask both questions, and the measure never sees such a
skill.

## What the gate reads, and what can change between save and run

`checkSkillMountable` reads two files in the skill's directory, which is part
of the deployed build:

- the evaluation set named by `metadata.evaluation`. It is checked against the
  skill's name, `metadata.version` and the SHA-256 of its instructions.
- `evaluation-record.json`. Its copy of the set must equal the committed set,
  and its pass rates are recomputed from the raw answers.

A save stores only `{ origin, name }`. It stores no hash and no pin. Whatever
the save asked can change before a run, but only through a deploy:

- the skill's text changes (the record no longer matches until someone
  re-records);
- a set gains cases;
- a record is removed;
- the thresholds rise;
- a new scan rule refuses the text.

Within one process the verdict is cached until restart, because the files
cannot change under it. During a rolling deploy the web tier (save, approval)
and the worker (the run's segments) can briefly run different builds. Approval
asks again, admission a third time, and a run that resumes after a deploy is
held to its pin by `skillPinDrift`.

## Decisions

- **`SKILL_UNKNOWN`, not a new reason.** The message is already "No skill the
  agent may mount is called …", which is true of both kinds. The picker no
  longer offers either kind, so the refusal reaches a person only through:
  - a stale form or an API call;
  - approval of a version that a deploy or an earlier save left naming one.

  A new code would need en and bg strings for a case the picker cannot
  produce.
- **One helper, renamed when the gate joined.** It was
  `selectableRepositorySkillNames` (text scan only) in #4606. It became
  `mountableRepositorySkillNames` once it answered both of the run's questions.
- **Why the helper lives in `resolve.ts`.** The cached corpus and the cached
  verdicts are private to `resolve.ts`. Outside it, the usecase would have
  needed a second gate call or a catalogue measure just to learn whether a
  name is allowed.
- **`repositorySkillNames()` is unchanged.** Its other two callers must keep
  refused names:
  - tenant-skill creation (`tenant-skills.ts`);
  - `resolveRunSkills`.

  Both refuse a tenant skill named like any shipped skill, mountable or not:
  a later deploy can make the shipped one mountable, and the runtime mounts a
  name once.
- **Tenant skills are not changed.** Approval of a tenant skill runs
  `checkTenantSkillMountable`. The picker and the profile save then accept any
  APPROVED version without re-asking it. A deploy that adds a scan rule or
  raises a threshold could leave an approved tenant version offered and saved
  that admission refuses. That is the same class of gap, reported to the
  owner rather than closed here.
- **The editor needed no change.** When a version it starts from names a skill
  the view no longer offers, it already leaves that skill out and names it in
  its "no longer granted, or can no longer mount" notice.
