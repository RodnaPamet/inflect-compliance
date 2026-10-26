# 2026-10-26 — procedure 2's R3 does not pass a legacy campaign of unverified coverage: catalogue version 2 (#3325, #4379)

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

### Catalogue version 2

The catalogue's own rule is that a change to a procedure raises the catalogue
version, and the owner decided (2026-10-26) that this is version 2, not a
reading of version 1. Step issue #4379 records internal audit's approval and the
provider's agreement of version 2 when given, as #3663 does for version 1.

```
AUDIT_PROCEDURE_CATALOGUE_VERSION   1 → 2   every new workpaper records 2
CATALOGUE_VERSION_STATUS            new     { 1: …OPEN, #3663;  2: …OPEN, #4379 }
LIBRARY_V1_STATUS                   derived the version in force's row, plus status PROPOSED
LIBRARY_V1_STATUS_SENTENCE          names #4379 for version 2 and #3663 for version 1
reliance pack summary               catalogue.byVersion, limits judged per version held;
                                    RELIANCE_SNAPSHOT_VERSION 1 → 2
```

A workpaper written under version 1 keeps `catalogueVersion: 1`. The row is
write-once, and every reader takes the version from the row. The database only
CHECKs `catalogueVersion >= 1`, so version 2 needs no migration.

**Re-running a period that already holds a version 1 workpaper.** The
first-sample-is-binding rule is keyed on (tenant, procedure, period) in both the
insert trigger and `AuditWorkpaperRepository.findBindingSample`; the catalogue
version is not part of it. So a version 2 run of such a period writes a SECOND
workpaper, recording version 2, on the version 1 sample, and judges that sample
by version 2's rules. It is not refused, and the version 1 row is untouched.
That is right for this version: version 2 changes an attribute, not a
population or the draw, so the version 1 sample is the one a version 2 run
would have drawn. A later version that changes a population or the draw would
meet the same key and be held to the earlier sample; that is a decision for
that version, and needs the trigger.

## Files

| File | Role |
|---|---|
| `src/app-layer/services/audit-procedures/recertification-completeness.ts` | R3 moves into `r3CoveredWholePopulation`: truncation, then — for `LEGACY_APP` only — the frozen coverage |
| `src/lib/agentic/audit-procedure-library.ts` | `POPULATION_COVERAGE_UNVERIFIED: 'MEDIUM'` in `EXCEPTION_SEVERITY`; `CATALOGUE_VERSION_STATUS` per version, `LIBRARY_V1_STATUS` derived from it, the sentence naming both issues |
| `src/lib/agentic/audit-workpaper.ts` | `AUDIT_PROCEDURE_CATALOGUE_VERSION` 1 → 2 |
| `src/lib/agentic/audit-reliance.ts` | `catalogue.byVersion`; the catalogue limits judged per version the pack holds; snapshot version 2 |
| `src/app-layer/services/audit-procedures/index.ts` | a refused run's evidence names the catalogue version beside the standing |
| `src/lib/agentic/flue/skills/iam-audit-procedures/SKILL.md` | names the code under R3; version 3 → 4; `sourceRef` names catalogue version 2 |
| `src/lib/agentic/flue/skills/iam-audit-procedures/evaluation-set.json` | version and content hash to v4; one new task case, `legacy-coverage-unverified` |
| `src/lib/agentic/flue/skills/iam-audit-procedures/evaluation-record.json` | re-recorded by the `Skill evaluation records` workflow against the v4 set — never edited by hand |
| `docs/agentic-audit-procedures.md` | catalogue version 2: the status paragraph, "Changes from version 1", procedure 2's R3 row, why R3 asks a legacy application a second question, the exception paragraph, the binding rule across versions |
| `docs/agentic-audit-reliance-memo.md` | memo version 2, for catalogue versions 1 and 2 |
| `docs/agentic-iam-roadmap.md`, `docs/agentic-iam-managed-service.md` | the version in force and where each version's acts are recorded |
| `docs/legacy-access-recertification-design.md` | the auditor reads the coverage through the same reader and does not pass it |
| `tests/integration/audit-procedures.test.ts` | the R3 truth table through the module, a run that FAILs on it alone and records version 2, and a version 2 run of a period holding a version 1 workpaper |
| `tests/unit/agentic/audit-procedure-library.test.ts` | the code's severity sits with `CAMPAIGN_TRUNCATED`; the version in force and each version's standing |
| `tests/unit/agentic/audit-workpaper-contract.test.ts` | the contract takes version 2 and version 1, and refuses 3 |
| `tests/unit/agentic/audit-reliance.test.ts` | a pack holding version 1 and version 2 workpapers |
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
- **"Library v1" keeps its name.** It names the set, procedures 1 to 5, and
  version 2 changes one attribute of one of them, not the set. Renaming the
  `LIBRARY_V1_*` identifiers would touch every evidence row, proposal and
  reliance statement to say nothing new. The catalogue version is what moved,
  and the status now says which version it describes.
- **Standing per version, every value OPEN.** `CATALOGUE_VERSION_STATUS` holds
  one row per version, each naming its issue. No value claims an approval or an
  agreement. `LIBRARY_V1_STATUS` is derived from the row of the version in
  force, so the version a workpaper records and the standing its evidence states
  cannot disagree, and a constant set to a version with no row fails `tsc`.
- **The reliance pack judges each version it holds.** It used to read the
  limits off the single status object, which is right while there is one
  version. With two, a pack holding version 1 workpapers would lose
  `CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT` the day version 2 alone was
  approved. The limits now hold unless every version the pack holds lifts them,
  and a version this build does not know fails closed. The pack also states
  each version's standing (`catalogue.byVersion`), which changes the snapshot's
  shape, so `RELIANCE_SNAPSHOT_VERSION` is 2.
- **The reliance memo is version 2.** Its own rule says a change that alters a
  procedure raises its version. The external auditor's conclusion on version 1
  covers workpapers that were all written under catalogue version 1; none is
  recorded on version 2.
- **The skill was not re-recorded for the version.** The catalogue version
  appears only in the skill's `sourceRef` frontmatter, and the content hash is
  over the instructions alone, so the record still matches. The instructions
  say "library v1", the set's name, which stands.
- **The write contract still takes version 1.** Only the handler writes
  workpapers, with the constant. The contract's range is 1 to the version in
  force, so the version 1 rows other suites write as fixtures stay valid.
