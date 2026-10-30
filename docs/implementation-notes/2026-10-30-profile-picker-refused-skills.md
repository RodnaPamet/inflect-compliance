# 2026-10-30 — An agent profile cannot choose a skill no run could mount

**Branches:**

- `claude/profile-picker-refused-skills` (#4606)
- `claude/profile-picker-unmountable-skills` (#4611)
- `claude/profile-picker-unmountable-tenant-skills`

These are follow-ups to #4523, from three owner decisions of 2026-10-30. They
cover, in order: a shipped skill the text scan refused, a shipped skill the
mount gate refuses, and an approved tenant skill the tenant mount gate now
refuses.

## Design

The Behaviour tab offered every name in `repositorySkillNames()` and every
APPROVED tenant skill version. Some of those, a run cannot mount:

- a shipped skill the text scan refused;
- a shipped skill the mount gate refuses, because no passing evaluation record
  matches its text;
- an approved tenant skill the tenant mount gate
  (`checkTenantSkillMountable`) now refuses. That gate passed it at approval,
  but a later deploy can tighten the scan or the record check, and the pinned
  hash is recomputed from the stored text.

Such a skill could be chosen and saved, and only admission refused the run.
`runCatalogue` counted a refused shipped skill as 0 bytes. No skill of any
kind fails today, so nobody has hit it.

The profile surface now asks what the run asks, read the way the run reads it.

**Shipped skills:** `mountableRepositorySkillNames()` in `resolve.ts`. It
draws on the run's own per-process cache:

- **Text scan:** the skill is in `SkillCorpus.skills`, not in `.refused`. This
  is the cached corpus `lookup` refuses a run by.
- **Mount gate:** `verdictFor(skill).ok`. This is the cached
  `checkSkillMountable` verdict `mountable` refuses a run by.

**Tenant skills:** `tenantVersionMount()` in `resolve.ts`, the per-version half
of `resolveRunSkills`. `resolveRunSkills` now calls its two parts in its
original order:

- no shipped skill takes the name;
- the tenant mount gate passes the version.

`mountableTenantSkillLines()` keeps the versions it passes. The versions are
read with the mount's own columns (`TENANT_SKILL_MOUNT_SELECT`, decrypted by
the same client), from `tenant-mount.ts`:

- `readApprovedTenantSkillsByNameIn(db, …)`: admission's by-name read,
  extracted so the save and approval read through the caller's tenant
  transaction;
- `readMountableTenantSkillLines(db, …)`: the picker's paged read.

Both profile call sites read these:

- `mountableSkills` offers only skills that pass.
- `assertSkillsFit` (both save paths and approval) treats any other name as
  unknown. It refuses the skill by name as `SKILL_UNKNOWN` (`repository:<name>`
  or `tenant:<name>`), before the catalogue measure.

This supersedes one sentence of the #4523 note
(`2026-10-30-profile-skill-catalogue-budget.md`): "No mount gate at save …
A repository skill the text scan refused costs nothing here". For a profile,
save and approval now ask every question admission asks of each named skill,
and the measure never sees one that fails.

## What the gates read, and what can change between save and run

`checkSkillMountable` reads two files in the shipped skill's directory, which
is part of the deployed build:

- the evaluation set named by `metadata.evaluation`, checked against the
  skill's name, `metadata.version` and the SHA-256 of its instructions;
- `evaluation-record.json`, whose copy of the set must equal the committed
  set, and whose pass rates are recomputed from the raw answers.

`checkTenantSkillMountable` reads the version row:

- its status and the two people;
- its instructions, decrypted and hashed against `contentHash` and
  `approvedContentHash`;
- the text scan;
- its evaluation record, decrypted, parsed and recomputed.

A save stores only `{ origin, name }`, with no hash and no pin. Whatever the
save asked can change before a run:

- for a shipped skill, only through a deploy: the text changes, a set gains
  cases, a record is removed, the thresholds rise, or a new scan rule refuses
  the text;
- for a tenant skill, through a deploy that tightens the scan or the record
  check, through the version being retired, or through its stored text no
  longer hashing to its pin.

The shipped verdict is cached per process until restart. The tenant verdict
is never cached, because the row is read fresh each time, as at admission.
During a rolling deploy the web tier (save, approval) and the worker (the
run's segments) can briefly run different builds. Approval asks again,
admission a third time, and a run that resumes after a deploy is held to its
pin by `skillPinDrift`.

## The picker's cost

One load reads and gates at most `PICKER_TENANT_VERSIONS` (200) approved
tenant versions. It reads them in pages of `MOUNTABLE_TENANT_SKILL_PAGE` (20),
ordered by id, so it makes at most 10 queries. Each page's rows are dropped
once its lines are taken. At most one page of evaluation records (up to 4 MiB
each, by `TENANT_SKILL_LIMITS.recordBytes`) is therefore held at a time.

Per version, the load does the following:

- decrypts two columns;
- hashes the instructions (at most 8 KiB);
- runs the text scan;
- parses the record and recomputes it.

Measured in the unit-test runtime on this machine:

- about 1.2 ms per version with a four-case record, so about 250 ms for 200;
- about 7 ms for the largest shipped record (55 KB, including its two file
  reads).

A tenant with 200 approved skills carrying records of that size would spend
about 1.4 s of CPU per picker load.

The save and approval read only the tenant skills the version names. That is
one query, whose cost grows with the number of tenant skills named.

## Decisions

- **`SKILL_UNKNOWN`, not a new reason.** The message is already "No skill the
  agent may mount is called …", which is true of every kind. The picker no
  longer offers any of them, so the refusal reaches a person only through:
  - a stale form or an API call;
  - approval of a version that a deploy or an earlier save left naming one.

  A new code would need en and bg strings for a case the picker cannot
  produce.
- **One shipped helper, renamed when the gate joined.** It was
  `selectableRepositorySkillNames` (text scan only) in #4606. It became
  `mountableRepositorySkillNames` once it answered both of the run's questions.
- **The tenant check is the run's own code, extracted, not copied.**
  `resolveRunSkills` calls the same two parts that make up
  `tenantVersionMount`, in its original order: name, then duplicate, then
  gate. A refusal to a run is unchanged.
- **The shipped-name collision rides along.** It is part of what admission
  asks of a tenant version, so a tenant skill a later deploy shadows with a
  shipped skill of its name is also no longer offered or accepted.
- **Why the helpers live in `resolve.ts` and `tenant-mount.ts`.** The cached
  corpus and verdicts are private to `resolve.ts`, and the mount's columns and
  reads are owned by `tenant-mount.ts`. A usecase-side copy of either would be
  the second check the owner ruled out.
- **Paging, not a lower cap.** 200 is the picker's existing bound, and
  lowering it would hide skills from tenants with many of them. Paging bounds
  memory. CPU grows with the number of approved versions and their record
  sizes, as the measurements above show. Caching verdicts keyed on the exact
  stored inputs would cut repeat loads, but the run deliberately caches nothing
  for a tenant version, so that is left to the owner.
- **`repositorySkillNames()` is unchanged.** Its other two callers must keep
  refused names:
  - tenant-skill creation (`tenant-skills.ts`);
  - `resolveRunSkills`.

  Both refuse a tenant skill named like any shipped skill, mountable or not:
  a later deploy can make the shipped one mountable, and the runtime mounts a
  name once.
- **The editor needed no change.** When a version it starts from names a skill
  the view no longer offers, it already leaves that skill out and names it in
  its "no longer granted, or can no longer mount" notice.
