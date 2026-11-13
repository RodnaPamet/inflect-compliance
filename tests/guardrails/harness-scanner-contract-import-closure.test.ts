/**
 * The harness contract is the scanent package's, and the eight application
 * modules that name it are re-exports of it and nothing else.
 *
 * The contract the reference scanner signs against and the ingest verifies
 * with (the report schema, the ladder, the findings planner, canonical JSON,
 * receipt verification, redaction and the CIDR helper) lives in
 * `@rodnapamet/scanent-contract` (scanent #26). The application keeps eight
 * files at the paths the contract used to occupy, `CONTRACT_FILES` below, so
 * its ~100 importers keep their `@/` paths; each re-exports its package
 * module. The scanner package (`packages/agent-harness-scanner`, a client's
 * estate) imports the package directly.
 *
 * TYPE-ONLY IMPORTS COUNT. `import type` is erased at run time, so a bundler
 * never notices one, but a type-check resolves it and then everything THAT
 * file imports. The contract once took two types from the read model, which
 * takes a type from the IAM skill outputs, and so on into the application.
 *
 * Three claims:
 *
 *   1. Each of the eight is a re-export of the package module of its own name:
 *      its only import is `@rodnapamet/scanent-contract/<module>`. Code put
 *      back beside the re-export would be a second copy of the contract that
 *      the package's releases never reach.
 *   2. The transitive import closure of the eight, over every kind of import
 *      (value, type, re-export, `import()`, `require()`, a triple-slash
 *      reference), contains no other file of this repository. Packages and
 *      Node built-ins are not repository files and are not walked. A specifier
 *      that looks like a repository path and resolves to nothing fails too.
 *   3. The scanner package imports no file of this repository outside itself:
 *      the contract reaches it from the package, which is what its image
 *      installs. An application import there would be a file the image does
 *      not carry.
 *
 * The edges come from the TypeScript compiler (`ts.preProcessFile`) and the
 * targets from its module resolution under this repository's `tsconfig.json`,
 * so the guard reads imports the way `tsc` does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { REPO_ROOT, repoRelative, repoRelativeFiles } from '../helpers/repo-files';

/** The application's re-exports of the contract package. */
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

const CONTRACT_PACKAGE = '@rodnapamet/scanent-contract';

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

    it('re-exports, in each of the eight, the package module of the same name and nothing else', () => {
        const notReexports: string[] = [];
        for (const file of CONTRACT_FILES) {
            const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
            const info = ts.preProcessFile(source, true, true);
            const specs = info.importedFiles.map((f) => f.fileName);
            const expected = `${CONTRACT_PACKAGE}/${path.basename(file, '.ts')}`;
            // The package resolves, under this repository's tsconfig, to its
            // installed declarations: an unresolvable subpath is not a re-export.
            const resolved = ts.resolveModuleName(expected, path.join(REPO_ROOT, file), COMPILER_OPTIONS, ts.sys)
                .resolvedModule?.resolvedFileName ?? null;
            const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
            const statements = sf.statements.map((st) => st.getText(sf));
            if (
                specs.length !== 1
                || specs[0] !== expected
                || resolved === null
                || statements.length !== 1
                || statements[0] !== `export * from '${expected}';`
            ) {
                notReexports.push(`${file}: ${statements.length} statement(s), imports ${JSON.stringify(specs)}`);
            }
        }
        expect(notReexports).toEqual([]);
    });

    it('is not imported by the scanner package, which imports no repository file outside itself', () => {
        const scannerFiles = repoRelativeFiles().filter(
            (f) => f.startsWith(SCANNER_PACKAGE) && /\.tsx?$/.test(f),
        );
        expect(scannerFiles.length).toBeGreaterThan(0);

        const outside: string[] = [];
        const unresolved: string[] = [];
        let packageImports = 0;
        for (const file of scannerFiles) {
            const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
            packageImports += ts.preProcessFile(source, true, true).importedFiles
                .filter((f) => f.fileName.startsWith(`${CONTRACT_PACKAGE}/`)).length;
            for (const edge of repoEdgesOf(file)) {
                if (edge.to === null) {
                    unresolved.push(`${edge.from} imports '${edge.spec}', which resolves to no file`);
                } else if (!edge.to.startsWith(SCANNER_PACKAGE)) {
                    outside.push(`${edge.from} imports '${edge.spec}' (${edge.to})`);
                }
            }
        }
        expect(unresolved).toEqual([]);
        expect(outside).toEqual([]);
        // The denominator: the scanner does take the contract, from the package.
        expect(packageImports).toBeGreaterThan(0);
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
