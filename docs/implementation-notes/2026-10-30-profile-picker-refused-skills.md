# 2026-10-30 — An agent profile cannot choose a shipped skill the text scan refused

**Branch:** `claude/profile-picker-refused-skills` — follow-up to #4523 (owner
decision, 2026-10-30).

## Design

The Behaviour tab offered every name in `repositorySkillNames()`, which includes
shipped skills the text scan refused. Such a skill could be chosen and saved,
`runCatalogue` counted it as 0 bytes, and only admission refused the run. No
shipped skill is refused today, so nobody has hit it.

The profile surface now reads `selectableRepositorySkillNames()` (in
`resolve.ts`), the names in `SkillCorpus.skills`. That is the corpus's own
split, read from the same cached corpus that `lookup` refuses a run by:

- `mountableSkills` offers only those names;
- `assertSkillsFit` (both save paths and approval) treats any other shipped
  name as unknown, so a refused skill is refused by name as `SKILL_UNKNOWN`,
  before the catalogue measure.

This supersedes one sentence of the #4523 note
(`2026-10-30-profile-skill-catalogue-budget.md`): "A repository skill the text
scan refused costs nothing here" no longer holds for a profile, because a
profile never reaches the measure with one.

## Decisions

- **`SKILL_UNKNOWN`, not a new reason.** The message is already "No skill the
  agent may mount is called …", which is true of a refused skill. The picker
  no longer offers one, so the refusal reaches a person only through a stale
  form, an API call, or approval of a version a deploy or an earlier save left
  naming one. The Skills tab already names refused skills with their rule ids.
  A new code would also need en and bg strings for a case nobody can reach
  from the picker.
- **A helper in `resolve.ts`, not a filter in the usecase.** The cached corpus
  is private to `resolve.ts`. The only other way to it from the usecase was
  `runCatalogue(...).refused`, which would mean measuring a catalogue to learn
  whether a name is allowed. The helper reads the existing list and copies
  nothing.
- **`repositorySkillNames()` is unchanged.** Its other two callers must keep
  refused names. Tenant-skill creation (`tenant-skills.ts`) and
  `resolveRunSkills` both refuse a tenant skill named like any shipped skill,
  refused or not: a later deploy can lift the refusal, and the runtime mounts a
  name once.
- **No mount gate at save, as before.** A shipped skill without a passing
  evaluation record is still offered and saved, and refused at admission. Every
  shipped skill has a record today. Whether the picker should ask the gate too
  is a separate decision.
- **The editor needed no change.** When a version it starts from names a skill
  the view no longer offers, it already leaves that skill out and names it in
  its "no longer granted, or can no longer mount" notice.
