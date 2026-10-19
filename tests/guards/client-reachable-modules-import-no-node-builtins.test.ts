/**
 * A module a client component can reach imports no Node built-in.
 *
 * `next build` bundles everything a `'use client'` file statically reaches, and
 * webpack has no handler for the `node:` scheme: one `import { createHash }
 * from 'node:crypto'` anywhere in that graph fails the build with
 * `UnhandledSchemeError`. That is how #3674 deploy 2 first failed CI —
 * `RuleBuilderModal` (client) imports the workflow registry, which imports every
 * workflow definition, and one definition's SYNTHESIS step called a function in
 * a module that hashed with `node:crypto`. Nothing short of the Build job
 * noticed, and the Build job is the last thing to report.
 *
 * Two claims:
 *
 *   1. From EVERY `'use client'` file, no Node built-in is reachable, bare
 *      (`crypto`, `fs`, `path`, …) or `node:`. A `node:` specifier breaks the
 *      build. A bare `crypto` compiles, but only because Next substitutes
 *      `crypto-browserify`, which ships a polyfill for a hash no page takes in
 *      the browser (#3726 removed the last four: `proposal-diff.ts`,
 *      `harness-contract.ts`, `receipt-verification.ts`, `audit-redact.ts`).
 *      It holds for the whole tree, with no allowlist. A server-side need in a
 *      client-reachable module (a hash, a signature check, a file read) belongs
 *      in a server-only module, with the pure part the client needs in a leaf,
 *      as `agent-recertification-hash.ts`, `proposal-diff-status.ts` and
 *      `harness-contract-rules.ts` do.
 *   2. From the WORKFLOW REGISTRY, no Node built-in is reachable at all. Claim 1
 *      covers it while a client imports the registry, and this claim is the
 *      registry's own: it is the seam that makes every workflow step
 *      client-reachable, so it must hold even if the import that makes it so
 *      moves.
 *
 * WHY A GRAPH WALK, NOT AN ESLINT RULE. "Reachable from" is a property of the
 * import graph, not of any one file — the offending line in #3674 sat three
 * hops from the client file, in a module with no directive of its own. A
 * per-file rule would have to ban `node:` from every module a client might one
 * day import, which is most of `src/lib`.
 *
 * WHAT COUNTS AS AN EDGE. Value imports, re-exports, `import()` and
 * `require()` with a literal specifier — every one of them bundles the target.
 * `import type` and all-`type` specifier lists are erased at compile time and
 * are not edges. `@/` and `@inflect/ui/` resolve to source; any other bare
 * specifier is a package and is not walked (its built-ins are its bundler
 * configuration's business, not this repo's source).
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';

import * as ts from 'typescript';

import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';

const REGISTRY = path.join(REPO_ROOT, 'src/lib/agentic/workflow-registry.ts');

const BUILTINS: ReadonlySet<string> = new Set(builtinModules.filter((m) => !m.startsWith('_')));

/** A `node:` specifier, or a bare name Node ships (`crypto`, `fs/promises`). */
function isNodeBuiltin(spec: string): boolean {
    return spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** The source file a specifier names, or null for a package (not walked). */
function resolveSpecifier(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(REPO_ROOT, 'src', spec.slice(2));
    else if (spec.startsWith('@inflect/ui/')) base = path.join(REPO_ROOT, 'packages/ui/src', spec.slice('@inflect/ui/'.length));
    else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
    else return null;
    const candidates = [
        base,
        ...EXTENSIONS.map((e) => base + e),
        ...EXTENSIONS.map((e) => path.join(base, `index${e}`)),
    ];
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Every specifier a module bundles: value imports, re-exports, import(), require(). */
function bundledSpecifiers(source: string, fileName = 'x.ts'): string[] {
    const sf = ts.createSourceFile(
        fileName, source, ts.ScriptTarget.Latest, true,
        fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            const clause = n.importClause;
            const typeOnly = !!clause && (clause.isTypeOnly || (
                !clause.name
                && !!clause.namedBindings
                && ts.isNamedImports(clause.namedBindings)
                && clause.namedBindings.elements.length > 0
                && clause.namedBindings.elements.every((e) => e.isTypeOnly)
            ));
            if (!typeOnly) out.push(n.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
            const typeOnly = n.isTypeOnly || (
                !!n.exportClause
                && ts.isNamedExports(n.exportClause)
                && n.exportClause.elements.length > 0
                && n.exportClause.elements.every((e) => e.isTypeOnly)
            );
            if (!typeOnly) out.push(n.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(n)
            && n.arguments.length === 1
            && ts.isStringLiteralLike(n.arguments[0])
            && (n.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
        ) {
            out.push(n.arguments[0].text);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

const specifierCache = new Map<string, string[]>();
function specifiersOf(file: string): string[] {
    let s = specifierCache.get(file);
    if (!s) {
        s = bundledSpecifiers(fs.readFileSync(file, 'utf8'), file);
        specifierCache.set(file, s);
    }
    return s;
}

interface Reach {
    /** Every source module reached, mapped to the module that first reached it. */
    readonly reached: ReadonlyMap<string, string | null>;
    /** Every built-in specifier reached: `<module> imports <spec>`, with the path from a root. */
    readonly builtins: ReadonlyArray<{ readonly module: string; readonly spec: string; readonly via: string }>;
}

/** Breadth-first over the bundled-import graph from `roots`. */
function walk(roots: readonly string[]): Reach {
    const reached = new Map<string, string | null>();
    const queue: string[] = [];
    for (const r of roots) {
        if (!reached.has(r)) {
            reached.set(r, null);
            queue.push(r);
        }
    }
    const found: Array<{ module: string; spec: string }> = [];
    for (let i = 0; i < queue.length; i++) {
        const file = queue[i];
        for (const spec of specifiersOf(file)) {
            if (isNodeBuiltin(spec)) {
                found.push({ module: file, spec });
                continue;
            }
            const target = resolveSpecifier(spec, file);
            if (target && !reached.has(target)) {
                reached.set(target, file);
                queue.push(target);
            }
        }
    }
    const via = (file: string): string => {
        const chain: string[] = [];
        for (let f: string | null | undefined = file; f; f = reached.get(f)) chain.unshift(repoRelative(f));
        return chain.join(' → ');
    };
    return {
        reached,
        builtins: found.map((b) => ({ module: repoRelative(b.module), spec: b.spec, via: via(b.module) })),
    };
}

/** The directive must be the first statement; comments may precede it. */
function isClientModule(source: string): boolean {
    const head = source
        .replace(/^﻿/, '')
        .replace(/^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*/, '');
    return /^['"]use client['"]/.test(head.trimStart());
}

const clientFiles = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
    .filter((f) => isClientModule(fs.readFileSync(f, 'utf8')));

describe('a module a client component can reach imports no Node built-in', () => {
    it('no Node built-in, bare or `node:`, is reachable from any `use client` file', () => {
        const { builtins } = walk(clientFiles);
        const offenders = builtins.map((b) => `${b.module} imports ${b.spec}, reached ${b.via}`).sort();
        expect({
            offenders,
            hint: offenders.length === 0
                ? 'none'
                : 'A node: import fails next build in a client graph (UnhandledSchemeError), and a bare one '
                  + 'ships a browser polyfill. Move the server-side need into a module only the server '
                  + 'imports, and give the client a leaf with only the pure part it uses.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('no Node built-in at all is reachable from the workflow registry', () => {
        const { builtins } = walk([REGISTRY]);
        const offenders = builtins.map((b) => `${b.module} imports ${b.spec}, reached ${b.via}`).sort();
        expect({
            offenders,
            hint: offenders.length === 0
                ? 'none'
                : 'The registry imports every workflow definition and a client component imports the '
                  + 'registry, so every step function is in the browser bundle. A bare built-in compiles '
                  + 'only through a browser polyfill. Compute it in the usecase, from a server-only module.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('the walk is not vacuous: it finds the client files, and the registry reaches every workflow step', () => {
        // Guards the guard. A resolver that resolved nothing, or a directive
        // test that matched nothing, would report "no offenders" over an empty
        // graph — full coverage of nothing.
        expect(clientFiles.length).toBeGreaterThan(100);
        const fromClients = walk(clientFiles).reached;
        expect(fromClients.has(REGISTRY)).toBe(true);
        const fromRegistry = [...walk([REGISTRY]).reached.keys()].map(repoRelative);
        expect(fromRegistry).toEqual(expect.arrayContaining([
            'src/lib/agentic/workflows/agent-recertification-pack.ts',
            'src/lib/agentic/agent-recertification.ts',
        ]));
        // …and the server-only half is NOT in it.
        expect(fromRegistry).not.toContain('src/lib/agentic/agent-recertification-hash.ts');
        // The #3726 splits: the clients reach the pure leaves, never the
        // modules that hash or verify.
        const fromClientFiles = [...fromClients.keys()].map(repoRelative);
        expect(fromClientFiles).toEqual(expect.arrayContaining([
            'src/lib/agentic/proposal-diff-status.ts',
            'src/lib/agentic/harness-contract-rules.ts',
            'src/lib/agentic/harness-findings.ts',
        ]));
        for (const serverOnly of [
            'src/lib/agentic/proposal-diff.ts',
            'src/lib/agentic/harness-contract.ts',
            'src/lib/mcp/receipt-verification.ts',
            'src/lib/audit-redact.ts',
        ]) {
            expect(fromClientFiles).not.toContain(serverOnly);
        }
    });

    it('the detector sees every bundling edge and ignores type-only ones', () => {
        expect(bundledSpecifiers("import { createHash } from 'node:crypto';")).toEqual(['node:crypto']);
        expect(bundledSpecifiers("import * as c from 'crypto';")).toEqual(['crypto']);
        expect(bundledSpecifiers("import 'node:fs';")).toEqual(['node:fs']);
        expect(bundledSpecifiers("export { x } from './x';")).toEqual(['./x']);
        expect(bundledSpecifiers("export * from '@/lib/x';")).toEqual(['@/lib/x']);
        expect(bundledSpecifiers("const m = await import('node:path');")).toEqual(['node:path']);
        expect(bundledSpecifiers("const m = require('fs');")).toEqual(['fs']);
        // Mixed: one value specifier is an edge.
        expect(bundledSpecifiers("import { type A, b } from './y';")).toEqual(['./y']);
        // Erased at compile time — not edges.
        expect(bundledSpecifiers("import type { Hash } from 'node:crypto';")).toEqual([]);
        expect(bundledSpecifiers("import { type Hash } from 'node:crypto';")).toEqual([]);
        expect(bundledSpecifiers("export type { X } from './x';")).toEqual([]);
        expect(isNodeBuiltin('node:crypto')).toBe(true);
        expect(isNodeBuiltin('crypto')).toBe(true);
        expect(isNodeBuiltin('fs/promises')).toBe(true);
        expect(isNodeBuiltin('zod')).toBe(false);
        expect(isNodeBuiltin('@/lib/crypto')).toBe(false);
    });
});
