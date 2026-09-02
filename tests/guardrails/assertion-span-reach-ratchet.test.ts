/**
 * Class C — a regex span that crosses out of the block it is about.
 *
 * THE DEFECT
 * ──────────
 * An assertion writes `[\s\S]*` (greedy) or `[\s\S]*?` (lazy) BETWEEN two
 * pieces of pattern and thereby claims a relationship it does not enforce.
 * The span re-forms across a SIBLING block, so deleting the thing under test
 * leaves the assertion satisfied by a neighbour. Two instances were proved by
 * hand for #2246, in files a fix commit had just edited:
 *
 *   · `audit-s1-residual-and-mitigated.test.ts:115` — deleting `ownerUserId:`
 *     and `reason:` from the ownership transfer's own `after:` block, the
 *     exact audit fields the test is named for, left the suite 12/12 GREEN.
 *     The greedy span re-formed across the file's other seven `after: {`
 *     blocks.
 *   · `risk-quantitative-analytics.test.ts:94` — reducing `resolveALE(` to
 *     drop the legacy SLE×ARO fallback the test is entirely named for left it
 *     16/16 GREEN. The lazy span reached an object literal six lines below.
 *
 * Greedy and lazy fail differently and both fail. A lazy span is the same bug
 * wearing a bound.
 *
 * THE FIX SHAPE, for anything this ratchet reports
 * ────────────────────────────────────────────────
 * Bind the read to the construct, then assert inside it. The helpers already
 * exist and are already used — `declarationOf`, `functionBodyOf`,
 * `interfaceBodyOf`, `braceBlockAfter`, `callExpressionOf`, `codeOf` from
 * `tests/helpers/source-blocks.ts`:
 *
 *     // reaches anywhere later in the file
 *     expect(src).toMatch(/after: \{[\s\S]*?ownerUserId:/);
 *
 *     // bound to the block it names
 *     const block = braceBlockAfter(src, 'action: .TRANSFER_OWNERSHIP.');
 *     expect(block).toMatch(/ownerUserId:/);
 *
 * WHAT THIS RATCHET DOES NOT CLAIM
 * ────────────────────────────────
 * It is a SHAPE census, not a proof of exploitability. Of five sampled sites
 * two were exploitable; the other three happened to be safe because no second
 * occurrence existed yet — which is a property of today's source file, not of
 * the assertion. That is the whole point: the assertion is one unrelated
 * addition away from being satisfied by a neighbour, and nothing tells anyone
 * when that day comes.
 *
 * Nor does it police BOUNDED spans (`[\s\S]{0,200}`) as a defect. It counts
 * them, because otherwise a "fix" that rewrites `*?` as `{0,200}` would drop
 * the headline number while leaving the assertion just as unbound to the
 * block — see `INTERIOR_SPAN_BASELINE`.
 *
 * WHY THE NUMBERS DIFFER FROM THE ISSUE'S
 * ───────────────────────────────────────
 * #2246 reports 86, from `grep 'toMatch' | grep '\[\\s\\S\]\*'` over
 * `tests/guards` + `tests/guardrails`. That is a line-scoped enumeration, and
 * a line-scoped enumeration is the failure the issue is about: it can only
 * see an assertion whose regex prettier happened to leave on the same line as
 * its matcher. Reproduced exactly on this tree — the grep still says 86 — the
 * AST says 126 over the same two directories, and 182 over all of `tests/`.
 * The population here is the whole `tests/` tree because the defect has
 * nothing to do with which directory a file sits in; one of the sibling
 * class's proved instances lives in `tests/integration`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    analyseClassC,
    analyseSpans,
    testFilesUnder,
    type ClassCReport,
} from '../helpers/assertion-reach';
import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

/**
 * `expect(x).toMatch(/…/)` assertions carrying an UNBOUNDED interior span —
 * the Class C shape proper.
 *
 * History — only edit DOWNWARD, one line per change.
 *   • 182 (2026-09-02): seated when this ratchet landed, measured by AST walk
 *     over every `.ts`/`.tsx` file git lists under `tests/` (2194 files, 8464
 *     `toMatch` sites). Breakdown by quantifier: `*?` 197, `*` 66, `+?` 18
 *     spans across those 182 sites; 3 of the sites are `not.toMatch`. #2265
 *     had already closed the two hand-proved instances, so neither is in this
 *     count.
 */
const UNBOUNDED_INTERIOR_SPAN_BASELINE = 182;

/**
 * Interior spans of ANY boundedness, including `[\s\S]{0,200}`.
 *
 * This exists so the headline number cannot be bought. Rewriting `[\s\S]*?`
 * as `[\s\S]{0,200}` lowers the unbounded count while leaving the assertion
 * exactly as unbound to the block it names — the span still crosses a sibling,
 * it just crosses fewer bytes of it. Capping the total makes that rewrite
 * neutral: it can register as a partial improvement, never as headroom.
 *
 * History — only edit DOWNWARD.
 *   • 383 (2026-09-02): seated with the ratchet. 201 of the 383 are already
 *     character-bounded, which is why the cap matters — the bounded form is
 *     the established local habit and is one search-and-replace away.
 */
const INTERIOR_SPAN_BASELINE = 383;

/**
 * `toMatch` arguments whose pattern this detector could not recover.
 *
 * THE DENOMINATOR IS PART OF THE RESULT. A detector that silently drops what
 * it cannot parse has its own parseability as its denominator, and then
 * reports full coverage of the subset it happens to understand — which is the
 * same defect one level up from the one being detected. So the skips are
 * counted, named by reason, and capped: an un-analysable population that
 * GROWS is itself a finding, because it is the cheapest place to hide a span.
 *
 * Today: 59 of 8464 (0.70%). By reason — `identifier-unresolved` 38 (the
 * argument is a variable that does not resolve to a regex literal in the same
 * lexical scope), `expression-argument` 12, `computed-regexp-argument` 9
 * (`new RegExp(someVariable)`).
 *
 * History — only edit DOWNWARD.
 *   • 59 (2026-09-02): seated with the ratchet.
 */
const UNANALYSABLE_TOMATCH_BASELINE = 59;

/**
 * Floor on the share of `toMatch` sites whose pattern is recovered.
 *
 * The companion to the skip ceiling above, and it is not redundant with it:
 * a ceiling on skips can be satisfied by DELETING assertions, whereas a floor
 * on the ratio can only be satisfied by keeping the analyser able to read what
 * the suite writes. Both directions of "the denominator moved" are covered.
 */
const MIN_ANALYSED_SHARE = 0.99;

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

let cached: ClassCReport | null = null;
function report(): ClassCReport {
    if (cached === null) cached = analyseClassC(testFilesUnder(['tests']));
    return cached;
}

function sample(report: ClassCReport, unboundedOnly: boolean): string {
    const rows = unboundedOnly ? report.unboundedSpanSites : report.interiorSpanSites;
    return [...rows]
        .sort((a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line)
        .slice(0, 20)
        .map((s) => `  ${s.site.file}:${s.site.line}  /${s.pattern.pattern.slice(0, 100)}/`)
        .join('\n');
}

const FIX_ADVICE = [
    `Fix:`,
    `  Bind the read to the construct instead of spanning to it. From`,
    `  tests/helpers/source-blocks.ts:`,
    `    declarationOf(src, 'NAME')       — a whole \`const NAME = …;\``,
    `    functionBodyOf(src, 'name')      — a \`function name(…) { … }\``,
    `    interfaceBodyOf(src, 'Pattern')  — an \`interface … { … }\``,
    `    braceBlockAfter(src, 'anchor')   — the \`{ … }\` after any anchor`,
    `    callExpressionOf(src, 'callee')  — a whole \`callee(…)\` call`,
    `  then assert the identifiers INSIDE that block, with no span at all.`,
    ``,
    `  If the diff genuinely removed spans net-net, lower the baseline in`,
    `  this file in the same PR with a one-line History entry. The baseline`,
    `  only ever moves down.`,
].join('\n');

describe('Class C — regex spans that reach out of the block they name', () => {
    it(`unbounded interior spans stay at or below ${UNBOUNDED_INTERIOR_SPAN_BASELINE}`, () => {
        const r = report();
        const count = r.unboundedSpanSites.length;
        if (count > UNBOUNDED_INTERIOR_SPAN_BASELINE) {
            throw new Error(
                [
                    `Unbounded \`[\\s\\S]*\` spans inside \`toMatch\` regressed.`,
                    ``,
                    `  current  : ${count}`,
                    `  ceiling  : ${UNBOUNDED_INTERIOR_SPAN_BASELINE}`,
                    `  delta    : +${count - UNBOUNDED_INTERIOR_SPAN_BASELINE}`,
                    `  measured over ${r.filesExamined} test files, ${r.toMatchSites} toMatch sites`,
                    ``,
                    `Why this matters:`,
                    `  A span between two pieces of pattern claims a relationship it`,
                    `  does not enforce. Delete the thing under test and any later`,
                    `  sibling satisfies the same regex — measured twice on this repo,`,
                    `  both times leaving the suite fully green.`,
                    ``,
                    `Sample of the current population (first 20 by path):`,
                    sample(r, true),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it(`interior spans of any boundedness stay at or below ${INTERIOR_SPAN_BASELINE}`, () => {
        const r = report();
        const count = r.interiorSpanSites.length;
        if (count > INTERIOR_SPAN_BASELINE) {
            throw new Error(
                [
                    `Interior any-char spans inside \`toMatch\` regressed.`,
                    ``,
                    `  current  : ${count}   (of which unbounded: ${r.unboundedSpanSites.length})`,
                    `  ceiling  : ${INTERIOR_SPAN_BASELINE}`,
                    ``,
                    `This cap covers BOUNDED spans too (\`[\\s\\S]{0,200}\`), so that`,
                    `rewriting an unbounded span as a bounded one reads as the partial`,
                    `improvement it is rather than as new headroom. A bounded span still`,
                    `crosses whatever sibling block fits inside its bound.`,
                    ``,
                    `Sample (first 20 by path):`,
                    sample(r, false),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it(`un-analysable toMatch arguments stay at or below ${UNANALYSABLE_TOMATCH_BASELINE}`, () => {
        const r = report();
        if (r.skippedTotal > UNANALYSABLE_TOMATCH_BASELINE) {
            throw new Error(
                [
                    `The share of \`toMatch\` arguments this detector cannot read grew.`,
                    ``,
                    `  current  : ${r.skippedTotal}`,
                    `  ceiling  : ${UNANALYSABLE_TOMATCH_BASELINE}`,
                    `  by reason: ${JSON.stringify(r.skipped)}`,
                    ``,
                    `A skipped assertion is a blind spot, and the un-analysable set is`,
                    `the cheapest place for a span to hide: move the regex into a`,
                    `variable the analyser cannot follow and the ratchet above stops`,
                    `seeing it. Growth here is a finding in its own right.`,
                    ``,
                    `Fix:`,
                    `  Write the regex as a literal at the \`toMatch\` call site, or as a`,
                    `  \`const NAME = /…/\` in the same lexical scope — both of which the`,
                    `  analyser reads. Teaching \`recoverPattern\` a new shape in`,
                    `  tests/helpers/assertion-reach.ts is the alternative, and lowers`,
                    `  this ceiling in the same diff.`,
                ].join('\n'),
            );
        }
    });

    it('reports its own denominator: every toMatch site is either analysed or counted as skipped', () => {
        const r = report();
        // No third bucket. If these ever disagree, sites are being dropped
        // somewhere between collection and classification — the exact way a
        // detector comes to report coverage of a subset it never names.
        expect(r.analysed + r.skippedTotal).toBe(r.toMatchSites);
        expect(r.filesExamined).toBeGreaterThan(1500);
        expect(r.analysed / r.toMatchSites).toBeGreaterThanOrEqual(MIN_ANALYSED_SHARE);
    });

    it('baselines have not drifted above the live counts (drift sentinel)', () => {
        const r = report();

        // Positive controls against the real counters. A sentinel that never
        // fired is indistinguishable from one that cannot fire, so each of the
        // three is first shown to reject a baseline one past its allowance.
        for (const [name, count] of [
            ['UNBOUNDED_INTERIOR_SPAN_BASELINE', r.unboundedSpanSites.length],
            ['INTERIOR_SPAN_BASELINE', r.interiorSpanSites.length],
            ['UNANALYSABLE_TOMATCH_BASELINE', r.skippedTotal],
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
            constantName: 'UNBOUNDED_INTERIOR_SPAN_BASELINE',
            baseline: UNBOUNDED_INTERIOR_SPAN_BASELINE,
            count: r.unboundedSpanSites.length,
            allowance: DRIFT_ALLOWANCE,
            what: 'unbounded interior `[\\s\\S]*` spans inside `toMatch`, across tests/',
        });
        assertRatchetSlack({
            constantName: 'INTERIOR_SPAN_BASELINE',
            baseline: INTERIOR_SPAN_BASELINE,
            count: r.interiorSpanSites.length,
            allowance: DRIFT_ALLOWANCE,
            what: 'interior any-char spans of any boundedness inside `toMatch`',
        });
        assertRatchetSlack({
            constantName: 'UNANALYSABLE_TOMATCH_BASELINE',
            baseline: UNANALYSABLE_TOMATCH_BASELINE,
            count: r.skippedTotal,
            allowance: DRIFT_ALLOWANCE,
            what: '`toMatch` arguments whose pattern could not be recovered',
        });
    });

    // ── The detector fires on a planted span, and only on the right shapes ──
    //
    // Synthetic files, written OUTSIDE the repo tree on purpose: a fixture
    // planted under `tests/` would be visible to `repoFiles()` and would move
    // the very counts this file seats.
    describe('detector proof', () => {
        let dir: string;

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-c-proof-'));
        });
        afterAll(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        const write = (name: string, body: string): string => {
            const abs = path.join(dir, name);
            fs.writeFileSync(abs, body, 'utf8');
            return abs;
        };

        it('flags a greedy interior span, a lazy one, and `[^]`', () => {
            const abs = write(
                'greedy.test.ts',
                [
                    "it('a', () => {",
                    '    expect(src).toMatch(/after: \\{[\\s\\S]*ownerUserId:/);',
                    '    expect(src).toMatch(/after: \\{[\\s\\S]*?reason:/);',
                    '    expect(src).toMatch(/after: \\{[^]*auditId:/);',
                    '});',
                ].join('\n'),
            );
            const r = analyseClassC([abs]);
            expect(r.toMatchSites).toBe(3);
            expect(r.analysed).toBe(3);
            expect(r.unboundedSpanSites).toHaveLength(3);
        });

        it('does NOT flag a bounded span as unbounded, but still counts it as interior', () => {
            const abs = write(
                'bounded.test.ts',
                [
                    "it('a', () => {",
                    '    expect(src).toMatch(/after: \\{[\\s\\S]{0,200}ownerUserId:/);',
                    '});',
                ].join('\n'),
            );
            const r = analyseClassC([abs]);
            expect(r.unboundedSpanSites).toHaveLength(0);
            expect(r.interiorSpanSites).toHaveLength(1);
        });

        it('does NOT flag a span with nothing on one side of it', () => {
            const abs = write(
                'edge.test.ts',
                [
                    "it('a', () => {",
                    '    expect(src).toMatch(/ownerUserId:[\\s\\S]*/);',
                    '    expect(src).toMatch(/^[\\s\\S]*ownerUserId:$/);',
                    '    expect(src).toMatch(/^after: \\{[\\s\\S]*ownerUserId:$/);',
                    '});',
                ].join('\n'),
            );
            const r = analyseClassC([abs]);
            // Lines 2 and 3 each have pattern on ONE side only — the span
            // reaches past nothing, and the assertion says no more than "this
            // appears". Line 4 has pattern on both sides once `^`/`$` are
            // discounted, so it is the Class C shape and is the only hit.
            expect(r.unboundedSpanSites).toHaveLength(1);
            expect(r.unboundedSpanSites[0].site.line).toBe(4);
        });

        it('counts an argument it cannot read as skipped, never as clean', () => {
            const abs = write(
                'opaque.test.ts',
                [
                    "it('a', () => {",
                    '    expect(src).toMatch(buildPattern(name));',
                    '    expect(src).toMatch(new RegExp(dynamic));',
                    '});',
                ].join('\n'),
            );
            const r = analyseClassC([abs]);
            expect(r.analysed).toBe(0);
            expect(r.skippedTotal).toBe(2);
            expect(r.skipped['expression-argument']).toBe(1);
            expect(r.skipped['computed-regexp-argument']).toBe(1);
        });

        it('follows a regex bound to a `const` in the same scope', () => {
            const abs = write(
                'via-const.test.ts',
                [
                    "it('a', () => {",
                    '    const PATTERN = /after: \\{[\\s\\S]*?ownerUserId:/;',
                    '    expect(src).toMatch(PATTERN);',
                    '});',
                ].join('\n'),
            );
            const r = analyseClassC([abs]);
            expect(r.skippedTotal).toBe(0);
            expect(r.unboundedSpanSites).toHaveLength(1);
        });

        it('sees a span written into a `new RegExp` template', () => {
            const abs = write(
                'template.test.ts',
                [
                    "it('a', () => {",
                    '    expect(src).toMatch(new RegExp(`model ${m} \\\\{[\\\\s\\\\S]*?tenantId`));',
                    '});',
                ].join('\n'),
            );
            const r = analyseClassC([abs]);
            expect(r.unboundedSpanSites).toHaveLength(1);
            expect(r.unboundedSpanSites[0].pattern.exact).toBe(false);
        });
    });

    // ── The span classifier itself, exercised directly ──
    describe('analyseSpans', () => {
        it('separates unbounded from bounded quantifiers', () => {
            const q = (pattern: string) => analyseSpans(pattern).map((s) => s.unbounded);
            expect(q('a[\\s\\S]*b')).toEqual([true]);
            expect(q('a[\\s\\S]*?b')).toEqual([true]);
            expect(q('a[\\s\\S]+b')).toEqual([true]);
            expect(q('a[\\s\\S]+?b')).toEqual([true]);
            expect(q('a[\\s\\S]{2,}b')).toEqual([true]);
            expect(q('a[\\s\\S]{0,200}b')).toEqual([false]);
            expect(q('a[\\s\\S]?b')).toEqual([false]);
            expect(q('a[\\s\\S]b')).toEqual([false]);
        });

        it('separates interior spans from edge spans', () => {
            const i = (pattern: string) => analyseSpans(pattern).map((s) => s.interior);
            expect(i('a[\\s\\S]*b')).toEqual([true]);
            expect(i('a[\\s\\S]*')).toEqual([false]);
            expect(i('[\\s\\S]*b')).toEqual([false]);
            expect(i('^a[\\s\\S]*b$')).toEqual([true]);
            expect(i('^[\\s\\S]*b')).toEqual([false]);
        });

        it('finds every span in a pattern, not just the first', () => {
            expect(analyseSpans('a[\\s\\S]*b[\\s\\S]{0,10}c')).toHaveLength(2);
        });
    });
});
