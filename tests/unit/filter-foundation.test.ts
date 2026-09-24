/**
 * Epic 53 — Enterprise Filter System foundation guard.
 *
 * `tests/unit/filter-system.test.ts` exercises the pure state/definition
 * layer. This suite guards the *structural* foundation the E53 prompt
 * calls out:
 *
 *   1. cmdk + motion are installed + versions lock to the epic's floor
 *   2. AnimatedSizeContainer is a forwardRef container backed by `motion`
 *   3. The `@/components/ui/filter` barrel surfaces the full public API
 *   4. The on-disk module layout matches GUIDE.md (no drift / no 2nd framework)
 *
 * Jest here is `testEnvironment: 'node'` and tsconfig has `jsx: "preserve"`,
 * so we can't `require(...)` tsx components at runtime. We therefore guard
 * React components by *source inspection* (proven structural invariants),
 * and only `require(...)` plain `.ts` modules. This is sufficient to catch
 * broken imports, missing exports, and bundling regressions without
 * bolting a second jest environment onto the repo.
 */

import * as path from 'path';
import * as fs from 'fs';

import { REPO_ROOT } from '../helpers/repo-files';

const FILTER_DIR = path.resolve(__dirname, '../../src/components/ui/filter');
const ANIMATED_CONTAINER = path.resolve(
    __dirname,
    '../../src/components/ui/animated-size-container.tsx',
);
const FILTER_BARREL_SRC = path.resolve(FILTER_DIR, 'index.ts');

import { codeOf } from '../helpers/source-blocks';
import { mdSection } from '../helpers/markdown-regions';

// #2246 Class A — the mask goes at the READ SEAM.
//
// `readFile` stays RAW and has exactly two callers, both deliberate: the
// `package.json` read below is handed to `JSON.parse`, where JSON is DATA and
// masking has no meaning, and the `GUIDE.md` read is markdown, which `codeOf`
// does not lex. Source reads go through `readSrc`, which masks.
//
// The GUIDE.md read is narrowed per-assertion rather than masked — see the
// measurement at its call site. `mdCodeOf` is not an option there: it keeps a
// document's CODE and blanks its PROSE, and this file's needles split across
// both halves.
function readFile(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}
function readSrc(p: string): string {
    return codeOf(readFile(p));
}

// ─── 1. Dependencies locked in package.json ──────────────────────────

describe('Epic 53 foundation — dependency layer', () => {
    const pkg = JSON.parse(
        readFile(path.resolve(__dirname, '../../package.json')),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    it('pins cmdk as a runtime dependency', () => {
        expect(deps.cmdk).toBeDefined();
        expect(deps.cmdk).toMatch(/^\^?\d+\./);
    });

    it('pins motion as a runtime dependency (motion v12+ is the repo choice over framer-motion)', () => {
        expect(deps.motion).toBeDefined();
        expect(deps.motion).toMatch(/^\^?\d+\./);
        // Sanity check — the epic targets motion v12+, not the older framer-motion namespace
        const major = Number(deps.motion.replace(/^[^\d]*/, '').split('.')[0]);
        expect(major).toBeGreaterThanOrEqual(12);
    });

    it('does not reintroduce framer-motion alongside motion (one animation lib only)', () => {
        expect(deps['framer-motion']).toBeUndefined();
    });

    // The specifier the APP actually imports, per dependency — not a guessed
    // directory. `src/` writes `import { Command } from 'cmdk'` and
    // `from 'motion/react'`; resolving those is the property this test claims.
    it.each([
        ['cmdk', 'cmdk'],
        ['motion', 'motion/react'],
    ])('resolves %s from disk (installed, not just declared)', (name, specifier) => {
        // Ask NODE to resolve it, rather than joining `node_modules` onto this
        // file's own directory. The join was a literal string concatenation and
        // did no upward walk, so it named a path that exists only in a checkout
        // owning its install. This repo is routinely checked out into
        // `.claude/worktrees/<id>/`, which has NO `node_modules` of its own —
        // it resolves upward to the primary clone at require time — so the
        // assertion false-failed for everyone using a worktree while passing in
        // CI's single checkout. Same defect, and the same fix, as
        // `tests/guardrails/next-image-optimizer-disabled.test.ts`.
        //
        // Resolving is also the better test of the stated property. "Installed,
        // not just declared" means Node can RESOLVE the package — which is what
        // the app does at runtime — not that a directory sits at a guessed
        // path. It additionally covers a case the directory check could not
        // see: an upgrade that keeps the files but narrows the `exports` map so
        // the entry point `src/` imports stops resolving.
        //
        // RESOLVE THE ENTRY POINT, NOT `<pkg>/package.json`. That subpath is
        // itself gated by `exports`, and cmdk's map declares only `"."` — so
        // `require.resolve('cmdk/package.json')` throws on a perfectly healthy
        // install. (motion, prisma and tsx all export `./package.json`, which
        // is why the same spelling is fine at those call sites. swagger-ui-dist
        // has no map at all.) Measured here, not assumed.
        //
        // `paths` is INERT under jest — jest-resolve ignores it and resolves
        // from THIS module, which walks up and finds the parent checkout
        // anyway. It is kept for a non-jest caller and because the precedent
        // guard spells it; see the header of
        // `tests/guardrails/vendored-swagger-ui-matches-dependency.test.ts`,
        // where that was measured. Do not rely on `paths` to redirect it.
        try {
            require.resolve(specifier, { paths: [REPO_ROOT] });
        } catch {
            // `require.resolve` THROWS rather than returning null, so the
            // message this assertion exists to deliver has to live here.
            throw new Error(
                `${name} is declared in package.json but Node cannot resolve ` +
                    `'${specifier}' from ${REPO_ROOT}. Either it is not installed ` +
                    '(run `npm install`), or an upgrade narrowed its `exports` map ' +
                    'and the entry point src/ imports no longer resolves.',
            );
        }
    });
});

// ─── 2. AnimatedSizeContainer contract ───────────────────────────────

describe('AnimatedSizeContainer — foundational animated container', () => {
    const src = readSrc(ANIMATED_CONTAINER);

    it('lives at the canonical path src/components/ui/animated-size-container.tsx', () => {
        expect(fs.existsSync(ANIMATED_CONTAINER)).toBe(true);
    });

    it('is backed by motion/react (not framer-motion)', () => {
        expect(src).toMatch(/from ['"]motion\/react['"]/);
        expect(src).not.toMatch(/framer-motion/);
    });

    it('is exported by name (tree-shake friendly, no default export)', () => {
        expect(src).toMatch(/export \{\s*AnimatedSizeContainer\s*\}/);
        expect(src).not.toMatch(/^export default/m);
    });

    it('uses forwardRef so consumers can measure the outer container', () => {
        expect(src).toMatch(/forwardRef</);
        expect(src).toMatch(/AnimatedSizeContainer\.displayName\s*=\s*['"]AnimatedSizeContainer['"]/);
    });

    it('accepts the documented width/height size-driving props', () => {
        expect(src).toMatch(/width\??: boolean/);
        expect(src).toMatch(/height\??: boolean/);
    });

    it('animates via motion.div (not plain div) so animations actually run', () => {
        expect(src).toMatch(/<motion\.div/);
    });

    it('uses useResizeObserver from the shared hooks module (no bespoke copy)', () => {
        expect(src).toMatch(/useResizeObserver/);
        expect(src).toMatch(/from ['"]\.\/hooks['"]/);
    });

    it('is the container that filter-list consumes (no duplicate implementation)', () => {
        const filterList = readSrc(path.join(FILTER_DIR, 'filter-list.tsx'));
        expect(filterList).toMatch(/AnimatedSizeContainer/);
        expect(filterList).toMatch(/from ['"]\.\.\/animated-size-container['"]/);
    });
});

// ─── 3. Filter barrel — public surface & source-level exports ────────

describe('Filter barrel — @/components/ui/filter public API', () => {
    const src = readSrc(FILTER_BARREL_SRC);

    it('re-exports the composite Filter object with Select + List slots', () => {
        expect(src).toMatch(/const Filter = \{\s*Select: FilterSelect,\s*List: FilterList\s*\}/);
        expect(src).toMatch(/export \{ Filter \}/);
    });

    it('re-exports the core type names', () => {
        for (const name of [
            'ActiveFilter',
            'ActiveFilterInput',
            'FilterOption',
            'FilterOperator',
        ]) {
            expect(src).toContain(name);
        }
    });

    it('re-exports the definition factory helpers', () => {
        for (const name of ['createFilterDefs', 'optionsFromEnum', 'optionsFromArray']) {
            expect(src).toContain(name);
        }
    });

    it('re-exports the pure state mutation surface', () => {
        const mutators = [
            'addFilterValue',
            'removeFilterValue',
            'toggleFilterValue',
            'setFilterValue',
            'removeFilter',
            'clearAllFilters',
        ];
        for (const fn of mutators) {
            expect(src).toContain(fn);
        }
    });

    it('re-exports URL ↔ state conversion functions', () => {
        for (const fn of [
            'parseUrlToFilterState',
            'filterStateToUrlParams',
            'filterStateToActiveFilters',
            'activeFiltersToFilterState',
        ]) {
            expect(src).toContain(fn);
        }
    });

    it('re-exports query helpers consumers rely on', () => {
        for (const fn of [
            'isFilterActive',
            'isValueSelected',
            'countActiveFilters',
            'countActiveFilterKeys',
            'hasActiveFilters',
        ]) {
            expect(src).toContain(fn);
        }
    });

    it('re-exports the Epic 52 CompactFilterBar compatibility bridges', () => {
        expect(src).toContain('fromCompactFilterState');
        expect(src).toContain('toCompactFilterState');
    });

    it('re-exports the React context, provider, and hooks', () => {
        for (const name of ['FilterProvider', 'useFilterContext', 'useFilters']) {
            expect(src).toContain(name);
        }
    });
});

// ─── 4. Pure-layer smoke via require() (TS is fine; TSX is not in node env) ──

describe('Filter pure layer — runtime load', () => {

    const state = require('../../src/components/ui/filter/filter-state');

    const defs = require('../../src/components/ui/filter/filter-definitions');

    it('filter-state.ts loads and exposes its pure API', () => {
        for (const fn of [
            'addFilterValue',
            'parseUrlToFilterState',
            'filterStateToUrlParams',
            'fromCompactFilterState',
            'toCompactFilterState',
        ]) {
            expect(typeof state[fn]).toBe('function');
        }
    });

    it('filter-definitions.ts loads and exposes the factory + option helpers', () => {
        expect(typeof defs.createFilterDefs).toBe('function');
        expect(typeof defs.optionsFromEnum).toBe('function');
        expect(typeof defs.optionsFromArray).toBe('function');
    });

    it('extractFilterOptions lives in filter-state.ts (the data-shaping layer)', () => {
        // Barrel re-exports it from filter-state, not filter-definitions — codifying
        // the "filter-definitions = static, filter-state = runtime data" split.
        expect(typeof state.extractFilterOptions).toBe('function');
    });
});

// ─── 5. Module layout matches GUIDE.md ───────────────────────────────

describe('Filter module — canonical file layout', () => {
    const required = [
        'index.ts',
        'types.ts',
        'filter-state.ts',
        'filter-definitions.ts',
        'filter-context.tsx',
        'filter-select.tsx',
        'filter-select-utils.ts',
        'filter-list.tsx',
        'filter-range-panel.tsx',
        'filter-range-utils.ts',
        'filter-scroll.tsx',
        'filter-examples.ts',
        'GUIDE.md',
    ];

    it.each(required)('has %s', (file) => {
        const p = path.join(FILTER_DIR, file);
        expect(fs.existsSync(p)).toBe(true);
    });

    it('has no subdirectories — foundation must stay flat to prevent framework drift', () => {
        const entries = fs.readdirSync(FILTER_DIR, { withFileTypes: true });
        const directories = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        expect(directories).toEqual([]);
    });

    it('has a GUIDE.md that pins the epic and the canonical usage', () => {
        const guide = readFile(path.join(FILTER_DIR, 'GUIDE.md'));

        // THE EPIC PIN STAYS RAW, and this is the one site in this file that
        // does (#2246). It lives in the document's PREAMBLE — the blockquote
        // under the `#` title, above the first `##` — and neither tool reaches
        // it: `mdCodeOf` takes it to ZERO (it is prose, not a code span), and
        // `markdown-regions` cuts ATX sections, of which the preamble is not
        // one. The other `Epic 53` in the document is inside a Migration Path
        // subheading, so narrowing to THAT would bind this assertion to a
        // different claim than the one its name makes. Measured: 2 raw, 0
        // through `mdCodeOf`, 0 in the Quick Start section.
        expect(guide).toMatch(/Epic\s*53/i);

        // THE CANONICAL USAGE is narrowed, because "canonical" names a place:
        // the Quick Start block a reader copies from. Against the whole
        // document `createFilterDefs` matched 7 times and `useFilterContext`
        // 11 — a DO/DON'T bullet, a migration note or an API table kept this
        // green with the worked example deleted. Bound to the section: 7→2
        // and 11→2.
        const quickStart = mdSection(
            guide,
            'Quick Start — Adding Filters to a List Page',
        );
        expect(quickStart).toMatch(/createFilterDefs/);
        expect(quickStart).toMatch(/useFilterContext/);
    });
});
