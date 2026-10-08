/**
 * The 350 rendered suites stay inside a program `tsc` actually compiles.
 *
 * `tests/rendered/tsconfig.json` is ts-jest's config for the jsdom project.
 * It is not a program `tsc` can load: `module: commonjs` with
 * `moduleResolution: bundler` is TS5095, so `tsc -p` against it fails on the
 * CONFIG before it reads a test file. The root program does not cover these
 * either — its `include` is `**\/*.ts` and the suites are `.tsx` under
 * `tests/`. So every assertion those suites make about accessible names,
 * localisation and rendered DOM was type-checked by nothing (#3214).
 *
 * `tsconfig.typecheck.json` is the program that does compile them. This guard
 * exists because each of the four ways it can quietly stop working leaves no
 * other trace:
 *
 *   1. SOMEBODY MERGES THE TWO FILES. ts-jest does
 *      `module: resultOptions.module ?? ModuleKind.CommonJS` on the config it
 *      has ALREADY resolved through `extends`. The `??` therefore fires only
 *      when `module` is absent after inheritance, and the root config sets
 *      `esnext` — so deleting `module: commonjs` from the ts-jest config hands
 *      jest ESM output rather than falling back to CommonJS. Claim 3 pins that
 *      line as load-bearing for all 350 suites' emit.
 *
 *   2. THE PAIRING GOES INVALID AGAIN. `bundler` requires `module` to be
 *      `preserve` / `esnext` / `es2015`+. Reintroducing `commonjs` here is
 *      TS5095 again, and a config-level failure is not a type error with a
 *      file and a line — it is the whole program not loading, which reads in a
 *      log much more like a tooling hiccup than like 350 unchecked suites.
 *
 *   3. THE PROGRAM GETS NARROWED. A zero from a program that included nothing
 *      is byte-identical to a zero from a clean one. The typecheck config
 *      declares no `include` / `exclude` / `files` of its own so the program
 *      stays exactly ts-jest's; claim 4 refuses any of those keys, and claim 5
 *      checks the inherited `include` still names both halves.
 *
 *   4. NOTHING RUNS IT. The precedent is in this repo and is why the comment
 *      in `ci.yml` is phrased the way it is: `packages/ui/tsconfig.json`
 *      "existed from #3193 and was compiled by NOTHING — not this workflow,
 *      not a script — so the boundary was a declaration". Claims 6 and 7 make
 *      the script name the config and CI name the script.
 *
 * What this guard deliberately does NOT do is run `tsc`. That is the CI step's
 * job, and a guard that shelled out to a three-minute compile would be the
 * slowest test in the suite for a result CI already publishes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import * as ts from 'typescript';

import { REPO_ROOT } from '../helpers/repo-files';

const RENDERED_DIR = path.join(REPO_ROOT, 'tests', 'rendered');
const TSJEST_CONFIG = path.join(RENDERED_DIR, 'tsconfig.json');
const TYPECHECK_CONFIG = path.join(RENDERED_DIR, 'tsconfig.typecheck.json');
const SCRIPT_NAME = 'typecheck:rendered';

/** tsconfigs are JSONC — comments and trailing commas. `JSON.parse` rejects both. */
function readTsconfig(file: string): Record<string, unknown> {
    const text = fs.readFileSync(file, 'utf8');
    const { config, error } = ts.parseConfigFileTextToJson(file, text);
    expect(error).toBeUndefined();
    return config as Record<string, unknown>;
}

function compilerOptions(file: string): Record<string, unknown> {
    const c = readTsconfig(file);
    return (c.compilerOptions ?? {}) as Record<string, unknown>;
}

/**
 * The pairings TypeScript accepts for `moduleResolution: bundler`.
 * Mirrors the TS5095 check: bundler needs `module` at `preserve` or an
 * ES-module kind, never a CommonJS one.
 */
const BUNDLER_COMPATIBLE_MODULES = new Set([
    'preserve',
    'es2015',
    'es2020',
    'es2022',
    'esnext',
]);

describe('the rendered suites are inside a program tsc compiles (#3214)', () => {
    it('1. the typecheck config exists', () => {
        expect(fs.existsSync(TYPECHECK_CONFIG)).toBe(true);
    });

    it('2. it extends the ts-jest config, so the two cannot describe different programs', () => {
        expect(readTsconfig(TYPECHECK_CONFIG).extends).toBe('./tsconfig.json');
    });

    it('3. the ts-jest config still sets `module` explicitly — ts-jest only defaults when it is ABSENT', () => {
        // `module: resultOptions.module ?? ModuleKind.CommonJS` runs on the
        // post-`extends` options, and the root config sets `esnext`. Dropping
        // this line gives jest ESM output; it does not fall back to CommonJS.
        const mod = compilerOptions(TSJEST_CONFIG).module;
        expect(typeof mod).toBe('string');
        expect(String(mod).toLowerCase()).toBe('commonjs');
    });

    it('4. the typecheck config overrides only the module pairing — never the program', () => {
        const c = readTsconfig(TYPECHECK_CONFIG);
        // A narrowed program yields a zero indistinguishable from a clean one.
        expect(Object.keys(c).filter((k) => ['include', 'exclude', 'files'].includes(k))).toEqual(
            [],
        );
    });

    it('5. its pairing is one TypeScript accepts, and resolution stays the bundler’s', () => {
        const o = compilerOptions(TYPECHECK_CONFIG);
        expect(String(o.moduleResolution).toLowerCase()).toBe('bundler');
        expect(BUNDLER_COMPATIBLE_MODULES).toContain(String(o.module).toLowerCase());
    });

    it('6. the inherited program still names both the rendered suites and src', () => {
        const include = readTsconfig(TSJEST_CONFIG).include as string[] | undefined;
        expect(Array.isArray(include)).toBe(true);
        // `./**/*` is what picks up the 350 suites; `../../src/**/*` is what
        // makes a broken import in a component fail here and not only in jest.
        expect(include).toContain('./**/*');
        expect(include!.some((g) => g.includes('src/'))).toBe(true);
    });

    it('7. an npm script compiles that config', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
        ) as { scripts: Record<string, string> };
        const script = pkg.scripts[SCRIPT_NAME];
        expect(script).toBeDefined();
        expect(script).toContain('tests/rendered/tsconfig.typecheck.json');
        expect(script).toMatch(/\btsc\b/);
        expect(script).toContain('--noEmit');
    });

    it('8. the CI Typecheck job runs that script', () => {
        const wf = yaml.load(
            fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
        ) as { jobs: Record<string, { steps?: { run?: string }[] }> };
        const job = wf.jobs.typecheck;
        expect(job).toBeDefined();
        const runs = (job.steps ?? []).map((s) => s.run ?? '').join('\n');
        // `npm run <name>` specifically — a step that merely mentions the
        // config in a comment would satisfy a looser needle.
        expect(runs).toContain(`npm run ${SCRIPT_NAME}`);
    });
});
