/**
 * A floating promise in server code fails lint (#4579).
 *
 * A promise nobody awaits rejects into nothing: no error reaches the caller,
 * the job or the request, and nothing is logged. Until #4579 the rule that
 * reports one, `@typescript-eslint/no-floating-promises`, ran nowhere. It is
 * now an error in `src/app-layer/**` and `src/lib/**`, where such a rejection
 * is both invisible and consequential.
 *
 * This asks ESLint itself which config applies to a file there
 * (`calculateConfigForFile`, every block merged, as `npx eslint .` resolves
 * it), so a later block that turns the rule off or narrows its `files` fails
 * here. It also asks that those files get a TypeScript program: the rule is
 * type-aware, and without one ESLint stops with a plugin error rather than
 * reporting anything.
 *
 * Whether the rule actually FIRES is proven in the Lint job on every run, not
 * here: the two intentional sites (`src/lib/hooks/use-api.ts`,
 * `src/lib/storage/s3-provider.ts`) carry an inline disable, and
 * `reportUnusedDisableDirectives: 'error'` fails lint on a disable that
 * suppresses nothing. A planted file would need a full type-checked program in
 * this suite to show the same thing.
 *
 * ESLint runs in a child process because it loads `eslint.config.mjs` with a
 * native dynamic import that Jest's module system does not provide.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const RULE = '@typescript-eslint/no-floating-promises';

/** Real files and planted paths, one of each kind per directory the rule covers. */
const SERVER_FILES = [
    'src/app-layer/usecases/custom-roles.ts',
    'src/app-layer/jobs/retention-notifications.ts',
    'src/app-layer/jobs/planted/deeply/nested-job.ts',
    'src/lib/storage/s3-provider.ts',
    'src/lib/hooks/use-api.ts',
    'src/lib/planted/deeply/nested-module.ts',
    'src/lib/planted/component-in-lib.tsx',
];

type Resolved = { severity: unknown; projectService: unknown };

function resolveConfigs(files: readonly string[]): Record<string, Resolved> {
    const program = `
        const { ESLint } = require('eslint');
        const files = JSON.parse(process.argv[1]);
        const eslint = new ESLint({ cwd: process.cwd() });
        Promise.all(files.map((f) => eslint.calculateConfigForFile(f))).then((configs) => {
            const out = {};
            files.forEach((f, i) => {
                const c = configs[i] || {};
                const rule = (c.rules || {})[${JSON.stringify(RULE)}];
                out[f] = {
                    severity: Array.isArray(rule) ? rule[0] : rule === undefined ? null : rule,
                    projectService: ((c.languageOptions || {}).parserOptions || {}).projectService ?? null,
                };
            });
            process.stdout.write(JSON.stringify(out));
        }).catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['-e', program, JSON.stringify(files)], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    return JSON.parse(out) as Record<string, Resolved>;
}

describe('no-floating-promises is an error in server code (#4579)', () => {
    let resolved: Record<string, Resolved>;

    beforeAll(() => {
        resolved = resolveConfigs(SERVER_FILES);
    }, 60_000);

    it.each(SERVER_FILES)('%s: the rule is an error, with a TypeScript program', (file) => {
        // ESLint normalises severities to 0/1/2 in a resolved config.
        expect(resolved[file]).toEqual({ severity: 2, projectService: true });
    });
});
