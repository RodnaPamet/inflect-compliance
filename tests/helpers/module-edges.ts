/**
 * WHO IMPORTS A MODULE, AND HOW A BINDING IS USED — read off the syntax tree.
 *
 * Seam guards ask "which files import X?" and "who calls function F?". Asked
 * with a regex over the source text, both questions have holes the size of a
 * spelling: `'../pii/presidio-provider'`, a double-quoted specifier, a
 * `require`, an `import()`, `import x = require(…)`, an alias
 * (`import { f as g }`), a namespace (`ns['f'](…)`) or the function handed
 * along — each reaches the module with no match, and the guard stays green
 * over exactly the code it exists to catch.
 *
 * So the edges here are every module reference a file makes, each resolved to
 * the repo file it names (`resolveSpecifier`, shared with the client import
 * graph), and the binding scan reports every reference to an imported function
 * that is not a plain, direct call.
 *
 * A dynamic `import()` / `require()` whose argument is not a literal names no
 * module this scan can resolve; `nonLiteralModuleLoads` reports those so a
 * guard can refuse them in the population it holds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { resolveSpecifier } from './client-import-graph';
import { REPO_ROOT, repoRelative } from './repo-files';

export type EdgeKind = 'import' | 'export' | 'import-equals' | 'dynamic-import' | 'require';

export interface ModuleEdge {
    kind: EdgeKind;
    /** The specifier as written. */
    spec: string;
    /** Repo-relative path of the file it names, or null for a package. */
    target: string | null;
    /** `import type` / `export type` (or an all-`type` specifier list): erased, constructs nothing. */
    typeOnly: boolean;
    node: ts.Node;
}

const parse = (file: string, source: string) =>
    ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const resolveRel = (spec: string, fileRel: string): string | null => {
    const abs = resolveSpecifier(spec, path.join(REPO_ROOT, fileRel));
    return abs ? repoRelative(abs) : null;
};

const isLoadCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'));

/** Every module reference in `source`, resolved. `fileRel` is the file's repo-relative path. */
export function moduleEdgesOf(fileRel: string, source: string, sf: ts.SourceFile = parse(fileRel, source)): ModuleEdge[] {
    const out: ModuleEdge[] = [];
    const push = (kind: EdgeKind, spec: string, typeOnly: boolean, node: ts.Node) =>
        out.push({ kind, spec, target: resolveRel(spec, fileRel), typeOnly, node });
    const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            const c = n.importClause;
            const typeOnly =
                !!c &&
                (c.isTypeOnly ||
                    (!c.name &&
                        !!c.namedBindings &&
                        ts.isNamedImports(c.namedBindings) &&
                        c.namedBindings.elements.length > 0 &&
                        c.namedBindings.elements.every((e) => e.isTypeOnly)));
            push('import', n.moduleSpecifier.text, typeOnly, n);
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
            const typeOnly =
                n.isTypeOnly ||
                (!!n.exportClause &&
                    ts.isNamedExports(n.exportClause) &&
                    n.exportClause.elements.length > 0 &&
                    n.exportClause.elements.every((e) => e.isTypeOnly));
            push('export', n.moduleSpecifier.text, typeOnly, n);
        } else if (
            ts.isImportEqualsDeclaration(n) &&
            ts.isExternalModuleReference(n.moduleReference) &&
            ts.isStringLiteralLike(n.moduleReference.expression)
        ) {
            push('import-equals', n.moduleReference.expression.text, n.isTypeOnly, n);
        } else if (isLoadCall(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0])) {
            push(n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require', n.arguments[0].text, false, n);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/**
 * The files under `src/` allowed a non-literal `import()` / `require()`, each
 * with the reason it cannot name a seam module. A guard that relies on the
 * edges above holds the population to exactly this list, so a load that hides
 * its target from the scan is a decision, not an accident.
 */
export const NON_LITERAL_LOAD_SITES: Record<string, string> = {
    'src/i18n.ts': 'Loads `../messages/${locale}.json`: a JSON message catalogue, never a TypeScript module.',
};

/** `import(x)` / `require(x)` whose argument is not a literal: a module this scan cannot name. */
export function nonLiteralModuleLoads(fileRel: string, source: string): number {
    let count = 0;
    const visit = (n: ts.Node): void => {
        if (isLoadCall(n) && !(n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]))) count += 1;
        ts.forEachChild(n, visit);
    };
    visit(parse(fileRel, source));
    return count;
}

const readRel = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The files in `population` that reference `targetRel` by value (any edge kind but a type-only one). */
export function valueImportersOf(targetRel: string, population: readonly string[], read: (rel: string) => string = readRel): string[] {
    const base = path.basename(targetRel).replace(/\.[^.]+$/, '');
    return population
        .filter((f) => f !== targetRel)
        // Cheap pre-filter: every specifier naming the target contains its basename
        // (or is a directory index, which names the directory).
        .filter((f) => {
            const src = read(f);
            return src.includes(base) || base === 'index';
        })
        .filter((f) => moduleEdgesOf(f, read(f)).some((e) => !e.typeOnly && e.target === targetRel))
        .sort();
}

export interface FunctionUse {
    /** Files that bind the function by its own name and only ever call it directly. */
    callers: string[];
    /** `file:line reason` for every other way the function is reached. */
    misuses: string[];
}

/**
 * How `fn`, exported by `moduleRel`, is reached from `fileRel`.
 *
 * Allowed: `import { fn } from '<module>'` (any spelling that resolves to it)
 * and direct calls `fn(…)`. Everything else is a misuse — an alias, a
 * namespace import, a default import, a re-export (named or `*`),
 * `import x = require`, a `require`/`import()` of the module, and any
 * reference to `fn` other than as a callee (assigned, passed, exported).
 */
export function functionUseIn(fileRel: string, source: string, moduleRel: string, fn: string): { calls: number; misuses: string[] } {
    const sf = parse(fileRel, source);
    const where = (n: ts.Node) => `${fileRel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const misuses: string[] = [];
    let bound = false;
    for (const e of moduleEdgesOf(fileRel, source, sf)) {
        if (e.target !== moduleRel || e.typeOnly) continue;
        const n = e.node;
        if (ts.isImportDeclaration(n)) {
            const c = n.importClause!;
            if (c.name) misuses.push(`${where(n)} default-imports the module`);
            if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
                misuses.push(`${where(n)} imports the module as a namespace`);
            } else if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
                for (const s of c.namedBindings.elements) {
                    const imported = (s.propertyName ?? s.name).text;
                    if (imported !== fn || s.isTypeOnly) continue;
                    if (s.propertyName) misuses.push(`${where(s)} imports ${fn} under another name`);
                    else bound = true;
                }
            }
        } else if (ts.isExportDeclaration(n)) {
            if (!n.exportClause || ts.isNamespaceExport(n.exportClause)) {
                misuses.push(`${where(n)} re-exports the whole module`);
            } else {
                for (const s of n.exportClause.elements) {
                    if ((s.propertyName ?? s.name).text === fn && !s.isTypeOnly) misuses.push(`${where(s)} re-exports ${fn}`);
                }
            }
        } else {
            misuses.push(`${where(n)} loads the module by ${e.kind}`);
        }
    }
    let calls = 0;
    const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n.text === fn) {
            const p = n.parent;
            const plainImport = ts.isImportSpecifier(p) && !p.propertyName;
            const exportSpecifierOfModule = ts.isExportSpecifier(p); // reported above if it names the module
            if (ts.isCallExpression(p) && p.expression === n) {
                calls += 1;
            } else if (!plainImport && !(exportSpecifierOfModule && p.parent.parent.moduleSpecifier)) {
                // A property name (`ns.fn`), a value reference or a local `export { fn }`.
                const isPropertyName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
                if (bound || isPropertyName) misuses.push(`${where(n)} references ${fn} other than as a direct call`);
            }
        }
        if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === fn) {
            misuses.push(`${where(n)} reaches ${fn} by element access`);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { calls: bound ? calls : 0, misuses };
}

/** Every file in `population` that calls `fn` from `moduleRel`, and every other way it is reached. */
export function functionUse(moduleRel: string, fn: string, population: readonly string[], read: (rel: string) => string = readRel): FunctionUse {
    const callers: string[] = [];
    const misuses: string[] = [];
    for (const f of population) {
        if (f === moduleRel) continue;
        const src = read(f);
        if (!src.includes(fn) && !src.includes(path.basename(moduleRel).replace(/\.[^.]+$/, ''))) continue;
        const use = functionUseIn(f, src, moduleRel, fn);
        if (use.calls > 0) callers.push(f);
        misuses.push(...use.misuses);
    }
    return { callers: callers.sort(), misuses };
}
