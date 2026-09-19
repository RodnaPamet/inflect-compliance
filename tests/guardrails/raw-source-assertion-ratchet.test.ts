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
import { analyseClassA, type ClassAReport } from '../helpers/raw-source-assertions';

/**
 * Test files holding at least one `expect(<whole source file>)` that no
 * comment mask touched.
 *
 * History — only edit DOWNWARD, one line per change.
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
const RAW_ASSERTING_FILE_BASELINE = 356;

/**
 * The 356 files themselves, sorted, in a sibling JSON.
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
    `  Reading .sql / .yml / .json? Those are excluded here because codeOf`,
    `  lexes TypeScript — handing it a .sql file leaves every -- comment in`,
    `  place while READING as masked. Write a reader per language, as`,
    `  tests/guards/rq2-6-appetite-lec.test.ts does.`,
    ``,
    `  If the diff genuinely converted files, lower the baseline in this`,
    `  file in the same PR with a one-line History entry. It only ever`,
    `  moves down.`,
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

        it('excludes a language codeOf cannot lex, and says which', () => {
            const sql = path.join(dir, 'migration.sql');
            fs.writeFileSync(sql, '-- ADD COLUMN "x" TEXT\nSELECT 1;\n', 'utf8');
            const abs = write('sql.test.ts', [
                "const src = fs.readFileSync('" + sql + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).toMatch(/ADD COLUMN "x"/);',
                '});',
            ]);
            const r = analyseClassA([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.rawSites).toHaveLength(0);
            expect(r.unlexableLanguageSites).toBe(1);
            expect(r.unlexableByExtension['.sql']).toBe(1);
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
