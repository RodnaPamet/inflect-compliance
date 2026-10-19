/**
 * The harness scanner's image ships exactly what the scanner runs (#3686).
 *
 * `packages/agent-harness-scanner/Dockerfile` copies the scanner's source and,
 * file by file, the application modules the scanner imports: the wire contract
 * and what the contract itself imports. `Dockerfile.dockerignore` lets those
 * same files into the build context and nothing else. So the image carries two
 * hand-kept copies of one fact, the scanner's import closure, and each can go
 * wrong in a way nothing else sees in time:
 *
 *   • a contract module gains an import the lists do not name: the image
 *     builds, and fails at its first start in a client's estate (the CI smoke
 *     test sees it too, but only in the job that builds the image);
 *   • a list names more than the closure: the client's image carries
 *     application code the scanner never runs, which is surface, and a
 *     disclosure, for nothing.
 *
 * The closure is computed the way the image runs it: esbuild, the transform
 * tsx runs the scanner with, bundling `src/cli.ts` through the repository's
 * tsconfig with every package left external. A type-only import is erased
 * there as it is under tsx, so it is not in the closure and the image need not
 * carry it.
 *
 * The same file holds the image's packages to its manifest: each one the
 * closure imports, plus tsx to run them, at an exact version its lockfile
 * resolves. And its base to one digest, which is what makes the image a client
 * builds the image CI scanned.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';

import { build } from 'esbuild';

import { REPO_ROOT } from '../../helpers/repo-files';

const PACKAGE = 'packages/agent-harness-scanner';
const ENTRY = `${PACKAGE}/src/cli.ts`;

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The Dockerfile's instructions, comments and continuations folded away. */
function instructions(): string[] {
    return read(`${PACKAGE}/Dockerfile`)
        .replace(/\\\n/g, ' ')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Every path a `COPY` takes from the build context (not from an earlier stage), once each, sorted. */
function copiedFromContext(): string[] {
    const sources = instructions()
        .filter((l) => /^COPY\s/.test(l) && !/\s--from=/.test(l))
        .flatMap((l) => l.split(/\s+/).slice(1, -1));
    return [...new Set(sources)].sort();
}

/** The allowlist `Dockerfile.dockerignore` lets back in, and its first rule. */
function contextRules(): { first: string; allowed: string[] } {
    const rules = read(`${PACKAGE}/Dockerfile.dockerignore`)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    return { first: rules[0], allowed: rules.filter((r) => r.startsWith('!')).map((r) => r.slice(1)) };
}

interface Closure {
    readonly files: readonly string[];
    readonly packages: readonly string[];
}

let closure: Closure;

beforeAll(async () => {
    const result = await build({
        entryPoints: [path.join(REPO_ROOT, ENTRY)],
        absWorkingDir: REPO_ROOT,
        tsconfig: path.join(REPO_ROOT, 'tsconfig.json'),
        bundle: true,
        write: false,
        metafile: true,
        platform: 'node',
        packages: 'external',
        logLevel: 'silent',
    });
    const inputs = result.metafile.inputs;
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const external = new Set<string>();
    for (const input of Object.values(inputs)) {
        for (const imp of input.imports) {
            if (!imp.external || builtins.has(imp.path)) continue;
            // `zod/v4` and `zod` are one package.
            const [scopeOrName, name] = imp.path.split('/');
            external.add(scopeOrName.startsWith('@') ? `${scopeOrName}/${name}` : scopeOrName);
        }
    }
    closure = { files: Object.keys(inputs).sort(), packages: [...external].sort() };
});

const appModules = (): string[] => closure.files.filter((f) => f.startsWith('src/'));

describe('the scanner image ships its import closure, and nothing else of the application', () => {
    it('computes a closure at all', () => {
        // The denominator. An empty bundle would make every equality below hold.
        expect(closure.files).toEqual(expect.arrayContaining([ENTRY, 'src/lib/agentic/harness-contract.ts']));
        expect(appModules().length).toBeGreaterThanOrEqual(5);
    });

    it('reads nothing of its own package outside the source directory the image copies whole', () => {
        const ownOutsideSrc = closure.files.filter((f) => !f.startsWith('src/') && !f.startsWith(`${PACKAGE}/src/`));
        expect(ownOutsideSrc).toEqual([]);
        expect(copiedFromContext()).toEqual(expect.arrayContaining([`${PACKAGE}/src`]));
    });

    it('COPYs every application module the scanner imports, and no other', () => {
        expect(copiedFromContext().filter((p) => p.startsWith('src/'))).toEqual(appModules());
    });

    it('lets exactly what it COPYs into the build context', () => {
        const { first, allowed } = contextRules();
        // An allowlist: everything out, then only the image's own files back in.
        expect(first).toBe('*');
        expect([...allowed].sort()).toEqual(copiedFromContext());
    });

    it('runs the CLI the closure was computed from', () => {
        const entrypoint = instructions().find((l) => l.startsWith('ENTRYPOINT '));
        expect(JSON.parse((entrypoint ?? 'ENTRYPOINT null').slice('ENTRYPOINT '.length))).toEqual([
            'node',
            '--import',
            'tsx',
            `/app/${ENTRY}`,
        ]);
    });
});

describe("the scanner image's packages and base are pinned", () => {
    const manifest = JSON.parse(read(`${PACKAGE}/container/package.json`)) as {
        dependencies: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(read(`${PACKAGE}/container/package-lock.json`)) as {
        packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    it('installs each package the closure imports, plus tsx to run it, and nothing else', () => {
        expect(Object.keys(manifest.dependencies).sort()).toEqual([...closure.packages, 'tsx'].sort());
        expect(manifest.devDependencies).toBeUndefined();
    });

    it('pins each to an exact version, and its lockfile resolves that version', () => {
        for (const [name, version] of Object.entries(manifest.dependencies)) {
            expect(`${name}@${version}`).toMatch(/@\d+\.\d+\.\d+$/);
            expect(`${name}@${lock.packages[`node_modules/${name}`]?.version}`).toBe(`${name}@${version}`);
        }
        // The lockfile was generated from this manifest, not from an older one.
        expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
    });

    it('builds every stage FROM one base, pinned by digest', () => {
        const bases = instructions()
            .filter((l) => /^FROM\s/.test(l))
            .map((l) => l.split(/\s+/)[1]);
        expect(bases.length).toBeGreaterThanOrEqual(2);
        expect(new Set(bases).size).toBe(1);
        expect(bases[0]).toMatch(/^node:\d+-alpine@sha256:[0-9a-f]{64}$/);
    });
});
