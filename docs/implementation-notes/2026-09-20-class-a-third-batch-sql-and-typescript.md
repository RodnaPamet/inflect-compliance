# 2026-09-20 — Class A batch three: the six `.sql` seams plus sixteen TypeScript seams (#2246)

**Refs:** #2246 (the campaign), #2644 / #2690 (the `.sql` gate that opened at
+6), #2679 (the language-split pattern), #2671 / #2678 (batches one and two).

**ONE BRANCH, TWO HALVES, DELIBERATELY.** Both halves move
`RAW_ASSERTING_FILE_BASELINE`. Split across two PRs they would each look right
alone and collide on the union — the failure mode
`docs/implementation-notes/`'s own history keeps re-learning.

## Design

Class A is: *a guard reads a source file and asserts against RAW text, so a
comment mentioning the thing satisfies an assertion meant to be about code.*
The fix is a mask at the READ SEAM, not at each assertion — one line converts
every assertion in a file, and comments are blanked while string literals are
KEPT, so `data-testid="…"` and `code: 'CC1.1'` assertions still bind.

### Part A — the six `.sql` seams, with `sqlCodeOf` and not `codeOf`

#2690 added `.sql` to `LEXABLE_EXTENSIONS`, which raised the baseline
338 → 344: six files whose migration reads carry no mask at all became
visible. They are converted here with **`sqlCodeOf`** — `codeOf` lexes `//`,
so a SQL `--` comment survives it verbatim and the call site would read as
masked while masking nothing, which is the exact defect #2679 closed for
twelve other files.

Each file gains a **separately named reader**, not a swapped one:

```ts
const read    = (rel: string) => codeOf(fs.readFileSync(…));     // .ts / .tsx / .prisma
const readSql = (rel: string) => sqlCodeOf(fs.readFileSync(…));  // migrations only
const readSqlAbs = (abs: string) => sqlCodeOf(fs.readFileSync(abs, 'utf8'));
```

`readSqlAbs` is for the two call sites that already join `migDir` themselves
(`audit-s1`, `audit-s3`), keeping the call-site shape #2679 settled on.

**Which extensions flow through each helper was re-derived per file, not
assumed.** Across the six: **18 `.sql` sites (all raw), 116 non-`.sql` sites
(all already masked)** — 86 `.ts`, 21 `.tsx`, 9 `.prisma`. That is why
converting these six alone returns the count to 338: they carry no other raw
read. Measured, not inferred from the +6.

### Part B — sixteen further seams, chosen by measured prose exposure

**Fourteen read only TypeScript-alikes; two do not.**
`p5a-snapshots-table-sidebar` (7 `.sql` sites beside 29 `.prisma`/`.ts`/`.tsx`)
and `device-connector` (3 beside 16) also read a migration, so they take Part
A's language split in the same diff. The extension inventory was re-derived
per file here too — the directory a test lives in says nothing about the
languages it reads, and riding one mask across two of them is the defect #2679
closed.

Same ranking method as batches one and two: for every raw site the needle is
counted in its target **twice**, once on the raw text and once through the
mask its language deserves, and a file is a candidate only where some needle
matches **fewer times masked**. On the 338-file tree:

| | count |
|---|---|
| raw whole-file assertion sites | 3574 |
| …needle unscorable (loop var, interpolation, flagged regex, span) | 220 |
| …prose-inflated (masked < raw) | 200, across 126 files |
| …already matching ZERO times in code | 31, across 24 files |

The 31 zero-occurrence sites fall across **24 files, triaged one by one**
rather than taken off the top:

- **10** are the files the ratchet's history already names as deliberate —
  six from the 381 entry that assert a COMMENT is present (a CC BY 4.0
  attribution, an "OVERDUE semantics" rationale), four that batch two left
  holding a second raw reader. Masking those would delete the thing asserted.
- **11** assert a sentence on purpose: `/deliberate/`,
  `/optimistic-concurrency/`, `"Risk matrix configuration"`,
  `/NOT a simulated loss distribution/` — each a section header or rationale
  in the target's own comments.
- **3** were real defects, and all three are in this batch.

Beyond the 24, the sixteen were chosen by how much raw exposure each removes:
they carry **501 of the 3574** raw sites.

**One lead is left for batch four rather than fixed here.**
`mobile-canvas-fallback`'s `it("tells the user editing is a desktop
affordance")` asserts `/larger screen|desktop/i`, and all three occurrences in
`ProcessesClient.tsx` are comments — the signature of user-visible copy that
migrated to next-intl, the same shape `org-shell-structural` had in #2678. It
is not in this batch because retargeting it needs the catalogue resolution
that shape requires, and this diff is already four retargets deep.

## Files

| file | role |
| --- | --- |
| 6 × `tests/guard*/…` (Part A) | `readSql` / `readSqlAbs` added; the one migration read repointed; `read` left on `codeOf` |
| 16 × `tests/{guards,unit}/…` (Part B) | read seam routed through `codeOf`; four retargeted assertions |
| `tests/guardrails/raw-source-assertion-ratchet.test.ts` | `RAW_ASSERTING_FILE_BASELINE` 344 → 322 + history entry |
| `tests/guardrails/raw-source-asserting-files.json` | the same 22 files removed from the set-equality list |
| `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` | `AMBIGUOUS_NEEDLE_BASELINE` 1333 → 1319; `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` 226 → 218 |
| `tests/guardrails/assertion-span-reach-ratchet.test.ts` | `INTERIOR_SPAN_BASELINE` 332 → 330 |
| `tests/helpers/raw-source-assertions.ts` | two additive per-extension counters so the `.sql` liveness control can stand on a conversion-invariant quantity |

## Decisions

- **Four guards were already green on prose, and only three were predicted.**
  `new-risk-modal` asserted `form.title.trim().length > 0 … !submitting`, a
  phrase that survives in `NewRiskModal.tsx` **only inside the comment
  recording its removal** — the canonical shape of this issue. `sheet.tsx`
  carries `direction="right"` only in the docblock offering it as a consumer
  opt-out. `evidence-upload-modal`'s close-on-success span reached
  `onAllSettled` in a COMMENT, because the shipped callback is more than the
  span's 400 characters from `allOk`. The fourth, `modal-primitive`, asserted
  `bg-bg-default` — replaced by `surface-popup-texture`, with only the comment
  recording the swap left. All four are retargeted at what ships.

- **The ranking under-counts, for a THIRD distinct reason.** Batch one found
  a flagged regex; batch two a loop variable in `org-shell-structural`;
  `modal-primitive` is a loop variable again (`for (const token of [...])
  expect(src).toContain(token)`), so `recoverNeedle` returns
  `needle-not-literal` and the site is unscorable — 211 of 3574 here. The
  remedy has been the same all three times: **run the converted suites**, and
  treat the ranking as a search order rather than as the population.

- **Four reads moved OFF `codeOf` rather than onto it.** `messages/en.json`
  in three files and `src/data/libraries/nist-csf-2.0.yaml` in
  `aws-posture-connector` are not languages `codeOf` lexes. Neither carries a
  `//` today, so masking them is a no-op **today** — and would stop being one
  the moment a URL lands in either. That is precisely how twelve `.sql` seams
  read as masked while masking nothing until #2679, so the same rule is
  applied in the same diff that relies on it.

- **A `*/` inside a JSDoc closes it.** One conversion put ``` `/* */` ``` in a
  block comment describing what `sqlCodeOf` lexes, which terminated the
  docblock and left a file that no longer parsed. Nothing failed loudly: the
  TypeScript parser is error-tolerant, the suite still ran, and the only
  visible symptom was the analyser's own denominator dropping by four
  (`sites` 12500 → 12496). Caught by printing the denominator beside the
  answer; fixed by naming SQL block comments in prose rather than spelling
  them.

- **One guard went red on a correct conversion, and the guard was wrong.**
  `raw-source-assertion-ratchet`'s liveness control for the `.sql` gate
  asserted `rawSites.filter(… '.sql').length > 50`. But masking a migration's
  read seam MOVES its sites from raw to masked — it removes no read — so this
  batch took raw `.sql` 76 → 48 and tripped the floor while the count of `.sql`
  reads the analyser ADMITS stayed at 122. **Part A alone is 76 → 58, which
  clears the floor**; 48 needs Part B's two migration-reading files as well
  (`p5a-snapshots-table-sidebar` 7 raw `.sql` sites, `device-connector` 3), so
  the half that named the seams is not the half that spent the headroom. Each
  figure is measured in its own scope — the whole-batch number and the Part A
  number are different quantities and neither stands in for the other. A
  liveness control that stands on
  the population its own campaign drains reddens when somebody takes its
  advice, and the tempting fix (lower 50 to 40) buys one batch and re-arms the
  same trap. It now counts raw **+** masked through two additive
  `ClassAReport` fields, `lexableByExtension` and `lexableFilesByExtension`,
  mirroring the existing `unlexableByExtension`. The floors stay at 50 / 20;
  what changed is the quantity beneath them — invariant under conversion, and
  122 sites across 41 files today.

- **`UNANALYSABLE_READ_BASELINE` did not move, and that was checked rather
  than assumed.** The known evasion route is a conversion that pushes
  analysed sites into `not-a-file-read`, the bucket that is both uncapped and
  excluded from the skip total. `subjectSkips` and `needleSkips` are
  byte-identical across the diff except `not-a-file-read` +4, which is the
  `declarationOf(src, 'onAllSettled')` retarget — a bounded extract, the
  narrowing this ratchet's own docblock recommends, and the one direction that
  legitimately leaves the population.

- **All four moved constants are zero-headroom and shared with every open
  PR.** These figures are the live count of `main@fc8954092` + this branch.
  Whoever merges second re-measures on the merged tree rather than carrying
  them over.
