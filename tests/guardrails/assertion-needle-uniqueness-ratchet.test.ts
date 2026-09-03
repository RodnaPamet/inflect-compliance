/**
 * Class D — a needle that occurs more than once in what is read.
 *
 * THE DEFECT
 * ──────────
 * An assertion reads a WHOLE FILE and matches a string that appears in
 * several places in it. The named thing can then be deleted and a survivor
 * satisfies the guard. Three instances were proved by hand for #2246, all
 * three of which this detector reproduces with the same multiplicities:
 *
 *   · `audit-s5-readiness-scoring.test.ts:21` — `/frameworkKey\s+String/`
 *     against `prisma/schema/audit-workflow.prisma`, where Audit, AuditCycle
 *     and ReadinessSnapshot each declare that field. Detector: 3 occurrences.
 *     Line 22's `/auditCycleId\s+String\?/`: 2.
 *   · `entra-ei2-group-mapping.test.ts:18` — a test named "the
 *     TenantEntraGroupMapping model is TENANT-SCOPED + uniquely keyed"
 *     asserting `@@index([tenantId])` against the whole of `auth.prisma`.
 *     Detector: 15 occurrences. Fifteen models satisfy an assertion about one.
 *   · `vendor-audit.test.ts:105` — `.toContain('model VendorEvidenceBundle')`,
 *     satisfied by `model VendorEvidenceBundleItem {` eighteen lines below.
 *     Detector: 2. Line 117's `/frozenAt\s+DateTime\?/`: 2.
 *
 * Deleting all three targets together left their suites 18/18 GREEN.
 *
 * `.toContain` IS IN SCOPE, and that is not a detail. The third instance is a
 * `.toContain` — the same defect one matcher away from where the first pass
 * was looking, which is how the class survived a round of fixes.
 *
 * THE PART WORTH INTERNALISING: THE TEST NEED NOT CHANGE
 * ─────────────────────────────────────────────────────
 * `.toContain('model VendorEvidenceBundle')` was UNAMBIGUOUS on the day it
 * was written. It became ambiguous later, when somebody added
 * `VendorEvidenceBundleItem` to the same schema file — a diff that touched no
 * test and turned an assertion into a tautology. So this ratchet will
 * sometimes fire on a PR that changes only `src/` or `prisma/`. That is the
 * detector working, not noise: it is reporting that a source change has just
 * hollowed out an existing guard, which is precisely the event nobody was
 * being told about.
 *
 * THE FIX SHAPE, for anything this reports
 * ────────────────────────────────────────
 *   1. Narrow the READ. `braceBlockAfter(schema, 'model VendorEvidenceBundle
 *      \\{')` gives you the one model; assert `frozenAt` inside it. The
 *      extractors are in `tests/helpers/source-blocks.ts`.
 *   2. Or narrow the NEEDLE so it can only match the thing it names —
 *      `model VendorEvidenceBundle {` with the brace beats the bare prefix.
 *   3. Assert the COUNT when the count is the point: a test named for one
 *      model can assert one occurrence rather than at-least-one.
 *
 * WHAT THIS RATCHET DOES NOT CLAIM
 * ────────────────────────────────
 * Multiplicity is a proxy, not a verdict. Some multi-occurrence assertions
 * are deliberate ("this migration enables RLS on each of its three tables").
 * The claim is narrower and still worth making: an assertion with more than
 * one satisfying site cannot, on its own, tell you the named one still
 * exists. Where that is fine, the ratchet's answer is that adding one must
 * come with removing one — the population only moves down.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    analyseClassD,
    testFilesUnder,
    type ClassDReport,
} from '../helpers/assertion-reach';
import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

/**
 * `expect(<whole file>).toMatch|toContain(<literal>)` sites whose needle has
 * more than one satisfying position in the file that was read.
 *
 * History — only edit DOWNWARD, one line per change.
 *   • 1575 (2026-09-02): seated when this ratchet landed. Measured by AST walk
 *     over every `.ts`/`.tsx` file git lists under `tests/` (2194 files).
 *     Distribution: 797 sites at exactly 2 occurrences, 502 at 3-4, 208 at
 *     5-9, 68 at 10 or more. By directory: guards 659, guardrails 437, unit
 *     401, integration 68, rendered 10.
 *   • 1554 (2026-09-03): re-measured after rebasing onto a main that had
 *     retired four guards and added six test files. Distribution: 786 at
 *     exactly 2, 497 at 3-4, 204 at 5-9, 67 at 10 or more. By directory:
 *     guards 640, guardrails 435, unit 401, integration 68, rendered 10.
 */
// Re-seated 2026-09-02 (#2226): same cause as the sibling span ratchet — twelve
// guard suites over never-applied Terraform and an EKS deploy pipeline were
// deleted, taking their short, repeated YAML/HCL identifiers with them.
const AMBIGUOUS_NEEDLE_BASELINE = 1515;

/** At or above this many satisfying positions, the needle names nothing. */
const HIGH_MULTIPLICITY = 5;

/**
 * The sharp end of the same population: needles with five or more satisfying
 * positions.
 *
 * Two occurrences can be a judgement call — a model and its `@@index` line.
 * Five cannot. `@@index([tenantId])` at 15, `"ADMIN"` at 22 and `/OWASP/` at
 * 54 are not assertions about a particular thing at all, and separating them
 * out gives the reduction work an order to run in.
 *
 * History — only edit DOWNWARD.
 *   • 276 (2026-09-02): seated with the ratchet.
 *   • 271 (2026-09-03): re-measured after the rebase described above.
 */
const HIGHLY_AMBIGUOUS_NEEDLE_BASELINE = 270;

/**
 * Sites this detector could NOT analyse, having established they read a file.
 *
 * THE DENOMINATOR IS PART OF THE RESULT. A detector that silently drops what
 * it cannot resolve reports full coverage of the subset it happens to
 * understand — the same defect one level up. So the skips are counted, named
 * by reason, and capped.
 *
 * Today: 1565. By reason —
 *   · `path-not-constant` 901 — the read's path does not constant-fold,
 *     usually because it comes from a loop variable or a `describe.each` row.
 *   · `needle-not-literal` 225 — the matcher argument is neither a string
 *     literal nor a regex literal.
 *   · `content-transformed` 175 — the subject IS a whole-file read, wearing
 *     a transform the analyser cannot follow: `codeOnly(readFileSync(…))`,
 *     `src.toLowerCase()`, `SECTION_SRC.trimStart()`. 22 are written inline
 *     at the assertion, 153 are reached through a `const` binding.
 *   · `needle-carries-span` 134 — the regex holds an unbounded `[\s\S]*`
 *     span. A greedy span collapses every candidate into one match, so a
 *     count would be meaningless. Those sites are Class C's population, and
 *     `assertion-span-reach-ratchet.test.ts` caps them.
 *   · `binding-not-resolvable` 97 — the subject identifier is shadowed or
 *     declared twice in one scope.
 *   · `needle-interpolated` 32 — a template literal needle, i.e. the
 *     `describe.each` shape the issue calls the worst case. Being unable to
 *     see it is the honest position, and capping it is what stops the blind
 *     spot growing.
 *   · `file-not-found` 1 — a read of a path that is not on disk.
 *
 * `not-a-file-read` is NOT counted here. It is the ordinary case — most
 * `expect(...).toContain(...)` in the suite asserts on a runtime value, which
 * this class says nothing about.
 *
 * THAT EXCLUSION WAS THE HOLE, AND `content-transformed` IS THE PATCH.
 * `not-a-file-read` is both excluded from this total and UNCAPPED, which is
 * right for a runtime value and catastrophic for a whole-file read the
 * analyser merely failed to recognise: such a site leaves the population
 * entirely and the only counter that moves is one nothing checks. Measured —
 * four assertions planted as `readPrismaSchema().trim()`,
 * `String(readPrismaSchema())`, `schema.trim()` and a template interpolating
 * the schema moved NO ceiling at all. Green.
 *
 * And the bucket built for exactly that case was dead code. `content-
 * transformed` was in the skip-reason union, was zeroed in the empty record,
 * was summed into this total, and was named in the prose as one of "the skips
 * that matter" — and `resolveSubject` never returned it. Declared, summed,
 * documented, unreachable: an assertion that cannot fail, inside the detector
 * built to find assertions that cannot fail. Live sites were already sitting
 * in the hole, among them
 * `tests/guards/hris-status-rule-single-owner.test.ts:48`, whose subject is
 * `codeOnly(fs.readFileSync(...))`.
 *
 * Worth being precise about what the hole did and did not do, because it
 * bears on how much of the design was already load-bearing: moving an
 * EXISTING ambiguous site into the hatch would drop `ambiguous` below its
 * baseline and turn the drift sentinel red at allowance 0. What the hatch
 * swallowed silently was a NEW assertion landing straight into it — which is
 * exactly what the four plants were.
 *
 * History — only edit DOWNWARD.
 *   • 1392 (2026-09-02): seated with the ratchet.
 *   • 1565 (2026-09-03): +175 for the `content-transformed` reclassification,
 *     −2 from the rebase described above. Every one of the 175 is a
 *     whole-file read that used to leave the population as
 *     `not-a-file-read`. The number rose because the blind spot was always
 *     this size; only its accounting changed.
 */
const UNANALYSABLE_READ_BASELINE = 1507;

/**
 * Floor on the share of whole-file reads whose needle is recovered.
 *
 * Not redundant with the skip ceiling: a ceiling on skips can be satisfied by
 * DELETING assertions, a floor on the ratio only by keeping the analyser able
 * to read what the suite writes.
 */
const MIN_ANALYSED_SHARE = 0.9;

/**
 * How far the baseline may sit above the live count before the sentinel
 * reports it as unseated.
 *
 * ZERO, and that is a deliberate departure from the older ratchets in this
 * repo, which carry allowances of 2 to 10. Those count occurrences of a token
 * in ~1,500 UI files, where ordinary work moves the number incidentally and a
 * small tolerance keeps the guard quiet. This number moves only when somebody
 * writes or deletes an assertion of a specific shape — never incidentally.
 * So an allowance would not be buying quiet, it would be buying exactly the
 * headroom the sentinel exists to remove: a baseline sitting N above the tree
 * lets the next N regressions land green.
 *
 * Cost of zero: a PR that removes one of these must lower the baseline by one
 * in the same diff. That is the point — it is what makes each reduction
 * visible rather than absorbed.
 */
const DRIFT_ALLOWANCE = 0;

let cached: ClassDReport | null = null;
function report(): ClassDReport {
    if (cached === null) cached = analyseClassD(testFilesUnder(['tests']));
    return cached;
}

/**
 * A sample of the population, LOWEST multiplicity first.
 *
 * Ascending, and that is the whole point of the function. When this ratchet
 * fires, the site that moved has just crossed the threshold, so it sits at
 * EXACTLY `min` — 2 for the headline ceiling, 5 for the sharp one. Sorted
 * descending, the twenty rows are the twenty worst standing offenders, none
 * of which the diff touched: appending a single COMMENT mentioning
 * `MAX_STEPS` to `src/lib/agentic/workflow-types.ts` turned this red with
 * `delta: +1` and a list headed by `/OWASP/ ×54`, while the actual culprit
 * (`agentic-engine-coverage.test.ts:56`, freshly at 2) appeared nowhere.
 *
 * Firing on a diff that touches no test is correct here and is the point of
 * the class — a source change had just hollowed out an existing guard.
 * Shipping that finding without a path to the site is not.
 */
function sample(r: ClassDReport, min: number, limit: number): string {
    return [...r.ambiguous]
        .filter((a) => a.occurrences >= min)
        .sort(
            (a, b) =>
                a.occurrences - b.occurrences ||
                a.site.file.localeCompare(b.site.file) ||
                a.site.line - b.site.line,
        )
        .slice(0, limit)
        .map(
            (a) =>
                `  ${a.site.file}:${a.site.line}  x${a.occurrences}  ` +
                `${a.site.matcher}(${a.needle.slice(0, 70)})  reads ${a.readLabel}`,
        )
        .join('\n');
}

const FIX_ADVICE = [
    `Fix, in preference order:`,
    `  1. Narrow the READ to the construct the test names. From`,
    `     tests/helpers/source-blocks.ts:`,
    `       braceBlockAfter(schema, 'model Thing \\\\{')`,
    `       declarationOf / functionBodyOf / interfaceBodyOf / callExpressionOf`,
    `     then assert inside that block.`,
    `  2. Narrow the NEEDLE so nothing else can satisfy it — include the`,
    `     trailing brace, the type, the surrounding punctuation.`,
    `  3. Assert the COUNT where the count is the claim: a test named for one`,
    `     model can require exactly one occurrence instead of at least one.`,
    ``,
    `  If the diff genuinely removed ambiguous assertions net-net, lower the`,
    `  baseline in this file in the same PR with a one-line History entry.`,
    `  The baseline only ever moves down.`,
].join('\n');

describe('Class D — needles that match more than the thing they name', () => {
    it(`ambiguous whole-file needles stay at or below ${AMBIGUOUS_NEEDLE_BASELINE}`, () => {
        const r = report();
        const count = r.ambiguous.length;
        if (count > AMBIGUOUS_NEEDLE_BASELINE) {
            throw new Error(
                [
                    `Whole-file assertions with a non-unique needle regressed.`,
                    ``,
                    `  current  : ${count}`,
                    `  ceiling  : ${AMBIGUOUS_NEEDLE_BASELINE}`,
                    `  delta    : +${count - AMBIGUOUS_NEEDLE_BASELINE}`,
                    `  measured over ${r.filesExamined} test files, ${r.wholeFileReads} whole-file reads`,
                    ``,
                    `Why this matters:`,
                    `  The named thing can be deleted and a survivor satisfies the`,
                    `  assertion. Proved three times on this repo, all three leaving`,
                    `  their suites fully green.`,
                    ``,
                    `  Note this can fire on a diff that changes no test at all: adding`,
                    `  a second declaration to a source file is what turned`,
                    `  .toContain('model VendorEvidenceBundle') into a tautology.`,
                    ``,
                    `Sites at the threshold — a newly-crossed one is at exactly 2,`,
                    `so if this fired on your diff, look here first:`,
                    sample(r, 2, 20),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it(`needles with ${HIGH_MULTIPLICITY}+ satisfying positions stay at or below ${HIGHLY_AMBIGUOUS_NEEDLE_BASELINE}`, () => {
        const r = report();
        const count = r.ambiguous.filter((a) => a.occurrences >= HIGH_MULTIPLICITY).length;
        if (count > HIGHLY_AMBIGUOUS_NEEDLE_BASELINE) {
            throw new Error(
                [
                    `Assertions whose needle matches ${HIGH_MULTIPLICITY}+ places regressed.`,
                    ``,
                    `  current  : ${count}`,
                    `  ceiling  : ${HIGHLY_AMBIGUOUS_NEEDLE_BASELINE}`,
                    ``,
                    `At this multiplicity the needle is not naming anything. Two`,
                    `occurrences can be a judgement call; five is a text search that`,
                    `happens to be written as an assertion.`,
                    ``,
                    `Sites at the threshold — a newly-crossed one is at exactly`,
                    `${HIGH_MULTIPLICITY}, so if this fired on your diff, look here first:`,
                    sample(r, HIGH_MULTIPLICITY, 20),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it(`un-analysable whole-file reads stay at or below ${UNANALYSABLE_READ_BASELINE}`, () => {
        const r = report();
        if (r.skippedTotal > UNANALYSABLE_READ_BASELINE) {
            throw new Error(
                [
                    `The share of whole-file assertions this detector cannot read grew.`,
                    ``,
                    `  current       : ${r.skippedTotal}`,
                    `  ceiling       : ${UNANALYSABLE_READ_BASELINE}`,
                    `  subject skips : ${JSON.stringify(r.subjectSkips)}`,
                    `  needle skips  : ${JSON.stringify(r.needleSkips)}`,
                    ``,
                    `A skipped assertion is a blind spot, and the un-analysable set is`,
                    `where an ambiguous needle can hide: build the path in a loop or`,
                    `the needle in a template and the ratchet above stops seeing it.`,
                    `Growth here is a finding in its own right.`,
                    ``,
                    `Fix:`,
                    `  Read the file through a constant path and match a literal`,
                    `  needle, both of which the analyser follows. Teaching`,
                    `  tests/helpers/assertion-reach.ts a new shape is the`,
                    `  alternative, and lowers this ceiling in the same diff.`,
                ].join('\n'),
            );
        }
    });

    it('reports its own denominator: every site lands in exactly one bucket', () => {
        const r = report();
        const subjectSkipTotal = Object.values(r.subjectSkips).reduce((a, b) => a + b, 0);
        const needleSkipTotal = Object.values(r.needleSkips).reduce((a, b) => a + b, 0);
        // No third bucket anywhere. If these disagree, sites are being dropped
        // between collection and classification — the exact way a detector
        // comes to report coverage of a subset it never names.
        expect(r.wholeFileReads + subjectSkipTotal).toBe(r.sites);
        expect(r.analysed + needleSkipTotal).toBe(r.wholeFileReads);
        expect(r.skippedTotal).toBe(
            subjectSkipTotal - r.subjectSkips['not-a-file-read'] + needleSkipTotal,
        );
        expect(r.filesExamined).toBeGreaterThan(1500);
        expect(r.analysed / r.wholeFileReads).toBeGreaterThanOrEqual(MIN_ANALYSED_SHARE);
    });

    it('baselines have not drifted above the live counts (drift sentinel)', () => {
        const r = report();
        const high = r.ambiguous.filter((a) => a.occurrences >= HIGH_MULTIPLICITY).length;

        // Positive controls against the real counters. A sentinel that never
        // fired is indistinguishable from one that cannot fire.
        for (const [name, count] of [
            ['AMBIGUOUS_NEEDLE_BASELINE', r.ambiguous.length],
            ['HIGHLY_AMBIGUOUS_NEEDLE_BASELINE', high],
            ['UNANALYSABLE_READ_BASELINE', r.skippedTotal],
        ] as const) {
            expect(
                ratchetSlackFailure({
                    constantName: name,
                    baseline: count + DRIFT_ALLOWANCE + 1, // one past the allowance
                    count,
                    allowance: DRIFT_ALLOWANCE,
                }),
            ).not.toBeNull();
        }

        assertRatchetSlack({
            constantName: 'AMBIGUOUS_NEEDLE_BASELINE',
            baseline: AMBIGUOUS_NEEDLE_BASELINE,
            count: r.ambiguous.length,
            allowance: DRIFT_ALLOWANCE,
            what: 'whole-file `toMatch`/`toContain` sites whose needle matches more than once',
        });
        assertRatchetSlack({
            constantName: 'HIGHLY_AMBIGUOUS_NEEDLE_BASELINE',
            baseline: HIGHLY_AMBIGUOUS_NEEDLE_BASELINE,
            count: high,
            allowance: DRIFT_ALLOWANCE,
            what: `whole-file needles with ${HIGH_MULTIPLICITY}+ satisfying positions`,
        });
        assertRatchetSlack({
            constantName: 'UNANALYSABLE_READ_BASELINE',
            baseline: UNANALYSABLE_READ_BASELINE,
            count: r.skippedTotal,
            allowance: DRIFT_ALLOWANCE,
            what: 'whole-file reads whose subject or needle could not be resolved',
        });
    });

    // ── ALL FIVE hand-proved instances, by name ──
    //
    // Not a re-derivation of the population — a check that the detector still
    // sees the sites a human found by hand. If a refactor of the analyser
    // quietly stops resolving `const schema = read(…)` inside an `it` block,
    // the counts above stay plausible and only this test says so. That makes
    // these the detector's only positive control, which is why all five are
    // here: the header prose above named five, three were asserted, and a
    // summary of this work claimed all five were. Two of them —
    // `audit-s5:22` and `vendor-audit:117` — were resting on the aggregate
    // alone, which is the thing the aggregate cannot tell you.
    describe('the instances #2246 proved by hand', () => {
        const at = (file: string, line: number) =>
            report().ambiguous.find(
                (a) => a.site.file.endsWith(file) && a.site.line === line,
            );

        it('audit-s5-readiness-scoring.test.ts:21 — frameworkKey is in three models', () => {
            expect(at('audit-s5-readiness-scoring.test.ts', 21)?.occurrences).toBe(3);
        });

        it('audit-s5-readiness-scoring.test.ts:22 — auditCycleId is in two', () => {
            expect(at('audit-s5-readiness-scoring.test.ts', 22)?.occurrences).toBe(2);
        });

        it('entra-ei2-group-mapping.test.ts:18 — @@index([tenantId]) is satisfied by fifteen models', () => {
            expect(at('entra-ei2-group-mapping.test.ts', 18)?.occurrences).toBe(15);
        });

        it('vendor-audit.test.ts:105 — a `.toContain`, the matcher the class hid behind', () => {
            const hit = at('vendor-audit.test.ts', 105);
            expect(hit?.site.matcher).toBe('toContain');
            expect(hit?.occurrences).toBe(2);
        });

        it('vendor-audit.test.ts:117 — frozenAt is in two models of the same schema', () => {
            expect(at('vendor-audit.test.ts', 117)?.occurrences).toBe(2);
        });
    });

    // ── The detector fires on planted needles, and only on the right shapes ──
    //
    // Synthetic files written OUTSIDE the repo tree on purpose: a fixture
    // under `tests/` would be visible to `repoFiles()` and would move the very
    // counts this file seats.
    describe('detector proof', () => {
        let dir: string;
        let data: string;

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-d-proof-'));
            data = path.join(dir, 'schema.prisma');
            fs.writeFileSync(
                data,
                [
                    'model Bundle {',
                    '  frozenAt DateTime?',
                    '}',
                    '',
                    'model BundleItem {',
                    '  frozenAt DateTime?',
                    '}',
                    '',
                    'model Other {',
                    '  soleField String',
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

        it('flags a `.toContain` whose needle occurs twice', () => {
            const abs = write('contain.test.ts', [
                "const src = fs.readFileSync('" + data + "', 'utf8');",
                "it('a', () => {",
                "    expect(src).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.analysed).toBe(1);
            expect(r.ambiguous).toHaveLength(1);
            expect(r.ambiguous[0].occurrences).toBe(2);
            expect(r.ambiguous[0].site.matcher).toBe('toContain');
        });

        it('flags a `.toMatch` whose regex has two satisfying positions', () => {
            const abs = write('match.test.ts', [
                "const src = fs.readFileSync('" + data + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).toMatch(/frozenAt\\s+DateTime\\?/);',
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.ambiguous).toHaveLength(1);
            expect(r.ambiguous[0].occurrences).toBe(2);
            expect(r.ambiguous[0].site.matcher).toBe('toMatch');
        });

        it('does NOT flag a needle with exactly one satisfying position', () => {
            const abs = write('unique.test.ts', [
                "const src = fs.readFileSync('" + data + "', 'utf8');",
                "it('a', () => {",
                "    expect(src).toContain('model Bundle {');",
                "    expect(src).toContain('soleField');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.analysed).toBe(2);
            expect(r.ambiguous).toHaveLength(0);
        });

        it('resolves the per-test `const schema = read(…)` idiom, not just module scope', () => {
            const abs = write('per-test-binding.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                "it('a', () => {",
                "    const schema = read('" + data + "');",
                "    expect(schema).toContain('model Bundle');",
                '});',
                "it('b', () => {",
                "    const schema = read('" + data + "');",
                "    expect(schema).toContain('frozenAt');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Both `it` blocks bind the SAME name in DIFFERENT scopes. A flat
            // file index calls that ambiguous and drops both — and the site it
            // drops in the real tree is entra-ei2-group-mapping.test.ts:18.
            expect(r.wholeFileReads).toBe(2);
            expect(r.ambiguous).toHaveLength(2);
        });

        it('counts what it cannot resolve as skipped, never as clean', () => {
            const abs = write('opaque.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                'for (const f of FILES) {',
                "    it('a', () => {",
                '        const src = read(f);',
                "        expect(src).toContain('model Bundle');",
                '    });',
                '}',
                "it('b', () => {",
                "    const src = read('" + data + "');",
                '    expect(src).toContain(`model ${name}`);',
                '    expect(src).toMatch(/model Bundle[\\s\\S]*frozenAt/);',
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.ambiguous).toHaveLength(0);
            expect(r.subjectSkips['path-not-constant']).toBe(1);
            expect(r.needleSkips['needle-interpolated']).toBe(1);
            expect(r.needleSkips['needle-carries-span']).toBe(1);
            expect(r.skippedTotal).toBe(3);
        });

        it('treats an assertion on a runtime value as out of scope, not as clean', () => {
            const abs = write('runtime.test.ts', [
                "it('a', () => {",
                "    expect(result.items).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.sites).toBe(1);
            expect(r.wholeFileReads).toBe(0);
            expect(r.subjectSkips['not-a-file-read']).toBe(1);
            // Out of scope is not the same as analysed-and-clean: it must not
            // count toward the ratcheted skip total either.
            expect(r.skippedTotal).toBe(0);
        });

        it('a whole-file read wearing a no-op transform is CAPPED, not out of scope', () => {
            const abs = write('wrapped.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                "it('a', () => {",
                "    const schema = read('" + data + "');",
                "    expect(read('" + data + "').trim()).toContain('model Bundle');",
                "    expect(String(read('" + data + "'))).toContain('model Bundle');",
                "    expect(schema.trim()).toContain('model Bundle');",
                '    expect(`${schema}`).toContain(\'model Bundle\');',
                "    expect(codeOnly(read('" + data + "'))).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Every one of these is the whole file. Before the fix all five
            // resolved to `not-a-file-read` — excluded from `skippedTotal`,
            // and therefore uncapped: five new ambiguous assertions could
            // land green. Four of the five are the reviewer's own plants.
            expect(r.sites).toBe(5);
            expect(r.subjectSkips['content-transformed']).toBe(5);
            expect(r.subjectSkips['not-a-file-read']).toBe(0);
            expect(r.skippedTotal).toBe(5);
        });

        it('a NARROWED read stays out of scope — narrowing is the fix, not a blind spot', () => {
            const abs = write('narrowed.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                "it('a', () => {",
                "    const schema = read('" + data + "');",
                "    expect(declarationOf(schema, 'Bundle')).toContain('frozenAt');",
                "    expect(schema.slice(0, 40)).toContain('frozenAt');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // If these counted, "narrow the read to the construct the test
            // names" — advice this very file prints on failure — would push
            // the skip ceiling red. A guard that goes red when you take its
            // advice is a guard people learn to route around.
            expect(r.subjectSkips['content-transformed']).toBe(0);
            expect(r.subjectSkips['not-a-file-read']).toBe(2);
            expect(r.skippedTotal).toBe(0);
        });
    });
});
