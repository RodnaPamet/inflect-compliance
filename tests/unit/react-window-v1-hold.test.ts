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
 * for, and here it is also the only CORRECT implementation. Measured in this
 * tree: FOUR files under `src/` contain the string `react-window`, and only
 * TWO import it. `combobox/virtualized-options.tsx` and `table/data-table.tsx`
 * name it in prose. A grep-shaped guard would report four seams and be wrong;
 * a `not.toMatch` form would be satisfied by a comment. An `ImportDeclaration`
 * cannot be written in a comment, so the AST answers the question asked.
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
 * POSITIVE CONTROL floor. An empty or broken scan satisfies every set
 * comparison below by vacuity, which is the failure mode the guard exists to
 * avoid. Measured at 2,682; the floor is set well under it so ordinary growth
 * or deletion never trips it, and a scan that collapses does.
 */
const MIN_SRC_FILES_SCANNED = 2000;

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
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    return found ? [...names].sort() : null;
}

/** True when the file passes a JSX attribute of this name anywhere. */
export function usesJsxAttribute(
    sourceText: string,
    fileLabel: string,
    attribute: string,
): boolean {
    const sf = ts.createSourceFile(
        fileLabel,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    let seen = false;
    const visit = (node: ts.Node): void => {
        if (
            ts.isJsxAttribute(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === attribute
        ) {
            seen = true;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return seen;
}

// ───────────────────────────── the live scan ───────────────────────────────

/** Leading major of a semver or a range (`^1.8.11` -> 1). */
function majorOf(version: string): number {
    const m = /(\d+)\s*\./.exec(version);
    if (m === null) throw new Error(`cannot read a major version from "${version}"`);
    return Number(m[1]);
}

const SRC_FILES = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });

/**
 * Repo-relative paths that really import `MODULE`, with their bindings.
 *
 * Pre-filtered on the raw text purely for speed — an `ImportDeclaration`'s
 * specifier is a string literal, so a file that lacks the substring cannot
 * import it. The AST, never the substring, decides.
 */
const liveSeams = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const abs of SRC_FILES) {
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
) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

const lock = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
) as { packages: Record<string, { version?: string }> };

describe('react-window is held on v1 (#2552, docs/dependency-governance.md)', () => {
    describe('the version pin', () => {
        it('declares a v1 range for react-window and its v1-era types', () => {
            expect(majorOf(pkg.dependencies[MODULE])).toBe(1);
            expect(majorOf(pkg.devDependencies[`@types/${MODULE}`])).toBe(1);
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
            const installed = JSON.parse(
                fs.readFileSync(
                    path.join(REPO_ROOT, 'node_modules', MODULE, 'package.json'),
                    'utf8',
                ),
            ) as { version: string };
            expect(majorOf(installed.version)).toBe(1);
        });
    });

    describe('the blast radius — exactly two seams, deliberately independent', () => {
        it('scans a population large enough to be meaningful', () => {
            // Without this, every set comparison below passes on an empty scan.
            expect(SRC_FILES.length).toBeGreaterThan(MIN_SRC_FILES_SCANNED);
        });

        it('is imported by exactly the two documented seams', () => {
            expect([...liveSeams().keys()].sort()).toEqual([...DOCUMENTED_SEAMS]);
        });

        it('imports only v1 identifiers, every one of which v2 removed', () => {
            const seams = liveSeams();
            for (const [rel, expected] of Object.entries(EXPECTED_BINDINGS)) {
                expect(seams.get(rel)).toEqual([...expected]);
            }
        });

        it('still hosts the sticky header through outerElementType, which v2 cannot express', () => {
            // The decision record calls this "the load-bearing one": v2 offers
            // `tagName` (a tag NAME, not a component), so a memoised component
            // passed as `outerElementType` has no v2 equivalent and the port is
            // design work. If this disappears, either the seam was ported or the
            // sticky-header contract changed — both need the section re-argued.
            const rel = 'src/components/ui/table/virtual-table-body.tsx';
            const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            expect(usesJsxAttribute(text, rel, 'outerElementType')).toBe(true);
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

        it('returns null for a file that imports something else entirely', () => {
            expect(
                importedBindings(`import { AutoSizer } from "react-virtualized-auto-sizer";`, TSX, MODULE),
            ).toBeNull();
        });

        it('the outerElementType detector distinguishes an attribute from a mention', () => {
            expect(usesJsxAttribute(`<L outerElementType={O} />`, TSX, 'outerElementType')).toBe(true);
            expect(usesJsxAttribute(`// outerElementType={O}`, TSX, 'outerElementType')).toBe(false);
            expect(usesJsxAttribute(`<L tagName="div" />`, TSX, 'outerElementType')).toBe(false);
        });

        it('majorOf reads a range, a plain version and a v2 bump', () => {
            expect(majorOf('^1.8.11')).toBe(1);
            expect(majorOf('1.8.11')).toBe(1);
            expect(majorOf('^2.3.1')).toBe(2);
            expect(() => majorOf('latest')).toThrow();
        });
    });
});
