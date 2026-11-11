/**
 * The harness scanner's contract is a closed set of eight files.
 *
 * The reference scanner (`packages/agent-harness-scanner`) runs in a client's
 * estate, and what it shares with the product is the contract it signs
 * against: the report schema, the ladder, the findings planner, canonical
 * JSON, receipt verification, redaction and the CIDR helper. Those are
 * `CONTRACT_FILES` below. They are what a build of the scanner outside this
 * repository has to carry, so the set has to be closed under import: a ninth
 * file reached from any of them is a file that build does not have.
 *
 * TYPE-ONLY IMPORTS COUNT. `import type` is erased at run time, so a bundler
 * never notices one, but a type-check resolves it and then everything THAT
 * file imports. The contract once took two types from the read model, which
 * takes a type from the IAM skill outputs, and so on into the application:
 * nothing failed here, and the contract could not be type-checked on its own.
 *
 * Two claims:
 *
 *   1. The transitive import closure of the eight files, over every kind of
 *      import (value, type, re-export, `import()`, `require()`, a
 *      triple-slash reference), contains no other file of this repository.
 *      Packages and Node built-ins are not repository files and are not
 *      walked. A specifier that looks like a repository path and resolves to
 *      nothing fails too: an edge that cannot be followed is not a clean one.
 *   2. Every file of the scanner package that imports from outside the
 *      package imports one of the eight. This is what makes the eight the
 *      scanner's whole run-time closure, and not merely a closed set.
 *
 * The edges come from the TypeScript compiler (`ts.preProcessFile`) and the
 * targets from its module resolution under this repository's `tsconfig.json`,
 * so the guard reads imports the way `tsc` does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { REPO_ROOT, repoRelative, repoRelativeFiles } from '../helpers/repo-files';

/** The contract: the only files outside its package the scanner may reach. */
const CONTRACT_FILES: readonly string[] = [
    'src/lib/agentic/harness-contract.ts',
    'src/lib/agentic/harness-contract-rules.ts',
    'src/lib/agentic/harness-findings.ts',
    'src/lib/agentic/harness-ladder.ts',
    'src/lib/canonical-json.ts',
    'src/lib/mcp/receipt-verification.ts',
    'src/lib/audit-redact.ts',
    'src/lib/security/cidr.ts',
];

const SCANNER_PACKAGE = 'packages/agent-harness-scanner/';

const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
    const configPath = path.join(REPO_ROOT, 'tsconfig.json');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) throw new Error(`cannot read ${configPath}`);
    const converted = ts.convertCompilerOptionsFromJson(read.config.compilerOptions, REPO_ROOT, configPath);
    if (converted.errors.length > 0) throw new Error(`cannot parse compilerOptions of ${configPath}`);
    return converted.options;
})();

/** A specifier that names a file of this repository, not a package. */
function looksLikeRepoPath(spec: string): boolean {
    return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('@inflect/ui/');
}

interface Edge {
    /** Repo-relative path of the importing file. */
    readonly from: string;
    readonly spec: string;
    /** Repo-relative path of the imported repository file; `null` when unresolved. */
    readonly to: string | null;
}

/** Every import of `relFile` that names, or resolves to, a file of this repository. */
function repoEdgesOf(relFile: string, sourceOverride?: string): Edge[] {
    const abs = path.join(REPO_ROOT, relFile);
    const source = sourceOverride ?? fs.readFileSync(abs, 'utf8');
    const info = ts.preProcessFile(source, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
    const edges: Edge[] = [];
    for (const { fileName: spec } of info.importedFiles) {
        const resolved = ts.resolveModuleName(spec, abs, COMPILER_OPTIONS, ts.sys).resolvedModule;
        if (!resolved) {
            if (looksLikeRepoPath(spec)) edges.push({ from: relFile, spec, to: null });
            continue;
        }
        const target = path.resolve(resolved.resolvedFileName);
        const inRepo = target.startsWith(REPO_ROOT + path.sep) && !target.includes(`${path.sep}node_modules${path.sep}`);
        if (inRepo) edges.push({ from: relFile, spec, to: repoRelative(target) });
    }
    for (const { fileName: ref } of info.referencedFiles) {
        const target = path.resolve(path.dirname(abs), ref);
        edges.push({ from: relFile, spec: ref, to: fs.existsSync(target) ? repoRelative(target) : null });
    }
    return edges;
}

interface Closure {
    /** Every repository file reached, mapped to the edge that first reached it (`null` for a root). */
    readonly reached: ReadonlyMap<string, Edge | null>;
    readonly unresolved: readonly Edge[];
}

function closureOf(roots: readonly string[], edgesOf: (relFile: string) => Edge[] = repoEdgesOf): Closure {
    const reached = new Map<string, Edge | null>(roots.map((r) => [r, null]));
    const unresolved: Edge[] = [];
    const queue = [...roots];
    while (queue.length > 0) {
        const file = queue.shift() as string;
        for (const edge of edgesOf(file)) {
            if (edge.to === null) {
                unresolved.push(edge);
            } else if (!reached.has(edge.to)) {
                reached.set(edge.to, edge);
                queue.push(edge.to);
            }
        }
    }
    return { reached, unresolved };
}

/** `root -> … -> file`, each hop with the specifier that made it. */
function pathTo(file: string, reached: ReadonlyMap<string, Edge | null>): string {
    const hops: string[] = [];
    let edge = reached.get(file) ?? null;
    while (edge) {
        hops.unshift(`${edge.from} imports '${edge.spec}'`);
        edge = reached.get(edge.from) ?? null;
    }
    return hops.join(' -> ');
}

function strangersIn(closure: Closure): string[] {
    const contract = new Set(CONTRACT_FILES);
    return [...closure.reached.keys()]
        .filter((f) => !contract.has(f))
        .sort()
        .map((f) => `${f}  (${pathTo(f, closure.reached)})`);
}

describe('the harness scanner contract is closed under import', () => {
    it('names eight files that exist', () => {
        const tracked = new Set(repoRelativeFiles());
        expect(CONTRACT_FILES.filter((f) => !tracked.has(f))).toEqual([]);
        expect(new Set(CONTRACT_FILES).size).toBe(8);
    });

    it('reaches no ninth repository file, type-only imports included', () => {
        const closure = closureOf(CONTRACT_FILES);
        expect(closure.unresolved.map((e) => `${e.from} imports '${e.spec}', which resolves to no file`)).toEqual([]);
        expect(strangersIn(closure)).toEqual([]);
    });

    it('is what the scanner package imports from outside itself, and nothing else', () => {
        const scannerFiles = repoRelativeFiles().filter(
            (f) => f.startsWith(`${SCANNER_PACKAGE}src/`) && /\.tsx?$/.test(f),
        );
        expect(scannerFiles.length).toBeGreaterThan(0);

        const contract = new Set(CONTRACT_FILES);
        const outside: string[] = [];
        const unresolved: string[] = [];
        const used = new Set<string>();
        for (const file of scannerFiles) {
            for (const edge of repoEdgesOf(file)) {
                if (edge.to === null) {
                    unresolved.push(`${edge.from} imports '${edge.spec}', which resolves to no file`);
                } else if (edge.to.startsWith(SCANNER_PACKAGE)) {
                    continue;
                } else if (contract.has(edge.to)) {
                    used.add(edge.to);
                } else {
                    outside.push(`${edge.from} imports '${edge.spec}' (${edge.to})`);
                }
            }
        }
        expect(unresolved).toEqual([]);
        expect(outside).toEqual([]);
        // The other direction: a contract file nothing reaches is not part of
        // the scanner's closure, and the list above would be claiming too much.
        const reachedFromScanner = closureOf([...used]).reached;
        expect(CONTRACT_FILES.filter((f) => !reachedFromScanner.has(f))).toEqual([]);
    });

    // The detector, shown to detect. Each case hands the walk one contract
    // file with one import added and asks that the import is reported.
    describe('a planted import is found', () => {
        const victim = 'src/lib/canonical-json.ts';
        const plant = (line: string) =>
            closureOf(CONTRACT_FILES, (file) =>
                file === victim
                    ? repoEdgesOf(file, `${line}\n${fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')}`)
                    : repoEdgesOf(file),
            );

        it.each([
            ['a type-only import', `import type { HarnessScanRow } from '@/lib/agentic/harness-read-model';`],
            ['a value import', `import { rungOf } from './agentic/harness-read-model';`],
            ['a type re-export', `export type { HarnessScanRow } from './agentic/harness-read-model';`],
            ['an import type query', `type T = typeof import('./agentic/harness-read-model');`],
        ])('%s', (_name, line) => {
            const strangers = strangersIn(plant(line));
            expect(strangers.length).toBeGreaterThan(0);
            expect(strangers.some((s) => s.startsWith('src/lib/agentic/harness-read-model.ts  '))).toBe(true);
        });

        it('a repository path that resolves to nothing', () => {
            const closure = plant(`import type { Nothing } from '@/lib/agentic/no-such-module';`);
            expect(closure.unresolved.map((e) => e.spec)).toEqual(['@/lib/agentic/no-such-module']);
        });
    });
});
