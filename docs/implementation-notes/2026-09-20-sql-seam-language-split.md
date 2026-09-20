# 2026-09-20 — the twelve `codeOf`-on-SQL seams become a LANGUAGE SPLIT (#2644)

**Refs:** #2644 (the issue), #2643 (`sqlCodeOf`), #2671 (the language-split
pattern), #2246 (the Class A ratchet). Companion measurement:
`docs/implementation-notes/2026-09-19-sql-exclusion-delta-measurement.md` §5b/§6.

**No ratchet constant moves in this diff.** Measured, not predicted — §5.

**The extension gate stays shut.** `.sql` is still absent from
`LEXABLE_EXTENSIONS`, `RAW_ASSERTING_FILE_BASELINE` is still 356, and whether
to open the gate (and at which of the measurement's two states) is still the
owner's decision. This is the half that is correct either way: whichever way
that goes, a seam that says `masked` should be masked.

## Design

The measurement found 41 test files reading a `.sql` file, of which **twelve
mask the read with `codeOf` and none with `sqlCodeOf`**. `codeOf` lexes
TypeScript: it blanks `//` and `/* */` and leaves `--` alone. On a migration it
therefore blanks nothing — `codeOf(migration) === migration` for all twelve,
checked — while reading, at the call site, as masked. That is worse than an
honest raw read, because "masked" is what a later reader trusts.

**This was not a seam swap, and that is the whole shape of the change.** All
twelve route `.ts`, `.prisma` and `.tsx` reads through the SAME `read` helper
as their one `.sql` read — `audit-s7` reads 35 `.ts` + 1 `.prisma` through it,
`vendor-monitoring` 28 `.ts` + 3 `.prisma`, `agentic-engine` 16 `.ts`. Pointing
that helper at `sqlCodeOf` would mis-mask every TypeScript read in the file,
trading one wrong masker for another in the other direction.

So each file gains a second, separately NAMED reader — the pattern #2671 used
for markdown / YAML / JSON:

```ts
const read    = (rel: string) => codeOf(fs.readFileSync(…));    // TypeScript, .prisma, .tsx
const readSql = (rel: string) => sqlCodeOf(fs.readFileSync(…)); // migrations only
```

Three of the twelve (`audit-s5`, `audit-s7`, `audit-s9`) do not read their
migration through `read` at all — they spell an inline
`codeOf(fs.readFileSync(path.join(migDir, 'migration.sql'), 'utf8'))` inside the
`it`. Those get `readSqlAbs(abs)` instead, taking the already-joined absolute
path, so the call site keeps its `migDir` shape.

### Which extensions actually flow through each helper — re-derived, not trusted

Per file, every `expect(x).toMatch|toContain(y)` site resolved with
`resolveSubjectMasked` and bucketed by `path.extname` of the resolved label.
The table is the input to the split; the point is that no column is empty
beside `.sql`.

| test file (`tests/guardrails/` stripped) | `.sql` | `.ts` | `.tsx` | `.prisma` | `.md` | unresolved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `agentic-engine-coverage` | 3 | 16 | — | — | 3 | 9 |
| `audit-s5-readiness-scoring` | 2 | 18 | — | 8 | — | 1 |
| `audit-s7-access-reviews` | 1 | 35 | — | 1 | — | 0 |
| `audit-s9-traceability` | 4 | 10 | — | — | — | 8 |
| `bia-coverage` | 4 | 18 | 19 | 5 | — | 7 |
| `framework-delta-coverage` | 3 | 11 | — | — | — | 10 |
| `incident-containment-forensic-coverage` | 3 | 1 | 4 | — | — | 8 |
| `incident-response-coverage` | 4 | 2 | 6 | — | — | 11 |
| `risk-score-provenance` | 8 | 17 | — | — | — | 2 |
| `scanner-ingestion-coverage` | 6 | 19 | — | 2 | — | 8 |
| `vendor-doc-parse-coverage` | 3 | 16 | — | 2 | — | 6 |
| `vendor-monitoring-coverage` | 5 | 28 | — | 3 | — | 3 |
| **total** | **46** | **191** | **29** | **21** | **3** | **73** |

Re-derived AFTER the split, the whole table is byte-identical — same
extensions, same masked/raw split, same unresolved counts. Only which masker
runs on the 46 changed.

## The split that is the actual finding: latent, not live — 0 of 46

The issue's hazard is that a `--` comment can satisfy one of these assertions.
Two separate questions follow, and only the second was in doubt:

**(a) Is any of the 46 satisfied by the migration's existing prose TODAY?
No — 0 of 46.** The measurement could only assess 17 of the 46 (those with a
needle recoverable from a single source line). This pass assesses all 46:

- **22 sites** carry a bare regex or string literal. Each was rebuilt with
  `recoverPattern` / `recoverNeedle` and run against the *comment-only
  projection* of the migration it reads — the mirror image of `sqlCodeOf`,
  every code byte blanked and every comment byte kept. **0 hits.** Positive
  control: all 22 of those same probes DO match the `codeOf` view, i.e. the
  probe reproduces the live assertion rather than silently matching nothing.
- **24 sites** are interpolated —
  ``new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)`` and
  siblings — so no single expansion is "the" needle. Every one of them begins
  with `ALTER TABLE "`, `CREATE POLICY ` or `CREATE UNIQUE INDEX`, so the
  question reduces to whether any migration's comments carry such a prefix at
  all. **0 of 12 do.** Positive control: those prefixes appear in the CODE of
  11 of the 12 (the twelfth, `audit_s7`, is an `ALTER TYPE … ADD VALUE`
  migration with no table DDL, and its single assertion is in the directly
  probed 22).

**(b) Was the mask doing anything? No — and that is demonstrated, not argued.**
See §4. Commenting out the DDL left all twelve guards green before this change
and reddens twelve named tests after it.

**So the per-file verdict is the same for all twelve: none was live-vacuous,
all twelve were one comment away, and the word `masked` was wrong for all
twelve.** Calling that "converted for uniformity" would undersell it and
calling it "twelve live defects" would oversell it. The exposure was latent and
the mask was inert; the conversion makes the mask real.

This says nothing about the 76 UNMASKED `.sql` sites of the measurement's §5a.
They were not assessed there and are not assessed here.

## 4. Mutation proof — 12 of 12, one named test each

**The mutation is the realistic edit, not a synthetic one: comment out the DDL
statement, leaving its text in place as a `--` comment.** That is the shape the
issue names ("the assertion is one comment away from being satisfied by
prose"), it is what a person does to a migration line they are debugging, and
it differs from a clean deletion by exactly two characters.

Run on the SAME tree, twice — once with the `codeOf` seams (main's files
restored from backup), once with the split applied:

| | suites | tests | failed |
| --- | ---: | ---: | ---: |
| **before** the split, DDL commented out | 12 | 154 | **0 — all green** |
| **after** the split, same mutation | 12 | 154 | **12** |

The twelve reds, by name:

| test file | commented-out line | failing test |
| --- | --- | --- |
| `risk-score-provenance` | `rq2_1_score_events:35` `ALTER TABLE "RiskScoreEvent" FORCE ROW LEVEL SECURITY;` | `RQ2-1 — every score write is paired with a provenance event › migration carries RLS (isolation + insert + bypass + FORCE) and the backfill` |
| `framework-delta-coverage` | `framework_version_delta:59` `ALTER TABLE "TenantFrameworkDelta" FORCE ROW LEVEL SECURITY;` | `Framework delta — model hardening › TenantFrameworkDelta has RLS tenant-isolation in a migration + tenant index` |
| `incident-containment-forensic-coverage` | `incident_containment_forensics:48` `ALTER TABLE "IncidentEvidence" ENABLE ROW LEVEL SECURITY;` | `IncidentEvidence junction (P3 schema) › the migration applies Class-A RLS to IncidentEvidence` |
| `audit-s9-traceability` | `audit_s9_mapping_validity:23` `ALTER COLUMN "validFrom" SET NOT NULL,` | `Audit S9 — Cross-Framework Traceability › Gap A — temporal validity window › migration SQL backfills validFrom from createdAt` |
| `audit-s7-access-reviews` | `audit_s7_access_review_escalation:12` `ADD VALUE IF NOT EXISTS 'ACCESS_REVIEW_OVERDUE_ESCALATION';` | `Audit S7 — Access Review Campaigns › schema › migration SQL exists for the audit S7 changes` |
| `audit-s5-readiness-scoring` | `audit_s5_…:14` `ADD COLUMN IF NOT EXISTS "readinessWeightsJson" JSONB;` | `Audit S5 — Audit Readiness & Scoring › schema › migration SQL exists for the audit S5 changes` |
| `scanner-ingestion-coverage` | `scanner_ingestion:45` `CREATE UNIQUE INDEX … "ScannerFinding" ("tenantId", "fingerprint");` | `scanner ingestion — schema + RLS + encryption + dedup › dedups ScannerFinding by a (tenantId, fingerprint) UNIQUE constraint` |
| `agentic-engine-coverage` | `agentic_workflow_engine:65` `ALTER TABLE "WorkflowRun" FORCE ROW LEVEL SECURITY;` | `Agentic engine — scope + model hardening › WorkflowRun + WorkflowStep have RLS tenant-isolation in a migration` |
| `bia-coverage` | `bia_module:89` `ALTER TABLE "BusinessImpactAnalysis" ENABLE ROW LEVEL SECURITY;` | `BIA — schema + RLS + encryption + process attach › applies the canonical RLS triple to both tables` |
| `incident-response-coverage` | `nis2_incident_response:137` `ALTER TABLE "Incident" ENABLE ROW LEVEL SECURITY;` | `NIS2 incident-response — RLS migration › applies the Class-A RLS policy set to all three tables` |
| `vendor-doc-parse-coverage` | `vendor_doc_extraction:87` `CREATE POLICY tenant_isolation ON "VendorDocExtraction"` | `vendor-doc — schema + RLS › applies the RLS triple to both tables` |
| `vendor-monitoring-coverage` | `vendor_monitoring:86` `ALTER TABLE "VendorMonitor" FORCE ROW LEVEL SECURITY;` | `vendor-monitoring — schema + RLS + indexes › applies the RLS triple to both monitoring tables` |

**The red grades the line that was mutated, and that is checked rather than
assumed.** On the pre-change tree the same seven lines were DELETED outright
instead of commented, and exactly the same seven tests reddened (7 failed / 79
passed of 86). So each assertion really is about the line touched, and the only
difference between the green run and the red run is the two characters `-- `.

Every migration was restored from a byte-for-byte backup and the restore
verified by `diff` against it (12 checked, 0 differing) plus a clean
`git status --porcelain prisma/` — not by eye. The five test files temporarily
reverted for the before-half were restored and verified by `md5sum -c`.

## 5. Ratchets — re-derived by running the analysers, before AND after

The measurement predicted the Class A constants would not move while the gate
is shut, and flagged that the masker REGISTRY does affect Class D bucketing. So
both were measured on this tree rather than trusted.

| constant | before (main, the 13 files reverted) | after | moved |
| --- | ---: | ---: | --- |
| `RAW_ASSERTING_FILE_BASELINE` | 356 | **356** | no |
| `AMBIGUOUS_NEEDLE_BASELINE` | 1365 | **1365** | no |
| `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` | 230 | **230** | no |
| `UNANALYSABLE_READ_BASELINE` | 1454 | **1454** | no |

And the Class D skip buckets, which is where the measurement expected movement
if any:

```
before  not-a-file-read 5432 · path-not-constant 917 · binding-not-resolvable 101
        content-transformed 73 · file-not-found 1 · wholeFileReads 5932
after   not-a-file-read 5432 · path-not-constant 917 · binding-not-resolvable 101
        content-transformed 73 · file-not-found 1 · wholeFileReads 5932
```

Byte-identical. `unlexableByExtension['.sql']` is 122 on both sides — the
extension gate drops a `.sql` read at step 2 of `analyseClassA`, which is
*after* subject resolution and *before* the mask check, so swapping which
registered masker runs cannot reach any of these numbers.

**Positive control, because four unchanged numbers and five unchanged buckets
prove nothing on their own.** Repeating the measurement's own registry
experiment on THIS tree — commenting `['sqlCodeOf', sqlCodeOf]` out of
`SOURCE_BLOCKS_MASKERS` — moves everything at once:

```
.sql unlexable       122 → 76     (the 46 converted sites leave the population)
wholeFileReads      5932 → 5886   (−46)
not-a-file-read     5432 → 5490   (+58 = my 46 + the 12 audit-immutability sites)
path-not-constant    917 → 905    (−12, the audit-immutability sites, as §4 of the measurement)
AMBIGUOUS           1365 → 1364
skippedTotal        1454 → 1418
```

So the harness does respond, and the reason nothing moved is the reason that
matters: **`sqlCodeOf` is IN the registry.** Had it not been, this conversion
would have pushed 46 analysed sites into `not-a-file-read` — an UNCAPPED
bucket — i.e. it would have bought a real improvement at the cost of making 46
assertions invisible to the ratchet that counts them. `assertion-reach.ts` was
restored and verified by `md5sum` (`08d53989…` before and after) and `diff`.

These four are zero-headroom and shared with every open PR. A sibling branch is
moving them on its own tree, so **the merged tree must be re-measured** rather
than these figures carried over.

## Files

| file | role |
| --- | --- |
| 12 × `tests/guardrails/*.test.ts` | `readSql` / `readSqlAbs` added; the one `.sql` read repointed; `read` left on `codeOf` |
| `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` | line-pinned citation re-seated `:24/:25` → `:30/:31`; no constant moved |

## Decisions

- **Two helper names, not one.** `readSql(rel)` where the file's own `read`
  takes a repo-relative path; `readSqlAbs(abs)` in the three files whose
  migration read is already an absolute `path.join(migDir, …)`. A single name
  with two path conventions would be the kind of thing a later reader gets
  wrong silently.
- **The line-pinned citations in the Class D ratchet were re-derived, not
  arithmetic.** `audit-s5-readiness-scoring.test.ts:24/:25` became `:30/:31`
  because the new reader and its docblock sit above them. A rotted `file:line`
  proves the CITATION moved, not the claim — so the occurrence counts (3 and 2)
  were re-read from the analyser's own report rather than carried across, and
  the comment beside them now names both seam edits that moved them and tells
  the next person to re-run rather than add.
- **Nothing was done about the 76 unmasked `.sql` sites, the extension gate, or
  the `toHaveLength`-style guards the measurement's §5c flagged.** Each is a
  separate decision and this change is deliberately orthogonal to all three.

## Test population run

`tests/guards` + `tests/guardrails` + `tests/contracts` + `tests/regression` —
**709 suites requested, 709 ran**, 708 passed, 10071 tests passed. The single
failure is `vendored-swagger-ui-matches-dependency.test.ts` (3 tests), which is
the known shared-`node_modules` drift and not this change: `swagger-ui-dist`
resolves to **5.32.14** on disk while `package-lock.json` and `package.json`
both pin **5.32.15**, and the suite reads only `public/swagger-ui/` and
`node_modules/`, neither of which this diff touches. It fails identically on
the unmodified tree.
