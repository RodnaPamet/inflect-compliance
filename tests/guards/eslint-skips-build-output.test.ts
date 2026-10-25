/**
 * ESLint does not lint the bundles `scripts/build-worker.mjs` writes.
 *
 * The bundles are gitignored, so CI's Lint job never has them on disk and
 * cannot notice when they are linted. Anyone who has run `npm run build:worker`
 * locally does: esbuild inlines `src/` into each bundle, and `npx eslint .`
 * then reported 41 `local/require-mcp-tool-authorization` errors against a copy
 * of the tool registry. A red local lint that CI disagrees with teaches people
 * to stop reading local lint.
 *
 * The question is put to ESLint itself (`isPathIgnored`), in a child process
 * because ESLint loads `eslint.config.mjs` with a native dynamic import that
 * Jest's module system does not provide. The population is every `outfile:` the
 * build script declares, so a new bundle written outside an ignored directory
 * fails here rather than in somebody's terminal.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const BUILD_SCRIPT = path.join(ROOT, 'scripts/build-worker.mjs');

/** A tracked source file ESLint must still lint: the positive control. */
const SOURCE_FILE = 'src/env.ts';

function outfiles(): string[] {
    const script = fs.readFileSync(BUILD_SCRIPT, 'utf8');
    return [...script.matchAll(/^\s*outfile:\s*'([^']+)'/gm)].map((m) => m[1]);
}

/** Ask ESLint, as `npx eslint .` from the repo root would, which paths it skips. */
function ignoredByEslint(files: readonly string[]): Record<string, boolean> {
    const program = `
        const { ESLint } = require('eslint');
        const files = JSON.parse(process.argv[1]);
        const eslint = new ESLint({ cwd: process.cwd() });
        Promise.all(files.map((f) => eslint.isPathIgnored(f)))
            .then((v) => process.stdout.write(JSON.stringify(Object.fromEntries(files.map((f, i) => [f, v[i]])))));
    `;
    const out = execFileSync(process.execPath, ['-e', program, JSON.stringify(files)], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    return JSON.parse(out) as Record<string, boolean>;
}

describe('ESLint skips the worker build output', () => {
    const bundles = outfiles();
    let ignored: Record<string, boolean>;

    beforeAll(() => {
        ignored = ignoredByEslint([...bundles, SOURCE_FILE]);
    }, 60_000);

    it('reads the bundles from the build script (positive control)', () => {
        // Without this, a renamed build script or a changed `outfile` spelling
        // would leave the assertion below checking an empty list.
        expect(bundles.length).toBeGreaterThan(0);
        expect(bundles).toContain('dist/worker.mjs');
    });

    it('still lints source (positive control)', () => {
        // An ignore broad enough to swallow `src/` would satisfy the
        // assertion below while switching lint off.
        expect(ignored[SOURCE_FILE]).toBe(false);
    });

    it('ignores every bundle the build script writes', () => {
        expect(bundles.filter((file) => !ignored[file])).toEqual([]);
    });
});
