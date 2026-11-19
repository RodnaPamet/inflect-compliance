/**
 * `@inflect/ui` declares every package its sources import, at the root's
 * version, and stays strict about index reads.
 *
 * The package is consumed in two ways: here, as an npm workspace whose imports
 * resolve through the root's `node_modules`, and by a product that mirrors it
 * byte for byte. The first works whether or not the package declares anything,
 * because the root declares it all, so a missing entry was invisible here: the
 * manifest said `clsx` and `tailwind-merge` while the sources imported about
 * twenty more packages, and the mirroring product had to declare them itself.
 *
 * What this holds, each against the sources rather than a list:
 *
 *   1. Every bare import under `packages/ui/src` names a package the manifest
 *      declares — `dependencies` or `peerDependencies`, or `devDependencies`
 *      for a test file.
 *   2. Every `dependencies` / `devDependencies` entry is imported, or is the
 *      `@types/` package of one that is. A stale entry is how a manifest
 *      drifts into describing code that has gone.
 *   3. Every one of those entries carries the ROOT's specifier, character for
 *      character. A different range can resolve to a second copy beside the
 *      root's, which for React-adjacent packages is a runtime fault.
 *   4. The lockfile holds no `packages/ui/node_modules/…` entry: one copy of
 *      each package, the root's.
 *   5. `packages/ui/tsconfig.json` keeps `noUncheckedIndexedAccess` on. CI's
 *      `typecheck:ui-boundary` compiles through that file, so the flag is what
 *      makes an unchecked index read fail there; deleting it would pass every
 *      compile and remove the check.
 *
 * Peers are exempt from (2) and (3): `react-dom` is a peer because `next`
 * needs it, not because a file imports it, and a peer's range is the
 * consumer's floor, not the root's pin.
 *
 * Imports are read with the TypeScript parser, not a regex, so a multi-line
 * import, an `export … from`, a dynamic `import()` and an `import('x').T` type
 * all count, and a specifier in a comment does not.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import * as ts from 'typescript';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const PKG_DIR = 'packages/ui';
const SELF = '@inflect/ui';

type Manifest = {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
};

type SourceFile = { path: string; text: string };

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** True for a specifier that names an installed package, not a file or a builtin. */
function isBarePackage(specifier: string): boolean {
    if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
    if (specifier.startsWith('node:')) return false;
    return !builtinModules.includes(packageOf(specifier));
}

/** Every module specifier a file names, read from its syntax tree. */
function specifiersOf(file: SourceFile): string[] {
    const sf = ts.createSourceFile(
        file.path,
        file.text,
        ts.ScriptTarget.Latest,
        true,
        file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            out.push(node.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
            const [arg] = node.arguments;
            if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            out.push(node.argument.literal.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

const isTestFile = (p: string): boolean => /\/__tests__\/|\.test\.tsx?$/.test(p);

/** `@types/scope__name` -> `@scope/name`, `@types/name` -> `name`. */
function typedPackage(typesName: string): string {
    const bare = typesName.slice('@types/'.length);
    return bare.includes('__') ? `@${bare.replace('__', '/')}` : bare;
}

/** Every way the manifest disagrees with the sources and the root. */
function manifestProblems(
    files: readonly SourceFile[],
    manifest: Manifest,
    root: Manifest,
): string[] {
    const deps = manifest.dependencies ?? {};
    const dev = manifest.devDependencies ?? {};
    const peers = manifest.peerDependencies ?? {};
    const problems: string[] = [];
    const imported = new Set<string>();

    for (const file of files) {
        for (const spec of specifiersOf(file)) {
            if (!isBarePackage(spec)) continue;
            const pkg = packageOf(spec);
            if (pkg === (manifest.name ?? SELF)) continue;
            imported.add(pkg);
            const declared =
                pkg in deps || pkg in peers || (isTestFile(file.path) && pkg in dev);
            if (!declared) {
                problems.push(
                    `${file.path} imports '${spec}', but ${PKG_DIR}/package.json does not declare '${pkg}'` +
                        (isTestFile(file.path) ? '' : ' in dependencies or peerDependencies'),
                );
            }
        }
    }

    const rootSpec = (name: string): string | undefined =>
        root.dependencies?.[name] ?? root.devDependencies?.[name];

    for (const [section, entries] of [
        ['dependencies', deps],
        ['devDependencies', dev],
    ] as const) {
        for (const [name, range] of Object.entries(entries)) {
            const covers = name.startsWith('@types/') ? typedPackage(name) : name;
            if (!imported.has(covers)) {
                problems.push(`${section}.${name} is declared but no file under ${PKG_DIR}/src imports '${covers}'`);
            }
            const want = rootSpec(name);
            if (want === undefined) {
                problems.push(`${section}.${name} is not declared by the root package.json, so nothing pins its version`);
            } else if (range !== want) {
                problems.push(`${section}.${name} is '${range}', the root declares '${want}'`);
            }
        }
    }
    return problems.sort();
}

function readJson<T>(rel: string): T {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as T;
}

describe('@inflect/ui declares what it imports', () => {
    const files: SourceFile[] = repoRelativeFiles()
        .filter((p) => p.startsWith(`${PKG_DIR}/src/`) && /\.tsx?$/.test(p))
        .map((p) => ({ path: p, text: fs.readFileSync(path.join(REPO_ROOT, p), 'utf8') }));

    it('reads a real population', () => {
        // Every assertion below passes on an empty list.
        expect(files.length).toBeGreaterThan(100);
        const imported = new Set(files.flatMap(specifiersOf).filter(isBarePackage).map(packageOf));
        expect(imported.has('react')).toBe(true);
    });

    it('the manifest matches the sources and the root', () => {
        const problems = manifestProblems(
            files,
            readJson<Manifest>(`${PKG_DIR}/package.json`),
            readJson<Manifest>('package.json'),
        );
        expect(problems).toEqual([]);
    });

    it('the lockfile installs one copy of each package, the root\'s', () => {
        const lock = readJson<{ packages: Record<string, unknown> }>('package-lock.json');
        const nested = Object.keys(lock.packages).filter((k) =>
            k.startsWith(`${PKG_DIR}/node_modules/`),
        );
        expect(nested).toEqual([]);
        // And the lockfile knows the workspace at all, or the check above
        // would pass on a lockfile that never saw it.
        expect(lock.packages[PKG_DIR]).toBeDefined();
    });

    it('the package tsconfig keeps noUncheckedIndexedAccess on', () => {
        const rel = `${PKG_DIR}/tsconfig.json`;
        const read = ts.readConfigFile(path.join(REPO_ROOT, rel), ts.sys.readFile);
        expect(read.error).toBeUndefined();
        const config = read.config as { compilerOptions?: Record<string, unknown> };
        expect(config.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
    });

    describe('the check can fire', () => {
        // Without these, a `manifestProblems` that returns [] for everything
        // passes the real case above.
        const root: Manifest = {
            dependencies: { clsx: '^2.1.0', motion: '^13.5.1', 'd3-array': '^3.2.5' },
            devDependencies: { '@types/d3-array': '^3.2.2', '@testing-library/react': '^16.3.3' },
        };
        const src = (p: string, text: string): SourceFile => ({ path: `${PKG_DIR}/src/${p}`, text });

        it('passes a manifest that matches', () => {
            expect(
                manifestProblems(
                    [
                        src('a.ts', "import { clsx } from 'clsx';\nimport type { X } from '@inflect/ui/lib/cn';"),
                        src('b.ts', "export { max } from 'd3-array/src/max';\nimport * as fs from 'node:fs';"),
                        src('x/__tests__/c.test.tsx', "import { render } from '@testing-library/react';"),
                    ],
                    {
                        name: SELF,
                        dependencies: { clsx: '^2.1.0', 'd3-array': '^3.2.5' },
                        devDependencies: { '@types/d3-array': '^3.2.2', '@testing-library/react': '^16.3.3' },
                        peerDependencies: { 'react-dom': '>=19' },
                    },
                    root,
                ),
            ).toEqual([]);
        });

        it('reports an undeclared import, in every syntactic form', () => {
            const forms = [
                "import {\n  motion,\n} from 'motion/react';",
                "export * from 'motion';",
                "const m = await import('motion');",
                "type M = import('motion').MotionProps;",
            ];
            for (const text of forms) {
                expect(manifestProblems([src('a.tsx', text)], { name: SELF }, root)).toEqual([
                    expect.stringContaining("does not declare 'motion'"),
                ]);
            }
        });

        it('ignores a specifier in a comment', () => {
            expect(manifestProblems([src('a.ts', "// import x from 'motion';\nexport {};")], { name: SELF }, root)).toEqual([]);
        });

        it('does not let a source file lean on a devDependency', () => {
            expect(
                manifestProblems(
                    [src('a.ts', "import { render } from '@testing-library/react';")],
                    { name: SELF, devDependencies: { '@testing-library/react': '^16.3.3' } },
                    root,
                ),
            ).toEqual([expect.stringContaining('in dependencies or peerDependencies')]);
        });

        it('reports a stale entry, a range that differs from the root, and an unpinned one', () => {
            expect(
                manifestProblems(
                    [src('a.ts', "import { clsx } from 'clsx';\nimport { z } from 'zod';")],
                    {
                        name: SELF,
                        dependencies: { clsx: '2.1.1', motion: '^13.5.1', zod: '^4.0.0' },
                    },
                    root,
                ),
            ).toEqual([
                "dependencies.clsx is '2.1.1', the root declares '^2.1.0'",
                `dependencies.motion is declared but no file under ${PKG_DIR}/src imports 'motion'`,
                'dependencies.zod is not declared by the root package.json, so nothing pins its version',
            ]);
        });
    });
});
