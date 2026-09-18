# 2026-09-18 — SOC 2: recording the authored-depth decision (#2625)

**Commit:** `<pending>` docs(soc2): record the authored-depth decision instead of inventing 23 criteria

## Design

An audit of the framework catalog found that the SOC 2 library carries **one
representative criterion per Common Criteria series** — ten CC leaves, two of them under
CC1 — where the 2017 TSC runs to roughly **33 points of focus**. CC6 alone is CC6.1
through CC6.8.

Nothing in the repo recorded that as intended. Every other short library states its
scope: OWASP ASVS says "259 of ~286" in its note with the counts ratcheted, DORA prints
its pillar and article ranges, NIS2 names its Article 21(2) subset. SOC 2 said only
"Descriptions paraphrased — NOT verbatim AICPA text", which is a licensing statement and
not a depth one.

So the shortfall was indistinguishable from an oversight, and an audit had to
rediscover it.

### What was decided, and what was rejected

**Recorded, not authored.** The alternative was to write the ~23 missing criteria.
`docs/control-task-authoring.md` addresses this situation directly — *"Say so in the PR
rather than synthesising from knowledge of the standard"* — and the reasoning holds
harder here than usual: the AICPA criteria are licensed and not reproduced in this repo,
so authoring them would mean paraphrasing points of focus from memory of the standard.
That manufactures the appearance of coverage without its substance, and in a compliance
product the appearance is the dangerous half.

### The second fact, which is not the same fact

The **library** models all five trust categories — the ten Common Criteria plus A1, C1,
PI1 and P1, fourteen assessable nodes. The **delivered fixture** carries the ten Common
Criteria only. So an installed SOC 2 pack is Security-scoped while the library file
describes five categories.

That divergence was also unrecorded, and it is the one more likely to mislead: a reader
opening the library sees Availability and Privacy nodes that no tenant will ever be
given.

## Files

| File | Role |
| --- | --- |
| `src/data/libraries/soc2-2017.yaml` | Scope-of-authored-content header: the per-series depth, why the missing criteria were not synthesised, and the library-vs-fixture divergence |
| `tests/guardrails/soc2-starter-pack-coverage.test.ts` | Pins the delivered count at 10 and the library's assessable count at 14; asserts the fixture does NOT carry the category nodes |

## Decisions

- **Pinned, not floored.** Both counts are exact. A floor cannot fail for a catalogue
  going short, which is the defect #2626 fixed across six other frameworks — the same
  reasoning applies to a catalogue whose shortfall is deliberate: the recorded number is
  a claim, and a claim that only ever grows is a claim nobody checks.
- **The library-vs-fixture divergence is pinned as a fact rather than fixed as a bug.**
  Delivering A1/C1/PI1/P1 is a product decision about what a SOC 2 tenant is given, not a
  correctness fix. The guard states the current answer so that changing it is deliberate.
- **Mutation-proved.** Dropping the P1 node fails with `Expected: 14, Received: 13`.
  Before this change nothing asserted the library's assessable count at all.
- **Not closed by this note.** A tenant tracking SOC 2 here tracks one criterion per
  series. "CC6.1 Access Security" stands in for eight points of focus, and a SOC 2
  auditor will ask about all eight. The header says so in those words.
