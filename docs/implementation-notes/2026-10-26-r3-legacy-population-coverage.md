# 2026-10-26 — procedure 2's R3 does not pass a legacy campaign of unverified coverage (#3325)

## Design

#4357 gave a legacy snapshot a second fact beside `status`:
`LegacyAccessSnapshot.populationCoverage`, `UNKNOWN` unless a transport observed
the whole table itself, which none does. A `LEGACY_APP` campaign freezes it into
each subject's provenance, and the campaign page, the close row and the evidence
PDF say "coverage unverified" through `frozenCampaignCoverage`.

Audit procedure 2 (`iam.recertification_completeness`) went on ruling attribute
R3, "the campaign covered its whole population", MET for any legacy unit whose
campaign was not truncated. So the one surface built to re-perform rather than
believe kept attesting to the whole application, which is the claim #4357 had
just taken away from every other surface.

Owner decision, 2026-10-26: R3 is NOT MET, with its own exception code, for a
`LEGACY_APP` campaign whose frozen coverage is not `VERIFIED`. Not untestable
and not INCONCLUSIVE: a named exception, so the procedure FAILs by the
catalogue's order (`decideConclusion`: precondition, FAIL, untestable, PASS)
exactly as it already does for every other exception.

```
R3 for a unit's covering campaign            result      code
──────────────────────────────────────────── ─────────── ──────────────────────────────
snapshotTruncated                             EXCEPTION   CAMPAIGN_TRUNCATED      (any scope, any coverage)
LEGACY_APP, not truncated, coverage VERIFIED  MET
LEGACY_APP, not truncated, anything else      EXCEPTION   POPULATION_COVERAGE_UNVERIFIED
ALL_USERS / CONNECTED_APP, not truncated      MET                                 (unchanged)
```

"Anything else" is what `frozenCampaignCoverage` reads as UNKNOWN: an UNKNOWN
subject, a subject frozen before the column existed, a malformed one, a mix, and
no subjects at all (which R2 already raises as `CAMPAIGN_INCOMPLETE`).

## Files

| File | Role |
|---|---|
| `src/app-layer/services/audit-procedures/recertification-completeness.ts` | R3 moves into `r3CoveredWholePopulation`: truncation, then — for `LEGACY_APP` only — the frozen coverage |
| `src/lib/agentic/audit-procedure-library.ts` | `POPULATION_COVERAGE_UNVERIFIED: 'MEDIUM'` in `EXCEPTION_SEVERITY` |
| `src/lib/agentic/flue/skills/iam-audit-procedures/SKILL.md` | names the code under R3; version 3 → 4 |
| `src/lib/agentic/flue/skills/iam-audit-procedures/evaluation-set.json` | version and content hash to v4; one new task case, `legacy-coverage-unverified` |
| `src/lib/agentic/flue/skills/iam-audit-procedures/evaluation-record.json` | re-recorded by the `Skill evaluation records` workflow against the v4 set — never edited by hand |
| `docs/agentic-audit-procedures.md` | procedure 2's R3 row, why R3 asks a legacy application a second question, the exception paragraph |
| `docs/legacy-access-recertification-design.md` | the auditor reads the coverage through the same reader and does not pass it |
| `tests/integration/audit-procedures.test.ts` | the R3 truth table through the module, and a run that FAILs on it alone |
| `tests/unit/agentic/audit-procedure-library.test.ts` | the code's severity sits with `CAMPAIGN_TRUNCATED` |
| `tests/unit/agentic/audit-narrative.test.ts` | every severity-table code is a workpaper `CODE` a narrative can cite |

## Decisions

- **One reader.** R3 calls `frozenCampaignCoverage` over the campaign's decision
  rows, which the procedure already reads whole for R2, R5 and R6. No second
  predicate, and no extra query. A decision read past its cap is UNTESTABLE on R2
  and returns before R3 is asked, so R3 never judges a partial subject list.
- **Frozen, never live.** The coverage comes from the subjects' provenance, not
  from the `LegacyAccessSnapshot` row. A later pull, or a future transport that
  writes `VERIFIED` on a NEW snapshot, cannot change what an already-closed
  campaign certified. The integration fixture sets the live row to the OPPOSITE
  of the frozen value on both sides, so a live read fails it.
- **Truncated and unverified is `CAMPAIGN_TRUNCATED`, alone.** R3 has one result
  per unit, as every attribute does. Truncation is the observed fact: the campaign
  is known to have left accounts out. Unverified coverage says only that nobody
  can tell whether the snapshot left any out. When both hold, the stronger,
  observed fact is the one the finding names. Raising both would put two
  proposals on one attribute. The unverified coverage surfaces on the next
  campaign that is not truncated.
- **MEDIUM, beside `CAMPAIGN_TRUNCATED`.** Both say the campaign may not have
  reached every account, and neither names an account that is live. HIGH is
  reserved for a live account or a control that did not operate.
- **Only `LEGACY_APP`.** Memberships and identity connections have no population
  coverage to read: the membership table and a complete directory sync are
  observed by Inflect itself. Their R3 is unchanged, and the integration test
  holds both a passing and a truncated directory beside the legacy units.
- **Every legacy unit FAILs procedure 2 today.** No transport writes `VERIFIED`,
  so any tenant with a legacy connection and a covering campaign gets one MEDIUM
  finding proposal per legacy application per quarter. That is the decision
  working, not a side effect: the audit stops attesting to a population nobody
  observed. It does not gate the campaign, which runs and closes as before.
- **The skill had to change, so it was re-evaluated.** The narrative skill must
  name every code in `EXCEPTION_SEVERITY` (`audit-narrative-workflow.test.ts`),
  and its evaluation set is bound to its instructions by hash. The set moved to
  v4 with one new task case for the new rule, `legacy-coverage-unverified`. The
  record was re-made by the `Skill evaluation records` workflow, the sanctioned
  route, and never edited. Two runs, both on `claude-sonnet-5-5`:
  - run 40320277655: BELOW_THRESHOLD, task 7/8, nothing written. The one miss was
    the new case, on a `CAMPAIGN_TRUNCATED` needle in `mustNotInclude`. The answer
    was right: it raised `POPULATION_COVERAGE_UNVERIFIED`, concluded FAIL, and
    wrote "so no `CAMPAIGN_TRUNCATED`" to say why that code was not raised. A
    substring cannot tell naming a code from raising it, so the needle was a
    defect in the case. It was dropped. The skill text did not change.
  - run 40320863001: every kind at 100%. Its record is the committed one.
- **Catalogue version unchanged.** `LIBRARY_V1_STATUS` is untouched: the library
  is PROPOSED to internal audit and the provider, and this amends a proposed
  attribute rather than recording either party's act.
