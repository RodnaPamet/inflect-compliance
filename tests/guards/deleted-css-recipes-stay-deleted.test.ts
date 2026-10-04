/**
 * Guard — a class recipe deleted from a GLOBAL stylesheet stays deleted, and
 * nothing starts writing its class name again.
 *
 * WHY THIS EXISTS
 * ───────────────
 * #3162 deleted `.page-header` and `.safe-area-bottom` from
 * `src/app/globals.css`. A deletion with no guard can be undone silently:
 * nothing fails when somebody re-adds the rule, and nothing fails when
 * somebody writes `className="page-header"` believing the class still
 * exists — the element renders either way and only the computed style
 * differs, which is the same invisibility that let the unlayered-recipe
 * defect live for the whole life of that file (see
 * `globals-css-recipes-are-layered.test.ts`).
 *
 * WHY THE EVIDENCE BAR FOR THE DELETION WAS HIGH, AND WHAT WAS MEASURED
 * ────────────────────────────────────────────────────────────────────
 * #3153 LAYERED these two rather than deleting them, deliberately: it was
 * authorised to delete exactly one dead family (`.btn`), and that one had a
 * second witness independent of grep — `tests/unit/legacy-ui-ratchet.test.ts`
 * asserts `BASELINES.btn: 0`. These two had only a grep, and a grep is the
 * instrument that had already got this wrong once: the issue before #3153
 * listed `.page-header` under "live, 3 occurrences", when all three were
 * `data-testid="page-header-*"` attributes. (That is also why the scan below
 * requires the token to be bounded on BOTH sides — `page-header-back` is not
 * `page-header`.)
 *
 * The second witness, measured on the tree that still HAD the rules:
 *
 *   1. `src/app/globals.css` compiled through the real `@tailwindcss/postcss`
 *      chain emitted, for each, exactly ONE selector — the bare
 *      `.page-header` / `.safe-area-bottom`, no descendant or compound form.
 *      So "does an element match the selector" is the same question as "does
 *      an element carry the token", which a DOM probe can answer completely.
 *   2. The 34 jsdom suites that render a layout / app-shell / nav component
 *      or a page-shell primitive (319 tests) were run with every class-name
 *      assignment intercepted (`setAttribute('class')`, the `className`
 *      setter, `classList.add/toggle/replace`, `innerHTML`) and every
 *      rendered tree scanned at teardown. 0 of 1,005,821 class tokens
 *      assigned and 0 of 127,511 elements scanned carried either name —
 *      against 266 elements matching the recipes that ARE alive, and a
 *      synthetic control element that the same probes found in all 319
 *      tests. So the probe discriminated in every single test.
 *   3. Runtime assembly, which a literal grep cannot see, was ruled out
 *      statically too: of the 5,931 template literals in `src/`, the 48
 *      whose static text could possibly splice into either token are all
 *      `key=` / `id=` builders; none is in a class-name position. (A
 *      synthetic `` `${prefix}-header` `` in a `className` WAS flagged by
 *      that scan and the same literal in a `key=` was not.)
 *   4. Persisted rich text cannot carry either name either: `class` is
 *      absent from every tag's entry in `RICH_TEXT_ALLOWED_ATTRS`
 *      (`src/lib/security/sanitize.ts`), so sanitize-html strips the
 *      attribute on every write path.
 *
 * The live page-header primitive is `src/components/layout/PageHeader.tsx`,
 * which composes Tailwind utilities and never used the class. The live
 * safe-area handling is `NAV_BAR_SAFE_AREA` / `NAV_BAR_PADDING` in
 * `src/components/layout/nav-bar.tsx`, spelled as arbitrary utilities
 * (`pt-[env(safe-area-inset-top)]`).
 *
 * SCOPE, AND WHAT THIS GUARD DOES NOT COVER
 * ─────────────────────────────────────────
 *   - The source scan covers `src/` only. A test fixture may legitimately
 *     write the token (the discriminating pair below does), so `tests/` is
 *     out of scope on purpose.
 *   - It matches a token WRITTEN DOWN. A class name assembled at runtime
 *     (`` `${prefix}-header` ``) is invisible to it; that path was ruled out
 *     by the measurement in (3) above, not by this guard.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'postcss';

import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';

interface DeletedRecipe {
    /** The bare class token, exactly as it was written in `className`. */
    className: string;
    /** The PR that deleted it. */
    pr: string;
    reason: string;
}

const DELETED_RECIPES: readonly DeletedRecipe[] = [
    {
        className: 'page-header',
        pr: '#3162',
        reason:
            'Sticky page-header recipe with zero className consumers. The live ' +
            'primitive is src/components/layout/PageHeader.tsx, which composes ' +
            'Tailwind utilities. Use <PageHeader>, not a class.',
    },
    {
        className: 'safe-area-bottom',
        pr: '#3162',
        reason:
            'env(safe-area-inset-bottom) padding helper with zero className ' +
            'consumers. The repo spells safe-area insets as arbitrary utilities ' +
            '(pt-[env(safe-area-inset-top)] in nav-bar.tsx), so a bottom inset ' +
            'is pb-[env(safe-area-inset-bottom)], not a class.',
    },
];

/** Loose floors. Far below the live counts, so no routine PR touches them. */
const MIN_CSS_RULES = 40; // 95 at the time of writing
const MIN_SRC_FILES = 2000; // 2,818
const MIN_CLASSNAME_OCCURRENCES = 5000; // 9,008+

/** `.page-header` but not `.page-header-ish`. */
function cssSelectorMatcher(className: string): RegExp {
    return new RegExp(`\\.${className}(?![\\w-])`);
}

/**
 * The token as a hand-written class name: bounded on BOTH sides by a quote,
 * a backtick or whitespace. `data-testid="page-header-back"` fails the right
 * boundary; `pageHeader` and `PageHeader` never match at all.
 */
function sourceTokenMatcher(className: string): RegExp {
    return new RegExp(`(^|['"\`\\s])${className}(['"\`\\s]|$)`);
}

/**
 * Comments carry prose about these names, and prose is not a class. Measured:
 * without this, the source scan reports 4 hits, all prose —
 * `PageActions.tsx:6`, `PageActions.tsx:19`, `PageHeader.tsx:4` (docblocks)
 * and `PageHeader.tsx:285` (`// … the page-header action cluster`). With it,
 * 0. So the stripping is load-bearing, not decoration.
 *
 * The line-comment pass requires the `//` to be preceded by start-of-line or
 * a character that is neither `:` nor a word character, so a `https://` URL
 * inside a string does not truncate the line.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .map((line) => line.replace(/(^|[^:\w])\/\/.*$/, '$1'))
        .join('\n');
}

interface CssHit {
    file: string;
    line: number;
    selector: string;
}

/** Every rule in `css` whose selector names `className` as a class. */
export function rulesSelecting(css: string, file: string, className: string): CssHit[] {
    const re = cssSelectorMatcher(className);
    const out: CssHit[] = [];
    parse(css, { from: file }).walkRules((rule) => {
        if (!re.test(rule.selector)) return;
        out.push({
            file,
            line: rule.source?.start?.line ?? 0,
            selector: rule.selector.replace(/\s+/g, ' ').trim(),
        });
    });
    return out;
}

interface SourceHit {
    file: string;
    line: number;
    text: string;
}

/** Every line of `src` that writes `className` as a class token. */
export function linesWritingToken(src: string, file: string, className: string): SourceHit[] {
    const re = sourceTokenMatcher(className);
    const out: SourceHit[] = [];
    stripComments(src)
        .split('\n')
        .forEach((line, i) => {
            if (re.test(line)) out.push({ file, line: i + 1, text: line.trim().slice(0, 160) });
        });
    return out;
}

const GLOBAL_STYLESHEETS = repoFiles({ under: 'src', extensions: ['.css'] }).filter(
    (abs) => !abs.endsWith('.module.css'),
);
/**
 * `src/` minus its 6 co-located test files: a test may legitimately write the
 * token as a fixture — the discriminating pair at the bottom of this file
 * does exactly that — so counting them would make the guard fire on its own
 * kind of evidence.
 */
// Two separate tests rather than one alternation. Behaviour is identical --
// 2818 candidates, 2812 kept by both forms, zero disagreements, and the six
// discriminating shapes (`__tests__/x.ts`, `x.test.ts`, `x.spec.tsx`, `x.ts`,
// `x.test.ts.bak`, a leading `__tests__/`) classify the same -- but the single
// regex was flagged by CodeQL as a high-severity "missing regular expression
// anchor": in `/(^|\/)__tests__\/|\.(test|spec)\.tsx?$/` the top-level `|`
// splits the pattern in two, so the `$` binds ONLY to the second branch. That
// happens to be exactly what is wanted here -- a `__tests__/` segment may
// appear anywhere in a path, a test SUFFIX must end the string -- which is why
// it behaves correctly. But a reader cannot tell intent from accident at a
// glance, and that ambiguity is the same shape that bit #3101: an alternation
// whose anchor silently covers one branch.
const IN_TESTS_DIR = /(^|\/)__tests__\//;
const IS_TEST_FILE = /\.(test|spec)\.tsx?$/;
const SRC_SOURCES = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).filter(
    (abs) => {
        const rel = repoRelative(abs);
        return !IN_TESTS_DIR.test(rel) && !IS_TEST_FILE.test(rel);
    },
);

let cssRuleCount = 0;
for (const abs of GLOBAL_STYLESHEETS) {
    parse(fs.readFileSync(abs, 'utf-8'), { from: abs }).walkRules(() => {
        cssRuleCount++;
    });
}

let classNameOccurrences = 0;
const SRC_TEXT: Array<{ file: string; src: string }> = SRC_SOURCES.map((abs) => {
    const src = fs.readFileSync(abs, 'utf-8');
    classNameOccurrences += src.split('className').length - 1;
    return { file: repoRelative(abs), src };
});

describe('deleted global-stylesheet recipes stay deleted', () => {
    it('reads a real population (neither collector is empty)', () => {
        // Both assertions below range over these populations. A changed file
        // layout or a parse that returned nothing would otherwise make every
        // "no occurrences" assertion pass by having nothing to look at.
        expect(GLOBAL_STYLESHEETS.map(repoRelative)).toContain('src/app/globals.css');
        expect(cssRuleCount).toBeGreaterThanOrEqual(MIN_CSS_RULES);
        expect(SRC_SOURCES.length).toBeGreaterThanOrEqual(MIN_SRC_FILES);
        expect(classNameOccurrences).toBeGreaterThanOrEqual(MIN_CLASSNAME_OCCURRENCES);
    });

    it('the table is non-empty and every entry carries a reason', () => {
        expect(DELETED_RECIPES.length).toBeGreaterThan(0);
        for (const r of DELETED_RECIPES) {
            expect(r.reason.trim().length).toBeGreaterThan(60);
            expect(r.pr).toMatch(/^#\d+$/);
        }
    });

    it.each(DELETED_RECIPES.map((r) => r.className))(
        'no rule in any global stylesheet selects `.%s`',
        (className) => {
            const hits = GLOBAL_STYLESHEETS.flatMap((abs) =>
                rulesSelecting(fs.readFileSync(abs, 'utf-8'), repoRelative(abs), className),
            );
            if (hits.length > 0) {
                const entry = DELETED_RECIPES.find((r) => r.className === className)!;
                throw new Error(
                    `\`.${className}\` is back in a global stylesheet:\n` +
                        hits.map((h) => `  ${h.file}:${h.line}  ${h.selector}`).join('\n') +
                        `\n\nIt was deleted in ${entry.pr}. ${entry.reason}\n` +
                        'If it is genuinely wanted again, delete the entry from ' +
                        'DELETED_RECIPES in this file — with the call sites that need it.',
                );
            }
            expect(hits).toEqual([]);
        },
    );

    it.each(DELETED_RECIPES.map((r) => r.className))(
        'nothing in `src/` writes `%s` as a class token',
        (className) => {
            const hits = SRC_TEXT.flatMap(({ file, src }) =>
                linesWritingToken(src, file, className),
            );
            if (hits.length > 0) {
                const entry = DELETED_RECIPES.find((r) => r.className === className)!;
                throw new Error(
                    `${hits.length} line(s) write the deleted class \`${className}\`:\n` +
                        hits
                            .slice(0, 20)
                            .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
                            .join('\n') +
                        `\n\nThe rule no longer exists (deleted in ${entry.pr}), so the class ` +
                        `does nothing. ${entry.reason}`,
                );
            }
            expect(hits).toEqual([]);
        },
    );

    describe('the detectors have teeth (discriminating pairs, independent of the real tree)', () => {
        // Both assertions above are negative — they pass when they find
        // nothing, which is also what a broken detector finds. These run the
        // REAL functions over synthetic input where the answer is known.
        const CSS_FIXTURE = `
            @layer components {
              .page-header { position: sticky; }
              .page-header-ish { position: static; }
            }
            @supports (padding: env(safe-area-inset-bottom)) {
              .safe-area-bottom { padding-bottom: 1px; }
            }
            .glass-card { padding: 1rem; }
        `;

        it('POSITIVE — the CSS detector finds a re-added rule', () => {
            expect(rulesSelecting(CSS_FIXTURE, 'fixture.css', 'page-header')).toHaveLength(1);
            expect(rulesSelecting(CSS_FIXTURE, 'fixture.css', 'safe-area-bottom')).toHaveLength(1);
        });

        it('NEGATIVE — the CSS detector does not fire on a longer class name', () => {
            // `.page-header-ish` is in the fixture and must NOT be reported as
            // `.page-header`; `.glass-card` must not be reported at all.
            expect(rulesSelecting(CSS_FIXTURE, 'fixture.css', 'page-headerish')).toEqual([]);
            expect(rulesSelecting(CSS_FIXTURE, 'fixture.css', 'glass-car')).toEqual([]);
            const hits = rulesSelecting(CSS_FIXTURE, 'fixture.css', 'page-header');
            expect(hits.map((h) => h.selector)).toEqual(['.page-header']);
        });

        const SOURCE_POSITIVE = [
            'const a = <div className="flex page-header gap-3" />;',
            'const b = <div className={`safe-area-bottom`} />;',
            "const c = cn('page-header', x);",
        ].join('\n');

        const SOURCE_NEGATIVE = [
            '/* the page-header action cluster, and safe-area-bottom padding */',
            'const d = <div data-testid="page-header-back" />;',
            'const e = <PageHeader pageHeaderClassName="x" />; // page-header prose',
            'const f = locator(\'[data-testid="page-header-meta"]\');',
        ].join('\n');

        it('POSITIVE — the source detector finds the token in className, a template literal and cn()', () => {
            expect(linesWritingToken(SOURCE_POSITIVE, 'f.tsx', 'page-header').map((h) => h.line)).toEqual([
                1, 3,
            ]);
            expect(
                linesWritingToken(SOURCE_POSITIVE, 'f.tsx', 'safe-area-bottom').map((h) => h.line),
            ).toEqual([2]);
        });

        it('NEGATIVE — suffixed test ids, prose in comments and identifiers do not fire', () => {
            // This is the exact false positive that made a grep report
            // `.page-header` as "live, 3 occurrences".
            expect(linesWritingToken(SOURCE_NEGATIVE, 'f.tsx', 'page-header')).toEqual([]);
            expect(linesWritingToken(SOURCE_NEGATIVE, 'f.tsx', 'safe-area-bottom')).toEqual([]);
        });
    });
});

describe('deleted recipes are absent from the COMPILED stylesheet', () => {
    // Independent of the source scan above: this reads the BUILD PRODUCT, so
    // it also covers a rule arriving by some route other than a literal
    // declaration in globals.css (an `@apply`-ed plugin, a `@utility`, an
    // `@import`). Compiled in a child process because
    // `@tailwindcss/postcss` calls `module.registerHooks()` on import and
    // Jest refuses to load it — see tests/helpers/compile-globals-css.mjs,
    // shared with tests/guards/card-padding-cascade.test.ts.
    let css = '';

    beforeAll(() => {
        css = execFileSync(
            process.execPath,
            [path.join(REPO_ROOT, 'tests/helpers/compile-globals-css.mjs')],
            { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
    }, 180_000);

    it('compiles to something substantial (floor on the collector)', () => {
        expect(css.length).toBeGreaterThan(50_000);
    });

    it('POSITIVE CONTROL — still emits the recipes that are alive', () => {
        // Without this, "no `.page-header` in the compiled CSS" would also be
        // the answer for an empty or truncated compile.
        expect(css).toMatch(/\.glass-card\s*\{/);
        expect(css).toMatch(/\.icon-btn\s*\{/);
    });

    it.each(DELETED_RECIPES.map((r) => r.className))('emits no `.%s` rule', (className) => {
        const re = new RegExp(`\\.${className}(?![\\w-])[^{]*\\{`);
        const m = css.match(re);
        if (m) {
            const at = css.indexOf(m[0]);
            throw new Error(
                `the compiled stylesheet still carries a \`.${className}\` rule:\n` +
                    css.slice(Math.max(0, at - 120), at + 240),
            );
        }
        expect(m).toBeNull();
    });
});
