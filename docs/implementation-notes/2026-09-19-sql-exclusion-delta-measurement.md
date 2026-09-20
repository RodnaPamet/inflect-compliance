# 2026-09-19 — the `.sql` exclusion delta, measured before anything is re-seated (#2644)

**Issue:** #2644. **Refs:** #2643 (`sqlCodeOf`), #2246 (the Class A ratchet), #2287.

> **Two things in this note were true on 2026-09-19 and are not true now.**
> Read it as the measurement it is, and take the current state from
> `2026-09-20-sql-seam-language-split.md`:
>
> 1. **§5b/§6's twelve `codeOf`-on-SQL seams have been converted** to a
>    `sqlCodeOf` language split (#2644, 2026-09-20). §8's second open
>    question — "whether the twelve should instead be converted" — is
>    therefore closed, which also collapses states 2 and 3 of §4 onto each
>    other. The extension gate is still SHUT and §8's first question (open it,
>    and at which state) is still the owner's.
> 2. **Every ratchet figure below has since moved**, not by this issue's work
>    but by #2671 merging the same evening: `RAW_ASSERTING_FILE_BASELINE`
>    376 → 356, `AMBIGUOUS_NEEDLE_BASELINE` 1419 → 1365,
>    `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` 237 → 230, `UNANALYSABLE_READ_BASELINE`
>    1455 → 1454. The DELTAS this note measures are unaffected — they were
>    measured against the population, not against the constants — but do not
>    quote an absolute from here.

**No ratchet constant moves in this diff, and that is the point.** The owner's decision on
#2644 was *measure first*:

> Count how many `.sql`-reading guards exist and which bucket each newly-visible read lands
> in, *then* decide. The number will go UP, and a rise needs the same three-state
> justification #2643 recorded — base, masked-but-untaught, masked-and-taught — rather than a
> bare re-seat.

`RAW_ASSERTING_FILE_BASELINE` is still 376 and
`tests/guardrails/raw-source-asserting-files.json` still holds 376 entries. The `.sql`
entry is still absent from `LEXABLE_EXTENSIONS`. This note is the measurement; the re-seat
is a separate decision that can now be taken against numbers instead of an estimate.

---

## 1. Where the extension gate sits, and what that implies before any counting

`analyseClassA` (`tests/helpers/raw-source-assertions.ts`) classifies every
`expect(x).toMatch|toContain(y)` site in four steps, **in this order**:

1. `resolveSubjectMasked(site.subject, sf)` tries to resolve the subject to the whole text of
   a file on disk. Failure lands in `subjectSkips` under one of five reasons
   (`not-a-file-read`, `path-not-constant`, `binding-not-resolvable`, `content-transformed`,
   `file-not-found`) and the site is **done** — it never reaches step 2.
2. The site is counted as a whole-file read, and `extensionOf(result.label)` is checked
   against `LEXABLE_EXTENSIONS`. A miss lands in `unlexableLanguageSites` +
   `unlexableByExtension`.
3. Masked reads (any masker the analyser can reproduce exactly — today `codeOf` and
   `sqlCodeOf` in `SOURCE_BLOCKS_MASKERS`) go to `maskedSites`.
4. Everything left is a RAW site, and its **test file** joins `rawFiles` — the ratcheted
   population.

**The extension gate is step 2, downstream of step 1.** So adding `.sql` to
`LEXABLE_EXTENSIONS` cannot move a single site out of `path-not-constant` or any other skip
bucket: a read the analyser could not resolve to a file has no extension to test. Measured
rather than argued — the five skip counts are **byte-identical** with `.sql` in the set and
with it out:

```
not-a-file-read 5422 · path-not-constant 918 · binding-not-resolvable 101
content-transformed 73 · file-not-found 1
```

That matters for reading the issue, which expected the count to rise partly *because* "some
of those reads will be genuinely un-analysable (`path.join(migrationDir, <runtime>, …)` — the
shape the existing `path-not-constant` bucket already holds)". Those reads exist (§5c names all 24 of them), but they neither enter nor leave Class A when the gate opens. **The number
does go up — by a different mechanism than the issue predicted.**

## 2. Method, and the controls that say the method worked

A throwaway harness (not committed) walked `testFilesUnder(['tests'])` and recorded, for
every site, either its skip reason or `{extension, masked, negated, label}` — i.e. enough to
recompute the population under any extension set from one pass. Three controls:

- **Against the shipped analyser.** The same harness ran the unmodified `analyseClassA` over
  the same file list. All eight aggregates match exactly (`sites` 12447, `wholeFileReads`
  5932, `rawSites` 4369, `negatedRawSites` 415, `maskedSites` 1096,
  `unlexableLanguageSites` 467, `rawFiles` 376, `maskedOnlyFiles` 75), and `rawFiles` matches
  as an ordered set, not just a length.
- **Against the committed baseline.** The measured 376-file population is set-equal to
  `tests/guardrails/raw-source-asserting-files.json` — zero added, zero fixed. A perturbed
  copy of the same comparison returns false, so the equality is not vacuous.
- **Against the ratchet itself.** `CI=1 jest tests/guardrails/raw-source-assertion-ratchet.test.ts`
  — 1 suite requested, 1 suite ran, 13 tests passed, exit 0, on the tree this note ships
  against.

## 3. Denominators

| quantity | count |
| --- | ---: |
| test files git lists under `tests/` (`.ts` + `.tsx`) | 2434 |
| `toMatch` / `toContain` sites in them | 12447 |
| …resolving to a whole-file read | 5932 |
| test files holding **≥1** whole-file read (read source at all) | 470 |
| …of those, reading a **`.sql`** file | **41** |
| `.sql` whole-file read sites | **122** |

The 122 is `unlexableByExtension['.sql']` today, i.e. the exclusion's own report of what it
is dropping. The rest of that bucket is `.md` 215, `.yml` 85, `.css` 22, `.example` 12,
`.json` 7, `.yaml` 2, extension-less 2 — 467 sites in total, of which `.sql` is 26%.

## 4. The three states

| state | `.sql` counted? | what counts as a mask on a `.sql` read | `rawFiles` | raw sites | masked sites | unlexable |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| **1 — base** (today) | no | — | **376** | 4369 (415 neg) | 1096 | 467 |
| **2 — counted, untaught** | yes | `codeOf` accepted, as for any other lexable file | **382** | 4445 (416 neg) | 1142 | 345 |
| **3 — counted, taught** | yes | only a SQL-aware mask (`sqlCodeOf`) | **391** | 4491 (416 neg) | 1096 | 345 |

State 2 is the one-line change — add `'.sql'` to `LEXABLE_EXTENSIONS`, nothing else. It
scores **9 better** than state 3, and §6 is why that 9 is a coverage regression dressed as an
improvement: every one of those 9 files is credited with a mask that cannot see a SQL
comment.

The middle row of #2643's own table behaved the same way (it scored 5 better by leaving
`sqlCodeOf` unregistered), and the mechanism is worth re-confirming rather than assuming, so
the registry experiment was repeated here: removing `['sqlCodeOf', sqlCodeOf]` from
`SOURCE_BLOCKS_MASKERS` moves **12 sites** (all in
`tests/guards/audit-immutability-guardrails.test.ts`) from `path-not-constant` — capped by
`UNANALYSABLE_READ_BASELINE` — into `not-a-file-read`, which is capped by nothing. It moves
no whole-file read and no `rawFiles` entry, because no `.sql` read in this tree is masked
with `sqlCodeOf` at all (§6). The file was restored from a byte-for-byte backup afterwards
and verified by `md5sum` + `diff`.

## 5. Bucket by bucket, with every file named

### 5a. Analysable and UNMASKED — 76 sites across 29 files

These are the reads that make the number move in state 2. Twenty-three of the 29 files are
**already** in the 376 for their TypeScript reads, so they cost nothing; the six marked *new*
are the whole of the `376 → 382` delta.

| test file (`tests/` stripped) | raw `.sql` sites | migration read | already in the 376? |
| --- | ---: | --- | --- |
| `guardrails/ai-gov-self-assessment-coverage.test.ts` | 2 | `20260629140000_add_ai_gov_self_assessment` | **no — new** |
| `guardrails/audit-s1-residual-and-mitigated.test.ts` | 2 | `20260524100000_audit_s1_risk_residual_and_mitigated` | **no — new** |
| `guardrails/audit-s2-control-testing.test.ts` | 1 | `20260524110000_audit_s2_testplan_archived` | yes |
| `guardrails/audit-s3-evidence-mgmt.test.ts` | 1 | `20260524120000_audit_s3_evidence_needs_review` | **no — new** |
| `guardrails/audit-s6-vendor-risk.test.ts` | 1 | `20260524140000_audit_s6_vendor_review_due` | yes |
| `guardrails/cve-integration-coverage.test.ts` | 4 | `20260628130000_vuln_nvd_cve_integration` | **no — new** |
| `guardrails/nis2-gap-assessment-coverage.test.ts` | 5 (1 negated) | `20260626140000_add_nis2_gap_assessment` | yes |
| `guardrails/risk-quantitative-analytics.test.ts` | 2 | `20260524180000_b10_risk_quantitative` | **no — new** |
| `guards/ai-decision-log.test.ts` | 3 | `20260703130000_ai_decision_log` | yes |
| `guards/device-connector.test.ts` | 3 | `20260707120000_device` | yes |
| `guards/entra-ei2-group-mapping.test.ts` | 6 | `20260609090000_ei2_tenant_entra_group_mapping` | yes |
| `guards/entra-ei3-scim-groups.test.ts` | 3 | `20260610320000_ei3_scim_group` | yes |
| `guards/identity-providers-connector.test.ts` | 5 | `20260707100000_connected_identity_account` | yes |
| `guards/nis2-gap-assessment.test.ts` | 1 | `20260702090000_nis2_assessment_source` | yes |
| `guards/notif-assignment-alerts-wiring.test.ts` | 3 | `20260527160000_notif_control_assigned` | yes |
| `guards/p5a-snapshots-table-sidebar.test.ts` | 7 | `20260526100000_p5_pra_process_map_snapshot` | yes |
| `guards/personnel-connector.test.ts` | 4 | `20260707110000_personnel` | yes |
| `guards/questionnaire-ai.test.ts` | 2 | `20260707160000_inbound_questionnaire` | yes |
| `guards/rq10-reporting.test.ts` | 1 | `20260610280000_rq10_reporting` | yes |
| `guards/rq3-1-simulated-lec.test.ts` | 1 | `20260612000000_rq3_1_simulation_p80` | yes |
| `guards/rq3-3-portfolio-honesty.test.ts` | 1 | `20260612020000_rq3_3_tested_percentile` | yes |
| `guards/rq3-6-loss-event-register.test.ts` | 7 | `20260612040000_rq3_6_loss_event_register` | **no — new** |
| `guards/rq3-monte-carlo.test.ts` | 1 | `20260610160000_rq3_monte_carlo` | yes |
| `guards/rq4-scenarios.test.ts` | 1 | `20260610180000_rq4_scenarios` | yes |
| `guards/rq5-hierarchy.test.ts` | 2 | `20260610200000_rq5_hierarchy` | yes |
| `guards/rq6-kri.test.ts` | 2 | `20260610220000_rq6_kri` | yes |
| `guards/rq8-correlation.test.ts` | 1 | `20260610240000_rq8_correlation` | yes |
| `guards/training-connector.test.ts` | 2 | `20260707130000_training_background` | yes |
| `guards/trust-center-gated.test.ts` | 2 | `20260707150000_trust_center_gated_docs` | yes |

### 5b. Analysable and MASKED — 46 sites across 12 files

No file appears in both 5a and 5b: each of the 41 is wholly masked or wholly raw for its
`.sql` reads. Three of these twelve are already in the 376 for other reasons; the nine marked
*new in state 3* are the `382 → 391` difference.

| test file (`tests/` stripped) | masked `.sql` sites | migration read | already in the 376? |
| --- | ---: | --- | --- |
| `guardrails/agentic-engine-coverage.test.ts` | 3 | `20260701150000_agentic_workflow_engine` | **no — new in state 3** |
| `guardrails/audit-s5-readiness-scoring.test.ts` | 2 | `20260524130000_audit_s5_readiness_snapshot_and_weights` | **no — new in state 3** |
| `guardrails/audit-s7-access-reviews.test.ts` | 1 | `20260524150000_audit_s7_access_review_escalation` | **no — new in state 3** |
| `guardrails/audit-s9-traceability.test.ts` | 4 | `20260524160000_audit_s9_mapping_validity` | **no — new in state 3** |
| `guardrails/bia-coverage.test.ts` | 4 | `20260701130000_bia_module` | yes |
| `guardrails/framework-delta-coverage.test.ts` | 3 | `20260701160000_framework_version_delta` | **no — new in state 3** |
| `guardrails/incident-containment-forensic-coverage.test.ts` | 3 | `20260629120000_incident_containment_forensics` | yes |
| `guardrails/incident-response-coverage.test.ts` | 4 | `20260628120000_nis2_incident_response` | **no — new in state 3** |
| `guardrails/risk-score-provenance.test.ts` | 8 | `20260611100000_rq2_1_score_events` | **no — new in state 3** |
| `guardrails/scanner-ingestion-coverage.test.ts` | 6 | `20260701120000_scanner_ingestion` | yes |
| `guardrails/vendor-doc-parse-coverage.test.ts` | 3 | `20260701140000_vendor_doc_extraction` | **no — new in state 3** |
| `guardrails/vendor-monitoring-coverage.test.ts` | 5 | `20260701150000_vendor_monitoring` | **no — new in state 3** |

### 5c. UN-ANALYSABLE — 24 sites across 6 files, and they do not move

These are assertions whose subject genuinely is the text of a `.sql` file and which the
analyser does not resolve to a whole-file read. They sit in `subjectSkips` today and sit
there unchanged in states 2 and 3.

| test file | sites | bucket | why the analyser cannot follow it |
| --- | ---: | --- | --- |
| `tests/guards/audit-immutability-guardrails.test.ts` | 12 (`:743-747`, `:800-814`) | `path-not-constant` | genuinely runtime: `path.join(migrationDir, <dir found by readdirSync + find>, 'migration.sql')` |
| `tests/unit/digest-enum-schema-alignment.test.ts` | 4 (`:86-88`, `:110`) | `path-not-constant` | **constant in source**: `resolve(MIGRATION_DIR, 'migration.sql')` with a bare `resolve` imported from `node:path` |
| `tests/guardrails/pii-hash-not-null.test.ts` | 1 (`:96`) | `path-not-constant` | **constant in source**: `join(MIGRATIONS_DIR, '<literal dir>', 'migration.sql')`, same bare-import spelling |
| `tests/guardrails/mcp-propose-coverage.test.ts` | 4 (`:122-125`) | `not-a-file-read` | the read helper is a conditional — `CODE_FILE.test(rel) ? codeOf(raw) : raw` |
| `tests/guardrails/internal-controls-coverage.test.ts` | 2 (`:273`, `:274`) | `not-a-file-read` | same conditional helper, plus a template path built from a `readdirSync` find |
| `tests/guards/rq2-6-appetite-lec.test.ts` | 1 (`:156`) | `not-a-file-read` | `readSql = maskSqlComments(readRaw(rel))`, and `maskSqlComments` replaces with *functions*, which `reconstructReplaceChain` refuses by design |

Two of those rows are worth separating out, because they are not the shape the issue
describes. `foldString` folds a path only when it is spelled as a property access on an
identifier literally named `path` (`path.join` / `path.resolve`). A bare `join(...)` or
`resolve(...)` from `import { join } from 'node:path'` is a **constant path the analyser
declines to fold** — five of the 17 `path-not-constant` SQL sites are that, not a runtime
lookup. Calling them "un-analysable" would be true of the analyser and false of the code.

**How that population was enumerated, and its denominator.** `git grep -l` for
`\.sql|prisma/migrations|migrationsDir|migrationDir` over the 2434 test files returns **78**
candidates. All 41 files from §5a/§5b are inside that 78 — the positive control that the
grep covers the population it is being used to extend — leaving 37 read one by one; 6 carry
SQL-subject assertions and are tabled above. The other 31 either assert on TypeScript reads
that merely mention a migration path, or do not assert on the SQL text at all.

**One caveat this measurement cannot close.** Class A collects only `toMatch` and
`toContain`. A guard that reads a migration and asserts with a different matcher is not in
the population at any state — `tests/integration/agent-registry-legacy-backfill.test.ts`
reads `20260904120000_agentic_agent_registry/migration.sql` at a constant path and asserts
with `expect(statements.filter((s) => s.includes('INSERT INTO "AiSystem"'))).toHaveLength(1)`,
which yields zero collected sites. Such guards are equally satisfiable by prose and equally
invisible; widening the matcher set is a separate question from widening the extension set.

## 6. The finding that should decide the re-seat: all 46 "masked" `.sql` reads are masked with `codeOf`

Every one of the 12 files in §5b masks its read seam with `codeOf` — the TypeScript lexer —
and none of them uses `sqlCodeOf`. Two independent checks agree. First, `sqlCodeOf` is
*called* in exactly two test files — `tests/guards/audit-immutability-guardrails.test.ts`
(3 call sites, every resulting assertion `path-not-constant`) and its own unit test
`tests/unit/source-blocks-helpers.test.ts` (10) — out of five files that mention the name at
all, the other three being the definition, the masker registry and a comment. Second,
unregistering `sqlCodeOf` from `SOURCE_BLOCKS_MASKERS` changed the classification of **zero**
`.sql` whole-file reads.

This is the exact hazard the issue names, and it is now measured rather than reasoned:

- **Control A.** On three of the twelve migrations, the first `--` comment line **survives
  `codeOf` verbatim** (3/3) and is **removed by `sqlCodeOf`** (3/3); both transforms preserve
  length, so offsets still line up either way.
- So in state 2 the ratchet would record 46 sites in 12 files as *masked* — i.e. as the
  fixed state this whole line of work is converging on — while a `--` comment in the
  migration remains able to satisfy any of them. That is strictly worse than counting them
  raw, because "masked" is what a later reader trusts.

**Is it live today, or only latent?** All 12 migrations carry at least one `--` comment. Of
the 46 sites, 17 have a needle recoverable from a single source line; **0 of those 17** are
satisfied by the comment-only text of the file they read. The remaining 29 are multi-line
assertions and were not assessed — that is the honest denominator, not a clean bill. Control
B confirms the check can report a hit: a word drawn from each migration's comments is found
in the comment-only projection for 3/3 sampled files, so the zero is a real zero rather than
a broken matcher. The exposure is therefore **latent, one comment away**, which is precisely
the standing this ratchet exists to measure (`raw-source-assertions.ts`: "the assertion is
one comment away from being satisfied by prose, and nothing tells anyone when that day
comes").

**Scope of that zero, stated so nobody widens it by accident.** §6 assesses the 46
**masked** sites only, because the finding it supports is about the word *masked* being
wrong for them. The 76 **unmasked** `.sql` sites of §5a were **not** assessed for current
vacuity at all. A review of this measurement suggested two of them are already satisfied by
a comment today; re-checking the one it named —
`tests/guards/p5a-snapshots-table-sidebar.test.ts:101`, asserting
`/FORCE ROW LEVEL SECURITY/` — the phrase occurs **twice** in the migration it reads: once
in a `--` comment at line 14 and once as real DDL at line 53
(`ALTER TABLE "ProcessMapSnapshot" FORCE ROW LEVEL SECURITY;`). So it is latent in exactly
the sense above, not live. That is the distinction worth preserving: *satisfied by prose
today* and *one deletion away from being satisfied by prose* are different states, and only
the first is a defect you can ship. Assessing the 76 is real work and is not done here.

## 7. What each constant would move by, and in which direction

| constant / artefact | today | state 2 | state 3 |
| --- | ---: | ---: | ---: |
| `RAW_ASSERTING_FILE_BASELINE` (`raw-source-assertion-ratchet.test.ts`) | 376 | **382** (+6, UP) | **391** (+15, UP) |
| `tests/guardrails/raw-source-asserting-files.json` (entries) | 376 | **382** (+6) | **391** (+15) |
| `UNANALYSABLE_READ_BASELINE` (`assertion-needle-uniqueness-ratchet.test.ts`) | 1455 | unchanged | unchanged |
| `AMBIGUOUS_NEEDLE_BASELINE` (same file) | 1419 | unchanged | unchanged |
| `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` (same file) | 237 | unchanged | unchanged |
| Class C constants (`assertion-span-reach-ratchet.test.ts`) | — | unchanged | unchanged |

The two baselines in row 1 and row 2 are one number written twice and the ratchet's first
test asserts they agree, so they move together or not at all.

Rows 3-6 are unchanged for a structural reason, not an empirical one: `LEXABLE_EXTENSIONS` is
exported from `tests/helpers/raw-source-assertions.ts` and has **no importer anywhere else** —
grep over `tests/`, `scripts/` and `src/` returns only its own definition and the Class A
ratchet's references to report fields. Class C and Class D import from
`tests/helpers/assertion-reach.ts` only, and neither contains an extension filter of any
kind (`extname` / `LEXABLE` / `.sql` all return nothing in either ratchet file).

**What else turns red with `.sql` in the set**, and it is not only constants:

- `raw-source-assertion-ratchet.test.ts:460` — the detector proof
  `excludes a language codeOf cannot lex, and says which` asserts
  `unlexableByExtension['.sql'] === 1` and `rawSites` empty on a synthetic `.sql` read. It
  fails by construction and needs rewriting to whatever the new contract is.
- `FIX_ADVICE` in the same file (`:227-230`) tells the reader `.sql` is excluded and to write
  a per-language reader. That prose stops being true.
- The `1448 → 1455` note in `assertion-needle-uniqueness-ratchet.test.ts` records that
  `RAW_ASSERTING_FILE_BASELINE` was unchanged "(`.sql` is excluded from Class A by
  extension…)". Still accurate history; it becomes a stale rationale the day the gate opens.

## 8. What this measurement does not decide

- Whether to open the gate at all, and at which of the two states. That is the owner's call,
  and it is now a choice between +6 with nine files credited for a mask that cannot see a SQL
  comment, and +15 with nobody credited for one.
- Whether the twelve `codeOf`-on-SQL seams should instead be converted to `sqlCodeOf`. That
  would make states 2 and 3 identical, leave `RAW_ASSERTING_FILE_BASELINE` at **382** rather
  than 391, and is a real change to twelve guards rather than a ratchet edit. It is also the
  only route by which the +15 comes back down — masking a raw `.sql` read at the seam with a
  SQL-aware masker moves it from `rawFiles` to `maskedSites`, and the six new files of §5a
  carry no other raw reads, so converting them alone returns the count to 376.
- Anything about `.md` (215 sites), `.yml` (85) or the remaining 345 unlexable sites. They
  were counted here only as the denominator `.sql` sits inside.

## 9. Reproducing this

The harness was deliberately not committed — it is thirty lines against a stable API, and a
stale copy in `tests/` would itself join the population it measures. To rebuild it:

1. Walk `testFilesUnder(['tests'])` from `tests/helpers/assertion-reach.ts`.
2. Per file: `parseTestFile`, then for each `collectExpectSites(sf)` site call
   `resolveSubjectMasked(site.subject, sf)` and record the skip reason, or
   `{path.extname(label), masked, negated, label}` — that is every input the four-step
   classification of §1 consumes.
3. Recompute the population under each extension set from that one pass, and cross-check the
   base state against the unmodified `analyseClassA` and against
   `raw-source-asserting-files.json`, as §2 does.
4. For the untaught row, comment out `['sqlCodeOf', sqlCodeOf]` in `SOURCE_BLOCKS_MASKERS`,
   re-run, restore from a backup, and verify the restore with `md5sum` — not by eye.

On this machine the full walk over 2434 files takes ~7 seconds, so every number here is
cheap to re-derive rather than to trust.
