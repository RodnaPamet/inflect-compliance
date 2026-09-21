/**
 * Class A — a source-scanning test file that asserts against RAW TEXT.
 *
 * THE DEFECT, IN ONE DIFF
 * ───────────────────────
 * Delete the status chip from `ProcessInspector.tsx`, leave a JSX comment
 * naming its `data-testid`, and `tests/guards/p-polish-d.test.ts` stays
 * **20/20 green** — that assertion being the only detector for the chip in
 * the whole repo. The guard read the file and matched the text; nothing
 * separated the code from the prose (#2246).
 *
 * The mirror image was hit in the same week: a guard turned RED because a
 * COMMENT in the file it read mentioned the token its `not.toMatch`
 * forbade. One guard cannot fail, the other cannot pass, and both are
 * "the assertion is about prose". Both are counted here; the negated share
 * is reported separately on the failure so the split stays arguable.
 *
 * WHY A RATCHET AND NOT A MIGRATION
 * ─────────────────────────────────
 * The population is large (see the baseline below) and each conversion is a
 * one-line change at a file's read seam — but 500-odd of them in one diff is
 * not a reviewable change, and it would move the two sibling ratchets over
 * `tests/` in ways nobody could check. So this caps the population instead:
 * the count may fall, and any diff that RAISES it has added a test file that
 * reads source and asserts on it unmasked.
 *
 * WHAT IT DOES NOT CLAIM. The unit is the FILE. A file already in the
 * population can grow from one raw assertion to fifty without moving this
 * number. The claim is exactly "the population cannot grow", which is what a
 * cap is; the reason the unit is the file is that the FIX is per-file —
 * masking at the read seam converts every assertion in a file at once, so
 * this is the number that falls when somebody does the work.
 *
 * THE FIX, whenever this fires:
 *
 *     - const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
 *     + const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
 *
 * `codeOf` is from `tests/helpers/source-blocks.ts`. It blanks comments,
 * KEEPS string literals (masking those would silently empty assertions on
 * `data-testid="…"` or `code: 'CC1.1'`) and preserves offsets, so every
 * `indexOf` and slice in the file still lines up. Narrowing the read to the
 * construct — `declarationOf`, `functionBodyOf`, `braceBlockAfter`,
 * `callExpressionOf` — masks as well as narrows and leaves this population
 * altogether, so taking the advice can only lower this count.
 *
 * ONE CONSTANT, NOT THREE, and the reason is an interlock rather than
 * modesty: the way to evade this cap is to make the subject unreadable to
 * the analyser (`expect(String(src))`, `expect(src.trim())`), and those
 * sites land in the `content-transformed` bucket of the SAME analyser, whose
 * ceiling `UNANALYSABLE_READ_BASELINE` in
 * `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` is already
 * zero-headroom. Evading this ratchet reddens that one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { testFilesUnder } from '../helpers/assertion-reach';
import {
    analyseClassA,
    LEXABLE_EXTENSIONS,
    type ClassAReport,
} from '../helpers/raw-source-assertions';
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

/**
 * Test files holding at least one `expect(<whole source file>)` that no
 * comment mask touched.
 *
 * History — one line per change, and it moves DOWN except where a WIDENING
 * of the population is recorded as such (there is exactly one, the 344 entry
 * below). A widening is not a re-seat: the ceiling is being asked to cover
 * files it never covered, so the entry must name which files enter and why
 * they were not countable before.
 *   • 379 (2026-09-17): masked the read seam in the two files that imported
 *     `codeOf` and still asserted raw on CODE — `identity-log-identifier-scrub`
 *     (4 sites, `read` at :195) and `audit-immutability-guardrails` (1 site,
 *     the `prisma.ts` read). The second is mutation-proved below in the report
 *     that shipped it: deleting `'AuditLog'` from `EXCLUDED_MODELS` in
 *     `src/lib/prisma.ts` and leaving a comment naming it left that test GREEN
 *     on the raw read and turned it RED through `codeOf`.
 *   • 356 (2026-09-19): 20 files converted at the read seam, chosen by a
 *     measured PROSE-EXPOSURE ranking rather than alphabetically. For every
 *     raw site the needle was counted in the target TWICE — once on the raw
 *     text and once through `codeOf` — and a file was a candidate only where
 *     some needle matched FEWER times masked, i.e. the asserted token really
 *     does occur in the prose of the file being read. 163 of the 376 listed
 *     files carry at least one such needle. Inside these 20, measured on the
 *     pre-conversion tree: 307 raw assertion sites, 12 of them carrying a
 *     needle the analyser cannot score (a flagged or interpolated regex), 74
 *     prose-inflated, and 54 of those 74 with exactly ONE surviving code
 *     occurrence — one deletion away from green-on-prose. All 20 files carry
 *     at least one.
 *
 *     The conversion turned one assertion red, and that is the finding rather
 *     than a regression: `ai-aisvs-hardening-coverage` asserted
 *     `/default-deny/i` over the whole of
 *     `src/app-layer/ai/risk-assessment/feature-gate.ts` for AISVS C5.2.1,
 *     and the phrase occurs ONLY in that file's docblock and one inline
 *     comment. The allow-list loop could have been deleted with the paragraph
 *     describing it left behind and the guard would have stayed green. It now
 *     reads `functionBodyOf(gate, 'checkFeatureGate')` and asserts the loop
 *     itself. Note WHY the ranking above did not predict it: the assertion
 *     carries an `i` flag, so its needle is not a recoverable literal and the
 *     site sits in the un-analysed bucket — the exposure ranking UNDER-counts.
 *
 *     Three of the 20 also mask `readPrismaSchema()`, and one of those is
 *     `enterprise-identity-epic` — one of the FIVE the 381 entry below names
 *     as real but NOT fixed there, because that read lowers
 *     `AMBIGUOUS_NEEDLE_BASELINE`. It is fixed here and that constant moves
 *     in this same diff.
 *   • 338 (2026-09-20): the second Class A batch — 22 files converted at
 *     the read seam, 18 of which leave this population. The four that stay
 *     are deliberate: each keeps a SECOND, separately named RAW reader for
 *     one assertion whose subject IS a comment (`readProvenance` in
 *     `ai-system-registry`, `srcRaw` in `nis2-gap-reconcile-skip` and in
 *     `org-controls-status-emphasis`, `readRaw` for `PRESETS` in
 *     `org-widget-wire-reachable`) — the same shape the six files named in
 *     the 381 entry below already had. Seven raw sites remain across those
 *     four, and all seven are that assertion.
 *
 *     SELECTED BY THE SAME MEASURED RANKING as the 356 entry: for every raw
 *     site the needle was counted in the target twice, once raw and once
 *     through `codeOf`, and a file was a candidate only where some needle
 *     matched FEWER times masked. On the pre-conversion tree, over the 356
 *     listed files: 4062 raw assertion sites, 236 carrying a needle the
 *     analyser cannot score, 270 prose-inflated, of which 36 already match
 *     ZERO times in code and 82 exactly once. 143 of the 356 files carry at
 *     least one prose-inflated needle; 28 carry one at zero. This batch took
 *     the top of that ranking.
 *
 *     SEVEN GUARDS WERE ALREADY GREEN ON PROSE, not one. Five were found by
 *     the ranking and two only by running the converted suites:
 *       · `search-palette-migration` — `it('usecase enforces a role check
 *         before searching')` asserted `/!ctx\.role/` and `/forbidden\(/`;
 *         both phrases live in `search.ts` ONLY inside the comment recording
 *         their removal ("Was `if (!ctx.role) throw forbidden(…)`").
 *       · `rq2-5-coherence` — `/formatCompactCurrency/` survives only in the
 *         comment recording the B1-4 swap to `useMoneyFormatter`.
 *       · `policies-list-shell-adoption` — `'POLICY_STATUS_LABELS'` is in
 *         three comments and no code; the labels moved behind
 *         `buildPolicyStatusLabels()`.
 *       · `dashboard-widgets` — `/▲|▼/` is in `KpiCard`'s JSDoc; the glyphs
 *         moved to `trendDirectionIcon()` in `src/lib/kpi-trend.ts`.
 *       · `org-shell-structural` — `it('OrgSidebarNav declares the spec nav
 *         entries')` asserted seven English labels that migrated to
 *         next-intl; they survive only in the docblock LISTING the spec, so
 *         the test had become a test of its own comment.
 *     All five are retargeted at the construct that ships, with the catalogue
 *     resolved where the assertion was about user-visible copy.
 *
 *     AND THE RANKING UNDER-COUNTS FOR A SECOND REASON. The 356 entry records
 *     one (a flagged regex). `org-shell-structural` shows another: its needle
 *     is a LOOP VARIABLE (`for (const label of [...]) expect(src).toContain(
 *     label)`), so `recoverNeedle` returns `needle-not-literal` and the site
 *     is unscorable — 236 of the 4062 sites are. A ranking built on literal
 *     needles cannot see them; running the converted suite can.
 *   • 344 (2026-09-20): **+6, and the only UPWARD entry in this list.** The
 *     `.sql` extension gate opened — `'.sql'` joins `LEXABLE_EXTENSIONS` in
 *     `tests/helpers/raw-source-assertions.ts` — so every guard that reads a
 *     migration raw is counted for the first time (#2644, owner decision
 *     2026-09-20). Nothing was converted in that diff; six files that were
 *     always in this defect class became VISIBLE, which is what a widening
 *     is. They are, all six reading exactly one migration each:
 *     `ai-gov-self-assessment-coverage` (2 raw sites),
 *     `audit-s1-residual-and-mitigated` (2), `audit-s3-evidence-mgmt` (1),
 *     `cve-integration-coverage` (4), `risk-quantitative-analytics` (2),
 *     `rq3-6-loss-event-register` (7).
 *
 *     MEASURED 344, PREDICTED 353, and the 9 is the finding rather than
 *     drift. The measurement behind the decision
 *     (`docs/implementation-notes/2026-09-19-sql-exclusion-delta-measurement.md`)
 *     offered three states: `.sql` uncounted (base), counted with `codeOf`
 *     accepted as its mask (+6), counted with only a SQL-aware mask accepted
 *     (+15). The +15 row existed because at the time NO `.sql` read in the
 *     tree used `sqlCodeOf` — all 46 masked `.sql` sites spelled `codeOf`,
 *     the TypeScript lexer, which blanks nothing in a migration while
 *     READING as masked. #2679 converted all twelve of those files to a
 *     separately named `sqlCodeOf` seam on 2026-09-20, before this diff. So
 *     states 2 and 3 are now the SAME state and both measure 344: the twelve
 *     are masked under either rule because they genuinely carry the
 *     SQL-aware mask, mutation-proved 12/12 in #2679 (comment out the DDL,
 *     twelve named tests redden).
 *
 *     353 IS REACHABLE, AND THE BASELINE STAYS 344 BY DECISION RATHER THAN
 *     BY NECESSITY. An earlier draft of this entry said no defensible change
 *     reached 353. That was false, and measuring it is what turned this from
 *     an arithmetic accident into a judgement somebody made. ONE condition
 *     does it — `if (masked && ext !== '.sql')` in `analyseClassA`, i.e.
 *     refusing masked credit on a `.sql` read whichever masker produced it —
 *     and it lands on exactly 353, with `wholeFileReads` unchanged at 5938
 *     and `subjectSkips` byte-identical. The +9 is the nine of the twelve
 *     `sqlCodeOf` seams not already in this list for their TypeScript reads;
 *     the other three (`bia-coverage`, `incident-containment-forensic-
 *     coverage`, `scanner-ingestion-coverage`) are already among the 344, so
 *     twelve reclassified files move the count by nine.
 *
 *     WHAT THAT CONDITION COSTS IS THE OWNER'S OWN PRINCIPLE. "Nobody is
 *     credited for a mask they do not have" excludes a seam whose mask is
 *     absent, or wrong for the language it reads — which is exactly what
 *     `codeOf`-on-`.sql` was before #2679. These twelve have a real one that
 *     works, proved 12/12. Counting them raw would refuse credit for a mask
 *     that does its job: the inversion of the rule, not its application. So
 *     353 is reachable and not desirable, which is a different sentence from
 *     the one this entry used to carry, and the only one the measurement
 *     supports.
 *
 *     A SECOND ROUTE TO 353 GENUINELY DOES NOT EXIST, and that half of the
 *     old claim survives: unregistering `['sqlCodeOf', sqlCodeOf]` from
 *     `SOURCE_BLOCKS_MASKERS` leaves this count at 344, because it drops
 *     those 46 sites out of the whole-file population entirely — into
 *     `not-a-file-read` (5437 → 5495) and out of `path-not-constant`
 *     (917 → 905), i.e. into the bucket nothing caps, which is the evasion
 *     route these ratchets exist to close.
 *
 *     THE OWNER'S CONDITION IS THE ONE THAT HELD, not the arithmetic:
 *     "nobody is credited for a mask they do not have". Measured on this
 *     tree, the 122 previously-invisible `.sql` sites split 76 raw across 29
 *     files and 46 masked across 12, with NO file in both buckets — so the
 *     six that enter are exactly the files whose migration reads carry no
 *     mask at all, and no file enters credited.
 *
 *     WHAT DID NOT MOVE, measured rather than predicted: the six sibling
 *     zero-allowance constants. `subjectSkips` is byte-identical across the
 *     change (`not-a-file-read` 5437, `path-not-constant` 917,
 *     `binding-not-resolvable` 101, `content-transformed` 73,
 *     `file-not-found` 1), because `LEXABLE_EXTENSIONS` has no importer
 *     outside this pair of files and Classes C and D contain no extension
 *     filter of any kind.
 *   • 322 (2026-09-20): the THIRD Class A batch — 22 files converted at the
 *     read seam, all 22 leaving this population. Two halves in one diff
 *     because they move the same constant and splitting them would produce
 *     two PRs that each look right alone and collide on the union.
 *
 *     PART A — the six files the `.sql` widening above put here, converted
 *     with `sqlCodeOf` and NOT `codeOf`: `ai-gov-self-assessment-coverage`,
 *     `audit-s1-residual-and-mitigated`, `audit-s3-evidence-mgmt`,
 *     `cve-integration-coverage`, `risk-quantitative-analytics`,
 *     `rq3-6-loss-event-register` (18 raw `.sql` sites between them). Each
 *     gains a separately named reader — `readSql(rel)`, or `readSqlAbs(abs)`
 *     where the call site already joins `migDir` — the language split #2679
 *     established; `read` stays on `codeOf` for the 116 `.ts` / `.tsx` /
 *     `.prisma` sites in the same six files — 86 `.ts`, 21 `.tsx`,
 *     9 `.prisma` — and the JSON fixture in
 *     `ai-gov` keeps its raw reader. WHICH EXTENSIONS FLOW THROUGH EACH
 *     HELPER WAS RE-DERIVED PER FILE rather than assumed: all six read
 *     exactly one migration each and every non-`.sql` read in them was
 *     already masked, which is why converting these six alone returns this
 *     count to 338 — measured, not predicted from the +6 above.
 *
 *     PART B — 16 further files chosen by the measured prose-exposure
 *     ranking the 356 and 338 entries describe. FOURTEEN read only
 *     TypeScript-alikes and take `codeOf` alone; TWO also read a migration
 *     and therefore get Part A's treatment in the same diff —
 *     `p5a-snapshots-table-sidebar` (7 `.sql` sites beside 29 `.prisma` /
 *     `.ts` / `.tsx`) and `device-connector` (3 beside 16). Pointing one
 *     helper at both languages is the defect #2679 closed, so the extension
 *     inventory was re-derived for these sixteen too rather than assumed
 *     from the directory they live in. For every raw site the
 *     needle was counted in its target TWICE, once raw and once masked, and
 *     a file was a candidate only where some needle matched FEWER times
 *     masked. Over the 338 files: 3574 raw sites, 220 carrying a needle the
 *     analyser cannot score, 200 prose-inflated across 126 files, 31 of them
 *     already matching ZERO times in code across 24 files.
 *
 *     THOSE 24 WERE TRIAGED ONE BY ONE rather than taken off the top, which
 *     is what the previous two entries mean by the ranking being a search
 *     order and not a work queue. TEN are the files this list already names
 *     as deliberate — the six in the 381 entry below that assert a COMMENT
 *     is present, plus the four the 338 entry names as keeping a second raw
 *     reader; masking those would delete the thing being asserted. ELEVEN
 *     more assert a sentence on purpose (`/deliberate/`,
 *     `/optimistic-concurrency/`, `"Risk matrix configuration"`,
 *     `/NOT a simulated loss distribution/` — each a section header or a
 *     rationale in the target's own comments). The remaining THREE were real
 *     defects and are in this batch. Beyond the 24, the sixteen were chosen
 *     by how much raw exposure each removes: they carry 501 of the 3574 raw
 *     sites, the largest single block left.
 *
 *     ONE LEAD IS LEFT FOR THE NEXT BATCH, recorded rather than fixed:
 *     `mobile-canvas-fallback`'s `it("tells the user editing is a desktop
 *     affordance")` asserts `/larger screen|desktop/i`, and all three
 *     occurrences in `ProcessesClient.tsx` are comments — the signature of
 *     user-visible copy that migrated to next-intl, the same shape
 *     `org-shell-structural` had in the 338 entry.
 *
 *     FOUR GUARDS WERE ALREADY GREEN ON PROSE, and the ranking predicted
 *     three of them:
 *       · `new-risk-modal` — `it('gates submit behind non-empty title + not
 *         submitting')` matched `form.title.trim().length > 0 …
 *         !submitting`, a phrase that survives in `NewRiskModal.tsx` ONLY
 *         inside the comment recording its removal ("B2-8 — was …"). The
 *         canonical shape of this issue: green BECAUSE the subject was
 *         deleted. Retargeted at the schema rule and the form hook that own
 *         the gate now.
 *       · `responsive-modal-sheet` — `direction="right"` occurs in
 *         `sheet.tsx` only in the docblock offering it as a consumer
 *         opt-out; the shipped default is `"responsive"`, resolved per
 *         viewport. Retargeted at the resolution.
 *       · `evidence-upload-modal` — the close-on-success span reached
 *         `onAllSettled` in a COMMENT because the shipped callback is more
 *         than the span's 400 characters from `allOk`. Bound to
 *         `declarationOf(src, 'onAllSettled')`.
 *       · `modal-primitive` — `it('reaches the shared semantic token
 *         namespace')` asserted `bg-bg-default`, which is NOT in
 *         `modal.tsx`: the flat background/border pair was replaced by
 *         `surface-popup-texture` and the only occurrence left is the
 *         comment recording the swap. THE RANKING COULD NOT SEE THIS ONE —
 *         the needle is a loop variable (`for (const token of [...])
 *         expect(src).toContain(token)`), so `recoverNeedle` returns
 *         `needle-not-literal` and the site sits in the unscorable bucket,
 *         211 of 3574 here. Third distinct reason the ranking under-counts,
 *         after the flagged regex (356 entry) and the loop variable in
 *         `org-shell-structural` (338 entry) — and the remedy has been the
 *         same all three times: run the converted suites.
 *
 *     FOUR READS WERE MOVED OFF `codeOf` RATHER THAN ONTO IT, for the same
 *     reason the `.sql` half exists: `messages/en.json` in three files and
 *     `src/data/libraries/nist-csf-2.0.yaml` in `aws-posture-connector` are
 *     not languages `codeOf` lexes. Neither carries a `//` today, so the
 *     mask is a no-op today — and would stop being one the moment a URL
 *     lands in either, which is exactly how twelve `.sql` seams read as
 *     masked while masking nothing until #2679.
 *   • 381 (2026-09-17): seated when this ratchet landed. Measured by AST walk
 *     over every `.ts`/`.tsx` file git lists under `tests/` — 2402 files,
 *     12301 `toMatch`/`toContain` sites, of which 5937 resolve to the whole
 *     text of a file on disk. Those 5937 split: 4424 raw (419 of them
 *     negated) across these 381 files, 1049 masked, 464 reading a language
 *     `codeOf` cannot lex (`.md` 215, `.sql` 122, `.yml` 82, `.css` 22,
 *     `.env.example` 12, `.json` 7, `.yaml` 2). A further 70 files read
 *     lexable source and mask EVERY such read — the state this number is
 *     converging on. The remaining 6364 sites are not whole-file reads:
 *     `not-a-file-read` 5277, `path-not-constant` 912,
 *     `binding-not-resolvable` 101, `content-transformed` 73,
 *     `file-not-found` 1.
 *
 *     TWO METHODS, AND THEY DO NOT AGREE — which is the finding, not noise.
 *     #2246 measured 748 on 2026-09-03 with a whole-file grep ("does this
 *     file `readFileSync` source, and does it contain a comment-stripping
 *     regex or `codeOf` anywhere?"). Re-run on this tree that grep says 814
 *     read source, 591 of them with no mask anywhere, 95 hand-rolled, 128
 *     using `codeOf` — so `codeOf` adoption went 2 → 128 files in the
 *     fortnight, which is most of the movement. The AST walk says 381, and
 *     the two numbers are not the same measurement: the grep cannot tell
 *     whether the text it read is ever an assertion SUBJECT (it counts files
 *     that read `.md` fixtures, and files whose every assertion is already
 *     narrowed by `declarationOf`), and it credits a file for importing
 *     `codeOf` ANYWHERE while raw assertions survive elsewhere in it.
 *     Measured on the intersection: 13 of these 381 files import `codeOf`
 *     and the grep therefore calls them fixed. That gap is the part of the
 *     class the issue says a name-scoped enumeration cannot see.
 *
 *     AND NOT ALL 13 ARE DEFECTS, which is the other half of the finding.
 *     Triaged one by one: SIX are deliberate and say so in a comment beside
 *     the read — `audit-s2-control-testing`, `chart-platform-foundation`,
 *     `incident-containment-forensic-coverage`, `org-widget-integrity`,
 *     `sovereignty-self-assessment-coverage`, `trust-center-coverage` — each
 *     asserting that a COMMENT is present (a CC BY 4.0 attribution, an
 *     "OVERDUE semantics" rationale, a docblock header). Masking those would
 *     delete the thing being asserted and turn a correct test red. TWO were
 *     real and are fixed (see the 379 entry). FIVE more are real — the five
 *     that mask their TS reads and leave `readPrismaSchema()` raw — and are
 *     NOT fixed here: `codeOf(readPrismaSchema())` on those five lowers
 *     `AMBIGUOUS_NEEDLE_BASELINE` from 1428 to 1426 (two needles were
 *     ambiguous only through schema comments), and that constant is shared
 *     with every open PR.
 *
 *     So a file's presence in this list is NOT an accusation, and this ratchet
 *     is a cap rather than a work queue: it says the population may not grow.
 */
const RAW_ASSERTING_FILE_BASELINE = 190;

/**
 * The files themselves, sorted, in a sibling JSON — the same population the
 * constant above counts, spelled out.
 *
 * DELIBERATELY UNNUMBERED. This line read "the 356 files" while the constant
 * above said 344, and then 322: a count repeated beside its own source rots
 * the moment the source moves, and nothing makes prose follow. The set
 * equality below is the check; the number lives in one place.
 *
 * WHY A LIST AND NOT ONLY A NUMBER. A count-only ceiling can say "one more
 * than yesterday" and nothing else, and on a population this size that is not
 * actionable: 78 of these files carry exactly one raw assertion, so "the
 * offender is the one with the fewest" names 78 candidates and buries the
 * real one alphabetically. Measured — the mutation probe that seated this
 * ratchet did not appear anywhere in a 20-row sample. With the list, the
 * failure names the file.
 *
 * It is also the LESS serialising of the two shapes, which matters with three
 * zero-headroom ratchets over `tests/` in flight at once: two PRs converting
 * different files delete different lines and git merges them, where both
 * would have to rewrite the same integer.
 *
 * The comparison below is a SET EQUALITY, so the list cannot rot into a
 * stale citation: a file that leaves the population is as red as one that
 * joins it, and the fix for the first is to delete its line.
 */
const BASELINE_FILES: readonly string[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'raw-source-asserting-files.json'), 'utf8'),
) as string[];

/**
 * ZERO HEADROOM, and there is deliberately no `assertRatchetSlack` sentinel
 * here.
 *
 * The sibling ratchets are count-only, so they need a sentinel to notice a
 * baseline drifting ABOVE the live count — unspent slack is headroom the
 * next regression spends with a green build. A set equality has no slack to
 * spend: a file that leaves the population fails
 * `every listed file still asserts on raw source` by name, which is the same
 * check with a better message. Adding the sentinel on top would be a second
 * assertion that cannot fail while the first one holds, inside a ratchet
 * written to find assertions that cannot fail.
 *
 * What replaces its positive control is `the comparison itself can fail`
 * below, which perturbs the live set in both directions and requires each
 * half to fire.
 */
const compare = (live: readonly string[], baseline: readonly string[]) => {
    const inBaseline = new Set(baseline);
    const inLive = new Set(live);
    return {
        added: live.filter((f) => !inBaseline.has(f)),
        fixed: baseline.filter((f) => !inLive.has(f)),
    };
};

let cached: ClassAReport | null = null;
function report(): ClassAReport {
    if (cached === null) cached = analyseClassA(testFilesUnder(['tests']));
    return cached;
}

/**
 * One row per newly-offending file: how many raw assertions it carries, and
 * where the first of them is. The line number is what makes the report
 * actionable — "this file is raw" sends the reader hunting; "line 89 reads
 * `src/app-layer/integrations/allowed-host.ts`" does not.
 */
function describeFiles(r: ClassAReport, files: readonly string[]): string {
    const counts = new Map<string, number>();
    const first = new Map<string, string>();
    for (const s of r.rawSites) {
        counts.set(s.site.file, (counts.get(s.site.file) ?? 0) + 1);
        if (!first.has(s.site.file)) {
            first.set(s.site.file, `:${s.site.line}  reads ${s.readLabel}`);
        }
    }
    return files
        .map(
            (f) =>
                `  ${f}  (${counts.get(f) ?? 0} raw assertion(s))` +
                `\n      first at ${first.get(f) ?? '(none)'}`,
        )
        .join('\n');
}

const FIX_ADVICE = [
    `Fix — at the READ, not at the assertion:`,
    ``,
    `  import { codeOf } from '../helpers/source-blocks';`,
    `  const read = (rel: string) =>`,
    `      codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));`,
    ``,
    `  Comments blanked, string literals kept, offsets preserved — so every`,
    `  indexOf/slice in the file still lines up, and an assertion added`,
    `  later is covered without anyone remembering.`,
    ``,
    `  Better still where the test is about ONE construct: narrow the read`,
    `  with declarationOf / functionBodyOf / interfaceBodyOf /`,
    `  braceBlockAfter / callExpressionOf. Those mask AND bound, and the`,
    `  site then leaves this population entirely.`,
    ``,
    `  IS THE ASSERTION ACTUALLY ABOUT A COMMENT? Some are, legitimately —`,
    `  a CC BY 4.0 attribution in a file header, a rationale docblock, a`,
    `  licence line. Masking would delete the thing under test. Six files in`,
    `  the baseline are exactly that. Keep a SECOND, separately named reader`,
    `  (\`readRaw\`) for those assertions, say in a comment why, and route`,
    `  everything else through the masked one — do not make the whole file raw`,
    `  for one assertion.`,
    ``,
    `  READING A MIGRATION? .sql is IN this population (#2644) and codeOf`,
    `  is the wrong masker for it — codeOf lexes TypeScript, so on a .sql`,
    `  file it leaves every -- comment in place while READING as masked.`,
    `  Use sqlCodeOf, and give it its OWN named reader beside the codeOf`,
    `  one rather than repointing the shared helper — most of these files`,
    `  read .ts and .prisma through the same seam:`,
    ``,
    `      import { codeOf, sqlCodeOf } from '../helpers/source-blocks';`,
    `      const read    = (rel: string) => codeOf(fs.readFileSync(…));`,
    `      const readSql = (rel: string) => sqlCodeOf(fs.readFileSync(…));`,
    ``,
    `  .yml / .json / .md / .css are still excluded — no masker lexes them`,
    `  yet. Write a reader per language, as`,
    `  tests/guards/rq2-6-appetite-lec.test.ts does, and add the extension`,
    `  to LEXABLE_EXTENSIONS only AFTER every seam reading it uses the new`,
    `  masker. Adding it first credits every one of them as masked.`,
    ``,
    `  If the diff genuinely converted files, lower the baseline in this`,
    `  file in the same PR with a one-line History entry. It moves down on`,
    `  conversions; it has moved UP exactly once, when the .sql gate opened`,
    `  and six always-defective files became visible for the first time.`,
].join('\n');

describe('Class A — assertions satisfied by prose', () => {
    it('the baseline list and the baseline constant agree', () => {
        // Two spellings of one number, so neither can be edited alone. A
        // constant that disagreed with the list would make every message
        // below arithmetic nobody can check.
        expect(BASELINE_FILES).toHaveLength(RAW_ASSERTING_FILE_BASELINE);
        expect([...BASELINE_FILES].sort()).toEqual([...BASELINE_FILES]);
        expect(new Set(BASELINE_FILES).size).toBe(BASELINE_FILES.length);
    });

    it(`no test file outside the ${RAW_ASSERTING_FILE_BASELINE} listed ones asserts on raw source`, () => {
        const r = report();
        const { added } = compare(r.rawFiles, BASELINE_FILES);
        if (added.length > 0) {
            throw new Error(
                [
                    `${added.length} test file(s) newly read source and assert on it UNMASKED.`,
                    ``,
                    `  current  : ${r.rawFiles.length}`,
                    `  ceiling  : ${RAW_ASSERTING_FILE_BASELINE}`,
                    `  measured over ${r.filesExamined} test files, ${r.wholeFileReads} whole-file reads`,
                    `  raw sites: ${r.rawSites.length} (${r.negatedRawSites} negated), masked: ${r.maskedSites}`,
                    ``,
                    `Why this matters:`,
                    `  Nothing separates the code from the comments in what the`,
                    `  assertion matched, so "delete the code, keep the note`,
                    `  explaining it" is a green diff — measured at 20/20 green on`,
                    `  tests/guards/p-polish-d.test.ts, whose assertion was the only`,
                    `  detector for the chip that diff deleted. On a .not.toMatch it`,
                    `  is the mirror image: a comment mentioning the forbidden token`,
                    `  fails a guard whose code is fine.`,
                    ``,
                    `The offender(s):`,
                    describeFiles(r, added),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it('every listed file still asserts on raw source (no stale entries)', () => {
        const r = report();
        const { fixed } = compare(r.rawFiles, BASELINE_FILES);
        if (fixed.length > 0) {
            throw new Error(
                [
                    `${fixed.length} listed file(s) no longer assert on raw source — good.`,
                    `Record it, or the ceiling becomes headroom the next regression spends.`,
                    ``,
                    `  live count : ${r.rawFiles.length}`,
                    `  ceiling    : ${RAW_ASSERTING_FILE_BASELINE}`,
                    ``,
                    `Fix, in the same diff that made the improvement:`,
                    `  1. Delete these lines from`,
                    `     tests/guardrails/raw-source-asserting-files.json:`,
                    ...fixed.map((f) => `       ${f}`),
                    `  2. Set RAW_ASSERTING_FILE_BASELINE to ${r.rawFiles.length} in this file,`,
                    `     with a one-line History entry saying what was converted.`,
                    ``,
                    `A file can also leave this list by deletion, or because its`,
                    `assertions moved off whole-file reads onto narrowed ones — both`,
                    `are improvements and both are recorded the same way.`,
                ].join('\n'),
            );
        }
    });

    it('reports its own denominator: every site lands in exactly one bucket', () => {
        const r = report();
        const skipTotal = Object.values(r.subjectSkips).reduce((a, b) => a + b, 0);

        // No third bucket anywhere. If these disagree, sites are being dropped
        // between collection and classification — which is how a detector
        // comes to report coverage of a subset it never names.
        expect(r.wholeFileReads + skipTotal).toBe(r.sites);
        expect(
            r.rawSites.length + r.maskedSites + r.unlexableLanguageSites,
        ).toBe(r.wholeFileReads);
        expect(
            Object.values(r.unlexableByExtension).reduce((a, b) => a + b, 0),
        ).toBe(r.unlexableLanguageSites);

        // THE LEXABLE HALF OF THE SAME PARTITION, and it was outside this sum
        // for exactly one diff. `lexableByExtension` /
        // `lexableFilesByExtension` were added so the `.sql` liveness control
        // below could stand on a conversion-invariant quantity, and nothing
        // here counted them. Measured on that tree: wrapping the two
        // bookkeeping lines in `analyseClassA` in `if (ext !== '.prisma')`
        // dropped 155 sites out of the histogram entirely and left this file
        // 16/16 GREEN — the one test whose stated purpose is catching an
        // unaccounted site could not see 155 of them. A per-extension
        // histogram nobody sums is a denominator nobody checks, which is the
        // same defect one level up from the one this ratchet polices.
        expect(
            Object.values(r.lexableByExtension).reduce((a, b) => a + b, 0),
        ).toBe(r.rawSites.length + r.maskedSites);

        // …and the two histograms range over the SAME extensions. The site
        // counter and the file counter are separate statements, so one can be
        // skipped while the other is not, and the sum above sees only the
        // first of them.
        expect(Object.keys(r.lexableFilesByExtension).sort()).toEqual(
            Object.keys(r.lexableByExtension).sort(),
        );

        // Per extension, a file count is bounded by its own site count: a
        // counted extension holds at least one file, and cannot hold more
        // distinct files than the sites they were counted from.
        for (const [ext, siteCount] of Object.entries(r.lexableByExtension)) {
            expect(r.lexableFilesByExtension[ext]).toBeGreaterThan(0);
            expect(r.lexableFilesByExtension[ext]).toBeLessThanOrEqual(siteCount);
        }

        // The partition is taken over ONE set, so no extension may sit on
        // both sides of it. The sums above already catch a dropped `continue`
        // (it double-counts against `wholeFileReads`); what this adds is the
        // domain — a second extension set, or a bucket keyed off something
        // other than `LEXABLE_EXTENSIONS`, balances every sum above and still
        // files a language under the wrong exclusion story.
        for (const ext of Object.keys(r.lexableByExtension)) {
            expect(LEXABLE_EXTENSIONS.has(ext)).toBe(true);
            expect(r.unlexableByExtension[ext]).toBeUndefined();
        }
        for (const ext of Object.keys(r.unlexableByExtension)) {
            expect(LEXABLE_EXTENSIONS.has(ext)).toBe(false);
        }

        // Positive control on the scan itself: an empty selection is also
        // what a broken walk returns, so assert the denominator is real.
        expect(r.filesExamined).toBeGreaterThan(2000);
        expect(r.sites).toBeGreaterThan(10000);
        expect(r.wholeFileReads).toBeGreaterThan(1000);
        // …and that BOTH classifications are populated. A masker the analyser
        // silently stopped following would show up here as zero masked sites
        // while every count above still looked healthy.
        expect(r.maskedSites).toBeGreaterThan(100);
        expect(r.maskedOnlyFiles.length).toBeGreaterThan(20);
    });

    it('the .sql gate is open over the LIVE tree, not only over a fixture', () => {
        // The detector proofs below run over synthetic files, where `.sql`
        // behaves however `LEXABLE_EXTENSIONS` says. This one asserts the
        // same thing about the population the ceiling is actually taken
        // over — the difference between "the analyser can count migrations"
        // and "migrations are counted here".
        //
        // Both halves are needed and neither implies the other: the first
        // says no `.sql` read is still being excluded, the second that the
        // reads exist to be excluded in the first place. An empty selection
        // satisfies the first on its own.
        const r = report();
        expect(r.unlexableByExtension['.sql']).toBeUndefined();

        // COUNT WHAT THE GATE ADMITS, NOT WHAT THE CAMPAIGN DRAINS.
        //
        // This clause read `rawSites.filter(… '.sql').length > 50`, and it
        // was the one assertion in this file that a CORRECT Class A
        // conversion could redden: masking a migration's read seam moves its
        // sites from raw to masked without removing a single read. The #2246
        // third batch took raw `.sql` 76 → 48 ACROSS BOTH ITS HALVES and
        // tripped the floor, while the number of `.sql` reads the analyser
        // admits did not move at all — 122 before and after. Raw + masked is
        // invariant under the fix this ratchet exists to encourage, which is
        // the property a liveness control needs.
        //
        // WHICH HALF SPENT THE HEADROOM IS NOT WHICH HALF NAMED THE SEAMS,
        // and the two figures are separately measured rather than one
        // rounded to the other. The six uncredited `.sql` seams (Part A)
        // carry 18 raw `.sql` sites, so converting them ALONE lands on 58 —
        // above this floor, which would still have passed. 48 is reached only
        // once Part B's two migration-reading files convert as well
        // (`p5a-snapshots-table-sidebar` 7 raw `.sql` sites,
        // `device-connector` 3). A floor over a draining population does not
        // record which conversion crossed it; it just goes red for whoever is
        // holding it, which is the argument for not standing on that
        // population at all.
        //
        // Both halves still say what they said: the first that `.sql` reads
        // EXIST in quantity, the second that they are spread across real
        // files rather than concentrated in one fixture.
        expect(r.lexableByExtension['.sql']).toBeGreaterThan(50);
        expect(r.lexableFilesByExtension['.sql']).toBeGreaterThan(20);

        // …and the languages that are STILL excluded are, so this is a gate
        // that opened for one language rather than a filter that stopped
        // filtering. `.md` is the largest of them.
        expect(r.unlexableByExtension['.md']).toBeGreaterThan(100);
    });

    it('the comparison itself can fail, in both directions', () => {
        // The two tests above pass on a green tree, and a comparison that
        // passes on a green tree is indistinguishable from one that cannot
        // fail. Perturb the live set by one in each direction against the
        // REAL baseline and require each half to fire.
        const r = report();
        expect(r.rawFiles.length).toBeGreaterThan(0);

        const withNewcomer = compare(
            [...r.rawFiles, 'tests/guards/not-in-the-baseline.test.ts'],
            BASELINE_FILES,
        );
        expect(withNewcomer.added).toEqual(['tests/guards/not-in-the-baseline.test.ts']);
        expect(withNewcomer.fixed).toEqual([]);

        const withOneFixed = compare(r.rawFiles.slice(1), BASELINE_FILES);
        expect(withOneFixed.fixed).toEqual([r.rawFiles[0]]);
        expect(withOneFixed.added).toEqual([]);
    });

    // ───────────────────────── detector proof ──────────────────────────
    //
    // Synthetic files written OUTSIDE the repo tree on purpose: a fixture
    // under `tests/` is visible to `repoFiles()` and would move the very
    // count this file seats.
    describe('detector proof', () => {
        let dir: string;
        let target: string;

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-a-proof-'));
            target = path.join(dir, 'Widget.tsx');
            fs.writeFileSync(
                target,
                [
                    '// The chip carries data-testid="status-chip".',
                    'export function Widget() {',
                    '    return <div />;',
                    '}',
                ].join('\n'),
                'utf8',
            );
        });
        afterAll(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        const write = (name: string, lines: readonly string[]): string => {
            const abs = path.join(dir, name);
            fs.writeFileSync(abs, lines.join('\n'), 'utf8');
            return abs;
        };

        it('flags a whole-file read asserted without a mask', () => {
            const abs = write('raw.test.ts', [
                "const src = fs.readFileSync('" + target + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).toMatch(/data-testid="status-chip"/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.rawSites).toHaveLength(1);
            expect(r.rawFiles).toHaveLength(1);
            expect(r.maskedSites).toBe(0);
        });

        it('the flagged assertion is satisfied by the COMMENT alone', () => {
            // The claim this whole ratchet rests on, executed rather than
            // asserted in prose: the token exists nowhere but the comment.
            //
            // Written as `.test()` + `toBe` rather than `expect(src).toMatch`
            // ON PURPOSE. A `toMatch` here would be an assertion against a
            // whole-file read down a path this file's SIBLING analyser cannot
            // fold (a tmpdir name fixed in `beforeAll`), which lands in Class
            // D's `path-not-constant` bucket and pushes
            // `UNANALYSABLE_READ_BASELINE` up by one — measured: 1448 → 1449.
            // A ratchet whose own proof spends another ratchet's zero
            // headroom is not free, and the cost is invisible until CI says so.
            const src = fs.readFileSync(target, 'utf8');
            const chip = /data-testid="status-chip"/;
            expect(chip.test(src)).toBe(true);
            expect(chip.test(src.replace(/\/\/.*$/gm, ''))).toBe(false);
        });

        it('does NOT flag the same assertion masked at the read seam', () => {
            const abs = write('seam.test.ts', [
                "import { codeOf } from '" + repoHelper() + "';",
                "const read = (p: string) => codeOf(fs.readFileSync(p, 'utf8'));",
                "it('a', () => {",
                "    const src = read('" + target + "');",
                '    expect(src).toMatch(/data-testid="status-chip"/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.rawSites).toHaveLength(0);
            expect(r.maskedSites).toBe(1);
            expect(r.maskedOnlyFiles).toHaveLength(1);
        });

        it('does NOT flag it masked at the assertion either', () => {
            const abs = write('call.test.ts', [
                "import { codeOf } from '" + repoHelper() + "';",
                "const src = fs.readFileSync('" + target + "', 'utf8');",
                "it('a', () => {",
                '    expect(codeOf(src)).toMatch(/data-testid="status-chip"/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.rawSites).toHaveLength(0);
            expect(r.maskedSites).toBe(1);
        });

        it('does NOT flag a NARROWED read — the preferred fix leaves the population', () => {
            const abs = write('narrow.test.ts', [
                "import { functionBodyOf } from '" + repoHelper() + "';",
                "const src = fs.readFileSync('" + target + "', 'utf8');",
                "it('a', () => {",
                "    expect(functionBodyOf(src, 'Widget')).toMatch(/return/);",
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.wholeFileReads).toBe(0);
            expect(r.rawSites).toHaveLength(0);
            expect(r.subjectSkips['not-a-file-read']).toBe(1);
        });

        it('excludes a language no masker can lex, and says which', () => {
            // `.yml` and not `.sql`: the SQL gate opened in #2644, so a
            // migration is now IN the population (proved by the two tests
            // below). This assertion needs a language that is still out, or
            // it silently stops testing exclusion at all.
            const yml = path.join(dir, 'workflow.yml');
            fs.writeFileSync(yml, '# runs-on: ubuntu-latest\njobs: {}\n', 'utf8');
            const abs = write('yml.test.ts', [
                "const src = fs.readFileSync('" + yml + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).toMatch(/runs-on: ubuntu-latest/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.rawSites).toHaveLength(0);
            expect(r.unlexableLanguageSites).toBe(1);
            expect(r.unlexableByExtension['.yml']).toBe(1);
        });

        it('COUNTS an unmasked migration read — the .sql gate is open', () => {
            // The #2644 change in miniature. On the pre-gate tree this same
            // fixture landed in `unlexableLanguageSites` with `rawSites`
            // empty, so a guard reading a migration raw was uncounted and
            // uncapped. The `--` comment is the point: delete the DDL, leave
            // the note, and the assertion stays green — now a countable
            // defect rather than an invisible one.
            const sql = path.join(dir, 'counted.sql');
            fs.writeFileSync(
                sql,
                '-- ADD COLUMN "x" TEXT\nALTER TABLE "T" ADD COLUMN "x" TEXT;\n',
                'utf8',
            );
            const abs = write('sql-raw.test.ts', [
                "const src = fs.readFileSync('" + sql + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).toMatch(/ADD COLUMN "x"/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.unlexableLanguageSites).toBe(0);
            expect(r.rawSites).toHaveLength(1);
            expect(r.rawFiles).toHaveLength(1);
            expect(/counted\.sql$/.test(r.rawSites[0].readLabel)).toBe(true);

            // …and the exposure on this fixture is executed, not asserted in
            // prose: the needle survives once every line of DDL is gone.
            const raw = fs.readFileSync(sql, 'utf8');
            const ddlDeleted = raw
                .split('\n')
                .filter((l) => l.trimStart().startsWith('--'))
                .join('\n');
            expect(/ADD COLUMN "x"/.test(ddlDeleted)).toBe(true);
        });

        it('a migration masked with sqlCodeOf is masked — and with codeOf it still reads as masked', () => {
            // The asymmetry that decided the seat (#2644). `codeOf` lexes
            // `//`, so on a migration it blanks nothing; crediting it would
            // put a file in `maskedSites` — the FIXED state — while a `--`
            // comment could still satisfy its assertion. Both halves are
            // asserted, because only the pair distinguishes "a masker ran"
            // from "the right masker ran".
            const sql = path.join(dir, 'masked.sql');
            fs.writeFileSync(
                sql,
                '-- ADD COLUMN "y" TEXT\nALTER TABLE "T" ADD COLUMN "y" TEXT;\n',
                'utf8',
            );

            const sqlMasked = analyseClassA([
                write('sql-sqlcodeof.test.ts', [
                    "import { sqlCodeOf } from '" + repoHelper() + "';",
                    "const readSql = (p: string) => sqlCodeOf(fs.readFileSync(p, 'utf8'));",
                    "it('a', () => {",
                    "    const src = readSql('" + sql + "');",
                    '    expect(src).toMatch(/ADD COLUMN "y"/);',
                    '});',
                ]),
            ]);
            expect(sqlMasked.wholeFileReads).toBe(1);
            expect(sqlMasked.rawSites).toHaveLength(0);
            expect(sqlMasked.maskedSites).toBe(1);

            const tsMasked = analyseClassA([
                write('sql-codeof.test.ts', [
                    "import { codeOf } from '" + repoHelper() + "';",
                    "const read = (p: string) => codeOf(fs.readFileSync(p, 'utf8'));",
                    "it('a', () => {",
                    "    const src = read('" + sql + "');",
                    '    expect(src).toMatch(/ADD COLUMN "y"/);',
                    '});',
                ]),
            ]);
            // KNOWN AND DELIBERATE, asserted so it is not discovered: the
            // analyser records "a masker ran", not "a masker that lexes this
            // language ran", so `codeOf` on a migration still counts as
            // masked. That is exactly why the twelve such seams were
            // converted in #2679 BEFORE `.sql` joined `LEXABLE_EXTENSIONS`,
            // and why FIX_ADVICE says convert first, widen after. The day
            // somebody teaches the analyser about languages, this line tells
            // them what they changed.
            expect(tsMasked.maskedSites).toBe(1);
            expect(tsMasked.rawSites).toHaveLength(0);

            // The gap that tolerance leaves, executed: `codeOf` keeps the
            // `--` comment and `sqlCodeOf` blanks it, so the guard above
            // reads as masked while its needle survives in prose.
            //
            // `.includes()` + `toBe`, NOT `toContain` — for the same reason
            // the `satisfied by the COMMENT alone` proof above spells itself
            // that way: a `toContain` whose subject is a `readFileSync` down
            // a tmpdir path fixed in `beforeAll` resolves to
            // `path-not-constant` and spends `UNANALYSABLE_READ_BASELINE`,
            // which has zero headroom and is shared with every open PR.
            const raw = fs.readFileSync(sql, 'utf8');
            expect(codeOf(raw).includes('-- ADD COLUMN "y" TEXT')).toBe(true);
            expect(sqlCodeOf(raw).includes('-- ADD COLUMN "y" TEXT')).toBe(false);
            expect(
                sqlCodeOf(raw).includes('ALTER TABLE "T" ADD COLUMN "y" TEXT;'),
            ).toBe(true);
        });

        it('counts a negated raw assertion, and reports it as negated', () => {
            const abs = write('negated.test.ts', [
                "const src = fs.readFileSync('" + target + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).not.toMatch(/data-testid="status-chip"/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.rawSites).toHaveLength(1);
            expect(r.negatedRawSites).toBe(1);
        });

        it('a subject it cannot resolve is skipped, never called clean', () => {
            const abs = write('opaque.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                'for (const f of FILES) {',
                "    it('a', () => {",
                '        expect(read(f)).toMatch(/anything/);',
                '    });',
                '}',
            ]);
            const r = analyseClassA([abs]);
            expect(r.rawSites).toHaveLength(0);
            expect(r.wholeFileReads).toBe(0);
            expect(r.subjectSkips['path-not-constant']).toBe(1);
        });
    });
});

/** Absolute specifier for `tests/helpers/source-blocks`, for the fixtures. */
function repoHelper(): string {
    return path.join(__dirname, '..', 'helpers', 'source-blocks').replace(/\\/g, '/');
}
