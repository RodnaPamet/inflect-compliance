/**
 * `react-window` is held on v1 deliberately. This file is the enforcement.
 *
 * WHY IT EXISTS (#2646). `docs/dependency-governance.md` records the decision
 * (#2552, dependabot #2543 closed on purpose) and — at the time this was
 * written — already ASSERTED that this very file enforced it:
 *
 *     "`tests/unit/react-window-v1-hold.test.ts` pins both halves … A third
 *      importer, or a bump to v2, turns it red."
 *
 * The file did not exist. That doc is classified `authoritative`, where every
 * claim must be true today, and `docs-accuracy.test.ts` cannot catch this
 * class: it looks for future-tense markers, not for a false statement in the
 * present tense. A doc claiming an enforcement that is absent is worse than a
 * doc claiming nothing, because it answers "is this guarded?" wrongly and
 * stops the reader looking. Writing the file is what makes the sentence true.
 *
 * WHY IT READS NOTHING AS TEXT, which is the part worth copying.
 * The draft guard in #2552 was dropped because it cost shared, zero-allowance
 * budget: `RAW_ASSERTING_FILE_BASELINE` (Class A) and
 * `UNANALYSABLE_READ_BASELINE` (Class D), both `DRIFT_ALLOWANCE 0` and both
 * contended with other sessions' open PRs. Living in `tests/unit/` dodges the
 * guard-file CEILING and nothing else — Class A scans `testFilesUnder(['tests'])`,
 * the whole tree.
 *
 * Both populations collect exactly one shape: an `expect()` whose MATCHER is
 * `toMatch`/`toContain` and whose SUBJECT resolves to the whole text of a file
 * on disk. So this file asserts with `toBe` / `toEqual` / `toHaveLength` over
 * values computed from a TypeScript AST and from `require`d JSON. Nothing here
 * is a raw-text assertion, so it joins neither population and spends neither
 * budget.
 *
 * That is NOT a trick played on the ratchet — it is the fix the ratchet asks
 * for, and here it is also the only CORRECT implementation. Measured over the
 * whole repository: NINE files contain the string `react-window` and only TWO
 * depend on it. The other seven name it in prose — two sibling components,
 * three rendered tests, and this file. A grep-shaped guard would report nine
 * seams and be wrong by seven; a `not.toMatch` form would be satisfied by any
 * one of those comments. An `ImportDeclaration` cannot be written in a
 * comment, so the AST answers the question that was actually asked.
 *
 * WHAT THIS DOES NOT CLAIM. It does not check that the decision is still a
 * good one, and it must not: CLAUDE.md's "never gate CI on prose" is the rule
 * that deleted `rq3-11-capstone`. Nothing below reads a markdown file. When
 * this goes red the answer is to re-argue the section in the same PR, not to
 * edit a number until it passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';

const MODULE = 'react-window';

/** The two seams `docs/dependency-governance.md` names, and nothing else. */
const DOCUMENTED_SEAMS = [
    'src/components/ui/table/virtual-table-body.tsx',
    'src/components/ui/virtualized-list.tsx',
] as const;

/**
 * The v1 identifiers each seam depends on. These ARE the hold: every one of
 * them is absent from `react-window@2`'s type definitions, which exports a
 * single `List` plus `Grid` instead. A port that kept the import count at two
 * would still have to change this set, so the set is the tighter pin.
 */
const EXPECTED_BINDINGS: Readonly<Record<string, readonly string[]>> = {
    'src/components/ui/table/virtual-table-body.tsx': ['FixedSizeList'],
    'src/components/ui/virtualized-list.tsx': [
        'FixedSizeList',
        'ListChildComponentProps',
        'VariableSizeList',
    ],
};

/**
 * The scan is REPO-WIDE, not `src/`-scoped, and covers every extension a
 * module can be imported from. Scoping it to `src/**\/*.{ts,tsx}` would have
 * left three ways to add a seam invisibly: a `.js`/`.mjs` file, a file outside
 * `src/`, and a script or test that imports the module directly. The text
 * prefilter keeps the whole-repo walk at ~230ms for 5,238 files.
 */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * POSITIVE CONTROL floor, for PARTIAL collapse specifically.
 *
 * This comment used to claim the floor stopped an empty scan passing "by
 * vacuity". That was false, and the falsehood is worth leaving recorded: an
 * EMPTY scan makes `liveSeams()` return nothing, and comparing nothing against
 * a two-element `DOCUMENTED_SEAMS` FAILS. The set assertions already fail
 * closed, so the floor buys nothing there.
 *
 * What it does buy is the partial case, which does not fail closed: a scan
 * that still reaches `src/components/ui`, where both seams live, but has lost
 * most of the tree — a broken `under:` filter, a git population that came back
 * truncated. Every assertion below still passes while the guard has gone blind
 * everywhere else. Measured at 5,238 files; the floor sits under it with room
 * for ordinary deletion.
 */
const MIN_FILES_SCANNED = 4000;

// ───────────────────────── primitives, unit-testable in memory ─────────────
//
// Each takes SOURCE TEXT rather than a path, so the mutation proofs at the
// bottom can feed them a synthetic file. A detector that can only be pointed
// at the real tree cannot be shown to detect anything.

/**
 * Sorted binding names imported from `spec`, or `null` when the module is not
 * imported at all. `import type { X }` and a bare `import 'x'` both count as
 * imports — a type-only edge still pins the API surface.
 */
export function importedBindings(
    sourceText: string,
    fileLabel: string,
    spec: string,
): string[] | null {
    const sf = ts.createSourceFile(
        fileLabel,
        sourceText,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        fileLabel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    let found = false;
    const names = new Set<string>();

    const visit = (node: ts.Node): void => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === spec
        ) {
            found = true;
            const clause = node.importClause;
            if (clause?.name) names.add(clause.name.text);
            if (clause?.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) {
                    names.add(`* as ${clause.namedBindings.name.text}`);
                } else {
                    for (const el of clause.namedBindings.elements) {
                        // `propertyName` is the name in the MODULE; `name` is
                        // the local alias. Pin the module's name, so a rename
                        // at the call site does not read as an API change.
                        names.add((el.propertyName ?? el.name).text);
                    }
                }
            }
        }
        // `export { X } from 'react-window'` re-exports the surface just as
        // an import does, and would otherwise be an invisible third seam.
        //
        // NOTE the aliasing orientation differs from an import and it is easy
        // to get backwards. `import { A as B }` and `export { A as B } from`
        // both put the MODULE's name in `propertyName` and the local/exported
        // alias in `name`, so `propertyName ?? name` is right for both — but
        // only because the re-export carries a `from` clause. A local
        // `export { local as Public }` has no module specifier and never
        // reaches this branch.
        if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === spec
        ) {
            found = true;
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                for (const el of node.exportClause.elements) {
                    names.add((el.propertyName ?? el.name).text);
                }
            } else {
                // `export * from 'react-window'` re-exports the entire surface.
                names.add('* (star re-export)');
            }
        }

        // A dynamic `import('react-window')` or a `require('react-window')` is
        // a real runtime dependency on the module and is NOT an
        // `ImportDeclaration` — so a guard that only walked import statements
        // would call this file clean while it pulled the whole package in.
        if (ts.isCallExpression(node) && node.arguments.length > 0) {
            const callee = node.expression;
            const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
            const req = ts.isIdentifier(callee) && callee.text === 'require';
            const arg = node.arguments[0];
            if ((dynamic || req) && ts.isStringLiteral(arg) && arg.text === spec) {
                found = true;
                names.add(dynamic ? '(dynamic import)' : '(require)');
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    return found ? [...names].sort() : null;
}

/**
 * True when the file passes a prop of this name — as a JSX attribute OR as an
 * object-literal property.
 *
 * THE SECOND HALF IS NOT DECORATION. The first draft matched only
 * `ts.isJsxAttribute`, and the sibling seam `virtualized-list.tsx:193-224`
 * already hoists its props into `const commonProps = {...} as const` and
 * spreads them into both list components. So unifying the two seams' call
 * shapes — ordinary tidying that keeps react-window on v1 and keeps the prop —
 * would have turned this guard red. A guard that reddens on innocent work gets
 * routed around, so matching the PROP rather than the SYNTAX is the fix.
 *
 * An object-literal property cannot be written in a comment either, so the
 * Class A immunity this file depends on is preserved.
 */
export function passesProp(
    sourceText: string,
    fileLabel: string,
    prop: string,
): boolean {
    const sf = ts.createSourceFile(
        fileLabel,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    let seen = false;
    const named = (n: ts.Node): boolean =>
        (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === prop;

    const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && named(node.name)) seen = true;
        if (ts.isPropertyAssignment(node) && named(node.name)) seen = true;
        if (ts.isShorthandPropertyAssignment(node) && named(node.name)) seen = true;
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return seen;
}

// ───────────────────────────── the live scan ───────────────────────────────

/**
 * Leading major of a semver or a range (`^1.8.11` -> 1).
 *
 * ANCHORED on purpose. An unanchored `(\d+)\.` reads a major out of whatever
 * digit it meets first, so `npm:react-window@2.3.1` or a git URL could yield a
 * number from the wrong part of the string — a silent wrong answer in the one
 * function every version assertion depends on. Anchoring makes those throw
 * instead, and `expectPinnedToV1` below refuses the range shapes that this
 * function alone cannot judge.
 */
export function majorOf(version: string): number {
    const m = /^[\s^~=v]*(\d+)\./.exec(version);
    if (m === null) throw new Error(`cannot read a major version from "${version}"`);
    return Number(m[1]);
}

/**
 * True only for a range that CANNOT install a different major: an exact
 * version, or a caret/tilde on one. `>=1.0.0` reads as major 1 and admits
 * 2.x, which is precisely the hole a major-only check leaves open.
 */
export function isSingleMajorPin(range: string): boolean {
    return /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range.trim());
}

const ALL_FILES = repoFiles({ extensions: [...SCANNED_EXTENSIONS] });

/**
 * Repo-relative paths that really import `MODULE`, with their bindings.
 *
 * Pre-filtered on the raw text purely for speed — an `ImportDeclaration`'s
 * specifier is a string literal, so a file that lacks the substring cannot
 * import it. The AST, never the substring, decides.
 */
const liveSeams = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const abs of ALL_FILES) {
        const text = fs.readFileSync(abs, 'utf8');
        if (!text.includes(MODULE)) continue;
        const rel = repoRelative(abs);
        const bindings = importedBindings(text, rel, MODULE);
        if (bindings !== null) out.set(rel, bindings);
    }
    return out;
};

const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    overrides?: Record<string, unknown>;
};

const lock = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
) as { packages: Record<string, { version?: string }> };

describe('react-window is held on v1 (#2552, docs/dependency-governance.md)', () => {
    describe('the version pin', () => {
        it('declares a v1 range for react-window and its v1-era types', () => {
            expect(majorOf(pkg.dependencies[MODULE])).toBe(1);
            expect(majorOf(pkg.devDependencies[`@types/${MODULE}`])).toBe(1);
        });

        it('declares a range that CANNOT reach another major', () => {
            // A major-only check passes `>=1.0.0`, which installs 2.x the day
            // it publishes. A caret or tilde on a 1.x version provably cannot.
            expect(isSingleMajorPin(pkg.dependencies[MODULE])).toBe(true);
            expect(isSingleMajorPin(pkg.devDependencies[`@types/${MODULE}`])).toBe(true);
        });

        it('has no override or resolution redirecting the package elsewhere', () => {
            // `overrides` can install a different major under an untouched
            // range — the shape #2545 exists to catch. An entry here is not
            // forbidden, but it must be argued rather than arrive silently.
            expect(pkg.overrides?.[MODULE]).toBeUndefined();
            expect(pkg.overrides?.[`@types/${MODULE}`]).toBeUndefined();
        });

        it('RESOLVES to v1 in the lockfile, which the range alone does not promise', () => {
            // The hono lesson (#2545): a range admitting a version is not the
            // same as that version being installed, and the reverse holds too
            // — `^1.8.11` cannot reach 2.x, but a lockfile edited by hand or
            // an override can. The resolved version is the one that ships.
            expect(majorOf(lock.packages[`node_modules/${MODULE}`].version!)).toBe(1);
            expect(
                majorOf(lock.packages[`node_modules/@types/${MODULE}`].version!),
            ).toBe(1);
        });

        it('has the INSTALLED tree on v1 too, which the lockfile alone does not promise', () => {
            // This repo shares one node_modules across worktrees and it drifts
            // behind the lockfile. Majors are compared, not exact versions, so
            // ordinary drift inside v1 is not a false red.
            //
            // ASK NODE'S RESOLVER, never a spelled path. A `.claude/worktrees/<id>/`
            // checkout has no `node_modules` of its own and resolves UPWARD to the
            // primary clone, so `path.join(REPO_ROOT, 'node_modules', …)` fails for
            // worktree users while passing in CI — or skips itself green behind an
            // `existsSync`. `dependency-paths-are-resolved` caught that here, on the
            // first draft of this very file. Neither package declares an `exports`
            // map, so the `<pkg>/package.json` subpath is reachable; that is a
            // precondition of this shape, not a given.
            const installed = require(`${MODULE}/package.json`) as { version: string };
            const installedTypes = require(`@types/${MODULE}/package.json`) as {
                version: string;
            };
            expect(majorOf(installed.version)).toBe(1);
            expect(majorOf(installedTypes.version)).toBe(1);
        });
    });

    describe('the blast radius — exactly two seams, deliberately independent', () => {
        it('scans a population large enough to be meaningful', () => {
            // Without this, every set comparison below passes on an empty scan.
            expect(ALL_FILES.length).toBeGreaterThan(MIN_FILES_SCANNED);
        });

        it('is depended on by exactly the two documented seams, repo-wide', () => {
            expect([...liveSeams().keys()].sort()).toEqual([...DOCUMENTED_SEAMS]);
        });

        it('has a binding expectation for every documented seam', () => {
            // WITHOUT THIS, the binding check below is vacuous. It used to
            // iterate `Object.entries(EXPECTED_BINDINGS)`, so emptying or
            // thinning that table deleted the assertion silently and left a
            // green suite — the precise defect this file claims to close,
            // sitting inside it. Pin the table's key set so thinning is red.
            expect(Object.keys(EXPECTED_BINDINGS).sort()).toEqual([...DOCUMENTED_SEAMS]);
        });

        it('imports only v1 identifiers, every one of which v2 removed', () => {
            // One whole-map comparison rather than a loop: a map equality
            // cannot go vacuous the way a loop over a table can, and it
            // reports the seam set and the bindings in a single diff.
            const live = Object.fromEntries([...liveSeams()].sort());
            expect(live).toEqual(EXPECTED_BINDINGS);
        });

        it('still hosts the sticky header through outerElementType, which v2 cannot express', () => {
            // The decision record calls this "the load-bearing one": v2 offers
            // `tagName` (a tag NAME, not a component), so a memoised component
            // passed as `outerElementType` has no v2 equivalent and the port is
            // design work. If this disappears, either the seam was ported or the
            // sticky-header contract changed — both need the section re-argued.
            const rel = 'src/components/ui/table/virtual-table-body.tsx';
            const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            expect(passesProp(text, rel, 'outerElementType')).toBe(true);
        });
    });

    /**
     * MUTATION PROOFS. Green proves nothing on its own — an empty selection is
     * a pass. Each of these breaks the input and requires the detector to
     * change its answer, in memory, so no tracked file is ever mutated.
     */
    describe('the detector can actually fail', () => {
        const TSX = 'src/components/ui/fake.tsx';

        it('sees a third importer', () => {
            expect(
                importedBindings(`import { FixedSizeList } from "react-window";`, TSX, MODULE),
            ).toEqual(['FixedSizeList']);
        });

        it('is NOT satisfied by a comment naming the module — the Class A defect', () => {
            // This is not hypothetical: two files in this tree mention
            // `react-window` in prose and import nothing.
            const prose = [
                '// react-window is deliberately not used here; see',
                '/* virtualized-list.tsx imports react-window instead */',
                'const note = "react-window";',
            ].join('\n');
            expect(importedBindings(prose, TSX, MODULE)).toBeNull();
        });

        it('reports a v2-shaped import as a DIFFERENT binding set', () => {
            expect(
                importedBindings(`import { List, type RowComponentProps } from "react-window";`, TSX, MODULE),
            ).toEqual(['List', 'RowComponentProps']);
        });

        it('sees a re-export, which would otherwise be an invisible seam', () => {
            expect(
                importedBindings(`export { FixedSizeList } from "react-window";`, TSX, MODULE),
            ).toEqual(['FixedSizeList']);
        });

        it('pins the MODULE name, not the local alias', () => {
            expect(
                importedBindings(`import { FixedSizeList as L } from "react-window";`, TSX, MODULE),
            ).toEqual(['FixedSizeList']);
        });

        it('sees a DYNAMIC import, which is not an ImportDeclaration', () => {
            expect(
                importedBindings(`const m = await import("react-window");`, TSX, MODULE),
            ).toEqual(['(dynamic import)']);
        });

        it('sees a require(), which is not an ImportDeclaration either', () => {
            expect(
                importedBindings(`const { FixedSizeList } = require("react-window");`, TSX, MODULE),
            ).toEqual(['(require)']);
        });

        it('sees a star re-export, which names no bindings to compare', () => {
            expect(importedBindings(`export * from "react-window";`, TSX, MODULE)).toEqual([
                '* (star re-export)',
            ]);
        });

        it('sees a side-effect-only import', () => {
            expect(importedBindings(`import "react-window";`, TSX, MODULE)).toEqual([]);
        });

        it('sees a namespace import', () => {
            expect(importedBindings(`import * as RW from "react-window";`, TSX, MODULE)).toEqual([
                '* as RW',
            ]);
        });

        it('pins the MODULE name on a re-export alias too, not the exported one', () => {
            expect(
                importedBindings(`export { FixedSizeList as Rows } from "react-window";`, TSX, MODULE),
            ).toEqual(['FixedSizeList']);
        });

        it('is not fooled by a require of a DIFFERENT module', () => {
            expect(
                importedBindings(`const x = require("react-window-fake");`, TSX, MODULE),
            ).toBeNull();
        });

        it('returns null for a file that imports something else entirely', () => {
            expect(
                importedBindings(`import { AutoSizer } from "react-virtualized-auto-sizer";`, TSX, MODULE),
            ).toBeNull();
        });

        it('the outerElementType detector distinguishes a prop from a mention', () => {
            expect(passesProp(`<L outerElementType={O} />`, TSX, 'outerElementType')).toBe(true);
            expect(passesProp(`// outerElementType={O}`, TSX, 'outerElementType')).toBe(false);
            expect(passesProp(`/* outerElementType: O */`, TSX, 'outerElementType')).toBe(false);
            expect(passesProp(`<L tagName="div" />`, TSX, 'outerElementType')).toBe(false);
        });

        it('the prop detector survives the props-hoist the sibling seam already uses', () => {
            // virtualized-list.tsx builds `const commonProps = {...} as const`
            // and spreads it. Unifying the seams must not redden this guard.
            expect(
                passesProp(`const p = { outerElementType: O }; <L {...p} />`, TSX, 'outerElementType'),
            ).toBe(true);
            expect(
                passesProp(`const outerElementType = O; const p = { outerElementType };`, TSX, 'outerElementType'),
            ).toBe(true);
            expect(
                passesProp(`const p = { "outerElementType": O };`, TSX, 'outerElementType'),
            ).toBe(true);
        });

        it('majorOf reads a range, a plain version and a v2 bump', () => {
            expect(majorOf('^1.8.11')).toBe(1);
            expect(majorOf('~1.8.11')).toBe(1);
            expect(majorOf('1.8.11')).toBe(1);
            expect(majorOf('^2.3.1')).toBe(2);
        });

        it('majorOf REFUSES a string it cannot anchor, rather than guessing', () => {
            // Each of these would yield a plausible wrong number under an
            // unanchored `(\d+)\.` — which is why the pattern is anchored.
            expect(() => majorOf('latest')).toThrow();
            expect(() => majorOf('npm:react-window@2.3.1')).toThrow();
            expect(() => majorOf('github:bvaughn/react-window#1.8.11')).toThrow();
            expect(() => majorOf('')).toThrow();
        });

        it('isSingleMajorPin admits only ranges that cannot cross a major', () => {
            expect(isSingleMajorPin('^1.8.11')).toBe(true);
            expect(isSingleMajorPin('~1.8.8')).toBe(true);
            expect(isSingleMajorPin('1.8.11')).toBe(true);
            // Reads as major 1 and installs 2.x the day it publishes.
            expect(isSingleMajorPin('>=1.0.0')).toBe(false);
            expect(isSingleMajorPin('*')).toBe(false);
            expect(isSingleMajorPin('1.x')).toBe(false);
            expect(isSingleMajorPin('>=1.0.0 <3.0.0')).toBe(false);
        });
    });
});
