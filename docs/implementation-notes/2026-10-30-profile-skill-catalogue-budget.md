# 2026-10-30 — a profile's skill catalogue is priced at save, not only at the run

**Issue:** #4523

## The defect

Saving an agent profile version checked that every skill it names EXISTS
(`assertSkillsKnown`) and nothing about what they COST. Any run is refused when
its catalogue exceeds `MAX_CATALOG_BYTES` (2 KiB), and since #4151 that includes
a profile's run — refused by `resolveRunSkills` at admission, before the run row
exists. So a version naming too many skills could be saved, submitted, approved,
and then never run.

It was two clicks away, not theoretical: **the shipped corpus alone is over
budget** — 11 skills totalling 3,187 bytes against 2,048 — and the Behaviour
tab's picker offers all of them.

## What changed

`assertSkillsKnown` became `assertSkillsKnownAndWithinBudget`, prices the named
skills with the same `catalogBytes` the run uses, and refuses
`SKILL_CATALOGUE_OVER_BUDGET` (409) with the byte count. Called at **create**,
**new version** and — newly — **approve**.

| File | Role |
| --- | --- |
| `src/lib/agentic/flue/skills/resolve.ts` | `repositorySkillCatalogue()` — name → catalogue-line fields for every MOUNTABLE shipped skill. |
| `src/app-layer/usecases/agent-profiles.ts` | The check, the refusal, the three call sites, `skillRefs` added to `VERSION_SELECT` so approve can read the stored set. |
| `tests/integration/agent-profiles.test.ts` | Four cases, plus a corpus-inflation seam. |
| `tests/integration/tool-runner-skills.test.ts` | Setup repaired — see below. |

## Decisions

- **409, not 400**, matching the tenant-skill precedent's `CATALOGUE_OVER_BUDGET`.
  It is a conflict with the corpus's current size, not a malformed request.

- **`SKILL_UNKNOWN` is reported before the budget.** An unknown skill has no
  catalogue line, so pricing it first would price it at zero *and* hide the real
  fault. A test pins the ordering.

- **The run still prices the catalogue, and must.** The cost of a FIXED set
  changes: a deploy can lengthen a shipped description, and approving a tenant
  skill does not consider the profiles naming it. This moves the refusal earlier
  for the common case; it does not make the run's check redundant.

- **Priced at approval too.** The reviewer is the last person who can act before
  a run is refused. This is also what made the run-time case testable — see
  below.

- **`repositorySkillCatalogue` is deliberately NOT the population of
  `repositorySkillNames`.** The latter includes REFUSED skills by design, so a
  tenant skill cannot take one of their names. A refused skill has no
  description and cannot mount, so it has no line to price — it is absent from
  the catalogue map, and the docstring says a caller must not read that absence
  as "free to mount". It costs a refusal.

## What testing this taught, which is the part worth keeping

**A version's settings are frozen at EVERY status, not only once decided.** The
first attempt at the approve-time test grew `skillRefs` on a SUBMITTED version
by raw UPDATE and hit `IMMUTABLE_AGENT_PROFILE_VERSION`. The file's neighbouring
test is titled "a decided version is frozen …", which reads as though SUBMITTED
were mutable. It is not. So the stored set can never get bigger — only
**dearer**, which is exactly the case the run-time check exists for, and the
test now models it by lengthening the descriptions instead.

**The save and the run price from different reads, and that is what made the
existing run-level test repairable.** `tests/integration/tool-runner-skills.test.ts`
needs a stored over-budget profile to prove the run refuses one; the new
save-time check refuses that setup. The run prices the live corpus through
`shippedCorpus()`, while the save prices `repositorySkillCatalogue()` — so
reporting a cheap catalogue for the `beforeAll` only models a version saved
while its skills were cheap, and the run still sees the real 3,187 bytes and
still refuses. The assertion the suite exists for is untouched.

## Mutation proofs

| Mutation | Caught by |
| --- | --- |
| the budget throw removed entirely | the save case **and** the approve case |
| only the APPROVE-time call removed | the approve case alone |

The second is the one that matters: it shows the approve-time check carries its
own coverage rather than riding on the save-time one.

## Left open, filed rather than widened

The picker still offers selections the save refuses — it shows no catalogue
cost, and `mountableSkills` lists REFUSED repository skills, which can never
mount whatever the budget says. Both are client affordances over the same view,
filed separately; the server's answer is now the early one either way.
