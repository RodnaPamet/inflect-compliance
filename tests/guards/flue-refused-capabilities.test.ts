/**
 * Sandboxes stay off, and the other refused agent-runtime capabilities stay
 * out — enforced at the IMPORT, which is the only place they can be stopped.
 *
 * ── WHY AN IMPORT BAN IS THE WHOLE CONTROL ──────────────────────────────────
 *
 * `useSandbox` is a hook, not a setting. It is not enabled by configuration;
 * it is *called* by an agent function, and it cannot be called without being
 * imported. So refusing the import refuses the capability outright — there is
 * no runtime path around it and nothing to misconfigure at deploy time.
 *
 * The refusal list itself lives in `src/lib/agentic/flue/refused-capabilities.ts`
 * and is imported here rather than restated, so the code half and the test half
 * are one list. A second copy is the drift this repo has paid for before.
 *
 * ── THE THREE WAYS THIS GUARD COULD BE WORTHLESS, AND THE CONTROL FOR EACH ──
 *
 *   1. It scans nothing. A population that resolves to zero files passes every
 *      assertion. → the population size is asserted, and named files are
 *      required to be in it.
 *   2. It cannot see a violation even when one exists. A regex that never
 *      matches passes just as quietly. → a planted violation of every shape
 *      the real code could take must be DETECTED.
 *   3. It bans something we intend to adopt. Subagents are Phase 3 of the plan
 *      — *adopt*, not refuse. → the list is asserted NOT to contain them, so a
 *      later adoption is not mistaken for a policy reversal.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    PERMITTED_FLUE_PACKAGES,
    REFUSED_FLUE_EXPORTS,
    REFUSED_FLUE_EXPORT_NAMES,
} from '@/lib/agentic/flue/refused-capabilities';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { resolveFlueModel } from '@/lib/agentic/flue/model-selection';

/**
 * The names `@flue/runtime` actually exports, located by ASKING NODE.
 *
 * Not `path.join(REPO_ROOT, 'node_modules/...')`. A spelled path into an
 * installed package exists only in a checkout that owns its install: a
 * `.claude/worktrees/<id>/` checkout resolves upward to the primary clone and
 * has no `node_modules` of its own, so a spelled path fails there while passing
 * in CI. `tests/guardrails/dependency-paths-are-resolved.test.ts` refuses them
 * for exactly that reason, and it caught this one.
 *
 * `require.resolve('@flue/runtime')` cannot be used either: the package is
 * ESM-only — its `exports` map declares `types` and `import` conditions and no
 * `require` — so CJS resolution of the entry point, of any subpath, and of
 * `package.json` all fail with ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * So this uses `require.resolve.paths()`, which IS Node's upward walk, and then
 * reads the package's own declared `types` entry rather than a guessed internal
 * layout. That entry is a four-line shim (`export * from '../dist/index.d.mts'`),
 * so the re-export is followed to the file that actually carries the names.
 *
 * THROWS rather than skipping when the package cannot be found. A guard that
 * quietly passes when its subject is missing is the failure this file is full
 * of controls against.
 */
function installedRuntimeExportNames(): ReadonlySet<string> {
    const roots = require.resolve.paths('@flue/runtime') ?? [];
    const dir = roots.map((r) => path.join(r, '@flue', 'runtime')).find((d) => existsSync(d));
    if (!dir) {
        throw new Error(
            '@flue/runtime is not installed in any node_modules on Node\'s resolution path — ' +
                'run `npm install` rather than treating this as a pass',
        );
    }

    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        types?: string;
        exports?: Record<string, { types?: string } | undefined>;
    };
    const declared = manifest.exports?.['.']?.types ?? manifest.types;
    if (!declared) throw new Error('@flue/runtime declares no types entry');

    let file = path.join(dir, declared);
    let src = readFileSync(file, 'utf8');

    // Follow a re-export shim to the declarations that carry the names.
    const reexport = /export\s+\*\s+from\s+['"](.+?)['"]/.exec(src);
    if (reexport) {
        file = path.resolve(path.dirname(file), reexport[1]);
        src = readFileSync(file, 'utf8');
    }

    return new Set(
        // No `s` flag: `[^}]*` is a negated class and already matches
        // newlines, and the flag needs an es2018 target this tsconfig does not
        // set (TS1501). jest transpiles it happily, so `tsc` is the only thing
        // that catches it.
        (/export \{([^}]*)\}/.exec(src)?.[1] ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^type /, ''))
            .filter(Boolean),
    );
}

/** Source files that could import from the agent runtime. */
const SOURCE_FILES = repoRelativeFiles().filter(
    (rel) => rel.startsWith('src/') && /\.tsx?$/.test(rel),
);

/**
 * Every name imported from an `@flue/*` module in one file.
 *
 * Deliberately blind to `import type` vs a value import: a type-only import of
 * `Sandbox` is harmless at runtime and is still a sign that somebody is
 * building toward the refused capability, which is a conversation worth having
 * at review rather than after.
 */
function flueImportedNames(source: string): string[] {
    const names: string[] = [];
    // `import ... from '@flue/x'` — the clause is everything between `import`
    // and `from`, which covers default, namespace and named forms at once.
    const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"](@flue\/[^'"]+)['"]/g;
    for (const m of source.matchAll(re)) {
        const clause = m[1];
        for (const ident of clause.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
            names.push(ident[0]);
        }
    }
    // `require('@flue/x')` and dynamic `import('@flue/x')` — no named clause to
    // read, so the whole module is treated as reaching everything it exports.
    // Reported under a sentinel rather than ignored, because that is exactly
    // how a ban on named imports gets routed around.
    if (/(?:require|import)\s*\(\s*['"]@flue\/[^'"]+['"]\s*\)/.test(source)) {
        names.push('__DYNAMIC_FLUE_IMPORT__');
    }
    return names;
}

const violations = SOURCE_FILES.flatMap((rel) => {
    const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    return flueImportedNames(source)
        .filter((n) => REFUSED_FLUE_EXPORT_NAMES.has(n) || n === '__DYNAMIC_FLUE_IMPORT__')
        .map((n) => `${rel} imports ${n}`);
});

describe('the refused agent-runtime capabilities stay out of src/', () => {
    it('imports none of them, anywhere', () => {
        // The denominator beside the answer: an empty violation list from a
        // population of zero says nothing at all.
        expect({ scanned: SOURCE_FILES.length, violations }).toEqual({
            scanned: SOURCE_FILES.length,
            violations: [],
        });
    });

    it('scanned a population that actually contains the agentic code', () => {
        expect(SOURCE_FILES.length).toBeGreaterThan(500);
        // Named explicitly: these are the files a sandbox would arrive in, and
        // a population that lost them would pass the assertion above while
        // checking nothing that matters.
        expect(SOURCE_FILES).toContain('src/lib/agentic/flue/tools-adapter.ts');
        expect(SOURCE_FILES).toContain('src/lib/agentic/flue/json-schema-to-valibot.ts');
    });

    it('the adapter imports from the runtime at all — so the scan has a real subject', () => {
        // If nothing in src/ ever imported `@flue/*`, this guard would be
        // vacuous no matter how good its regex. One real import is what makes
        // the absence of the refused ones meaningful.
        const adapter = readFileSync(
            path.join(REPO_ROOT, 'src/lib/agentic/flue/tools-adapter.ts'),
            'utf8',
        );
        expect(flueImportedNames(adapter).length).toBeGreaterThan(0);
    });
});

describe('the detector fires — on every shape the real code could take', () => {
    const detects = (source: string) =>
        flueImportedNames(source).filter(
            (n) => REFUSED_FLUE_EXPORT_NAMES.has(n) || n === '__DYNAMIC_FLUE_IMPORT__',
        );

    it('catches a plain named import', () => {
        expect(detects(`import { useSandbox } from '@flue/runtime';`)).toEqual(['useSandbox']);
    });

    it('catches one refused name hidden among permitted ones', () => {
        // The realistic shape. Nobody writes a line importing only `useSandbox`;
        // it arrives appended to an import that was already there.
        expect(
            detects(`import { useTool, useModel, createBashTool } from '@flue/runtime';`),
        ).toEqual(['createBashTool']);
    });

    it('catches a multi-line import clause', () => {
        expect(
            detects(`import {\n    useTool,\n    sandboxFromDriver,\n} from '@flue/runtime';`),
        ).toEqual(['sandboxFromDriver']);
    });

    it('catches a type-only import', () => {
        // Harmless at runtime, and a signal that somebody is building toward
        // the capability — which is a review conversation, not a silent pass.
        expect(detects(`import type { Sandbox } from '@flue/runtime';`)).toEqual(['Sandbox']);
    });

    it('catches an aliased import by its ORIGINAL name', () => {
        // `{ useSandbox as runCode }` still reaches the refused export. The
        // clause scan reads both identifiers, so the original is caught.
        expect(detects(`import { useSandbox as runCode } from '@flue/runtime';`)).toContain(
            'useSandbox',
        );
    });

    it('catches a dynamic import or require of any @flue module', () => {
        // The obvious way around a named-import ban.
        expect(detects(`const flue = require('@flue/runtime');`)).toEqual([
            '__DYNAMIC_FLUE_IMPORT__',
        ]);
        expect(detects(`const m = await import('@flue/postgres');`)).toEqual([
            '__DYNAMIC_FLUE_IMPORT__',
        ]);
    });

    it('does NOT fire on the permitted surface', () => {
        // The other half of a detector: one that flags everything is as
        // useless as one that flags nothing.
        expect(
            detects(`import { useTool, useModel, useInstruction } from '@flue/runtime';`),
        ).toEqual([]);
    });

    it('does NOT fire on a same-named import from somewhere else', () => {
        // `Sandbox` is a common word. The ban is on the agent runtime's export,
        // not on the identifier.
        expect(detects(`import { Sandbox } from '@/components/ui/sandbox';`)).toEqual([]);
    });
});

describe('the package allowlist', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };

    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) =>
        n.startsWith('@flue/'),
    );

    it('declares only permitted @flue packages', () => {
        // An ALLOWLIST: the registry carries eighteen `@flue/*` packages today
        // and will carry more, so enumerating the refused ones would rot the
        // moment somebody publishes a nineteenth.
        expect(declared.sort()).toEqual([...PERMITTED_FLUE_PACKAGES].sort());
    });

    it('does not carry @flue/postgres', () => {
        // Named explicitly because it is the one the plan refuses by name: a
        // second write path around RLS, the encrypted-field manifest and the
        // hash-chained audit trail. The assertion above already covers it; this
        // one makes the refusal greppable from the package it is about.
        expect(declared).not.toContain('@flue/postgres');
    });
});

describe('the list refuses what was decided, and nothing else', () => {
    it('every entry carries a reason', () => {
        expect(REFUSED_FLUE_EXPORTS.filter((c) => !c.reason || c.reason.length < 10)).toEqual([]);
    });

    it('does NOT ban the subagent surface, which the plan adopts in phase 3', () => {
        // The distinction this list exists to keep: refused is not the same as
        // not-yet-built. Banning subagents here would make a later adoption
        // look like a policy reversal rather than the plan proceeding.
        for (const adopted of ['useSubagent', 'defineSubagent', 'GeneralSubagent']) {
            expect(REFUSED_FLUE_EXPORT_NAMES.has(adopted)).toBe(false);
        }
    });

    it('bans the whole sandbox family, not just the obvious name', () => {
        // A ban on `useSandbox` alone is one import away from meaningless.
        for (const name of ['useSandbox', 'sandboxFromDriver', 'SandboxFactory', 'createBashTool']) {
            expect(REFUSED_FLUE_EXPORT_NAMES.has(name)).toBe(true);
        }
    });

    it('every refused name is a REAL export of the installed runtime', () => {
        // Otherwise the list drifts into fiction: a typo'd or renamed entry
        // bans nothing and reads as protection. Checked against the installed
        // package, so a major upgrade that renames an export fails here.
        const exported = installedRuntimeExportNames();
        const fictional = REFUSED_FLUE_EXPORTS.map((c) => c.name).filter((n) => !exported.has(n));
        expect({ checked: REFUSED_FLUE_EXPORTS.length, fictional }).toEqual({
            checked: REFUSED_FLUE_EXPORTS.length,
            fictional: [],
        });
    });

    it('read a real export list, not an empty one', () => {
        // The control for the assertion above: an empty set would make every
        // refused name "real" by vacuity, and the whole check would pass while
        // verifying nothing.
        expect(installedRuntimeExportNames().size).toBeGreaterThan(50);
    });
});

/**
 * `setProvider` IS NOT A PER-RUN CALL — and this guard exists before the code
 * that would be tempted to make it one.
 *
 * ── THE HAZARD, MEASURED IN THE INSTALLED PACKAGE ───────────────────────────
 *
 * The runtime holds its providers in a module-scoped singleton:
 *
 *     let models = createModels();            // dist/providers-*.mjs, module scope
 *     function setProvider(p) { models.setProvider(p); }
 *
 * so every call mutates ONE process-wide registry. The obvious integration —
 * build a provider from the tenant's settings and register it as the run
 * starts — therefore races across concurrent runs, and the loser executes
 * against the winner's provider.
 *
 * In this product that race is not a performance bug. `aiResidency:
 * LOCAL_ONLY` is documented as a HARD invariant, so a lost race streams one
 * tenant's reasoning to an endpoint another tenant registered, with nothing on
 * the run to show it happened.
 *
 * ── WHY A GUARD RATHER THAN A CODE REVIEW ───────────────────────────────────
 *
 * There are zero call sites today, which is exactly when this is worth
 * pinning: the safe shape (register once at init, choose per run by MODEL
 * SPECIFIER — see `flue/model-selection.ts`) and the unsafe one differ by a
 * single line in a file nobody has written yet, and the unsafe one is the one
 * the runtime's own docstring suggests. A guard placed after the damage guards
 * nothing.
 */
describe('provider registration never becomes a per-run call', () => {
    /** The only modules that may ever name it. Empty today, deliberately. */
    const ALLOWED_TO_REGISTER: readonly string[] = [];

    // `repoRelativeFiles()` takes NO arguments — it returns every repo file,
    // and the narrowing is the caller's. The first draft passed an options
    // object, which was silently ignored, so the scan swept `docs/**` and
    // reported two implementation notes as provider registrations. The same
    // filter shape the top of this file already uses.
    const SRC = repoRelativeFiles().filter(
        (f) => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.tsx')),
    );

    /**
     * CODE, not prose — via `codeOf`, which blanks comments while preserving
     * offsets.
     *
     * The first draft of this guard grepped the raw file and immediately
     * failed on `flue/model-selection.ts`, whose docstring EXPLAINS the hazard
     * and therefore names it several times. That is the same defect as
     * `data-table.test.ts` selecting its population with
     * `content.includes('DataTable')`: a detector that cannot tell a mention
     * from a call reports the documentation as the violation, and the cheapest
     * way to satisfy it is to stop writing the explanation down.
     */
    function callsSetProvider(rel: string): boolean {
        const abs = path.join(REPO_ROOT, rel);
        if (!existsSync(abs)) return false;
        return /\bsetProvider\b/.test(codeOf(readFileSync(abs, 'utf8')));
    }

    it('scanned a real population, not an empty one', () => {
        // Without this the assertion below passes by vacuity.
        expect(SRC.length).toBeGreaterThan(500);
        expect(SRC).toContain('src/lib/agentic/flue/model-selection.ts');
    });

    it('no module under src/ registers a provider', () => {
        const callers = SRC.filter(callsSetProvider).filter(
            (f) => !ALLOWED_TO_REGISTER.includes(f),
        );
        expect({ callers }).toEqual({ callers: [] });
    });

    it('the detector would SEE a per-run registration', () => {
        // The positive control. The assertion above is satisfied by a regex
        // that never matches, and this is the difference between "examined and
        // clean" and "never looked".
        const planted = `
            import { setProvider } from '@flue/runtime/internal';
            export function startRun(tenant: Tenant) {
                setProvider(providerFor(tenant));   // the unsafe shape
            }
        `;
        expect(/\bsetProvider\b/.test(planted)).toBe(true);
    });

    it('the SAFE shape is what the model selector offers instead', () => {
        // Not decoration: a guard that only forbids leaves the next author
        // with a banned road and no other one. The specifier route is the
        // road, and it is asserted to exist so the refusal stays actionable.
        //
        // Asserted through the MODULE SYSTEM rather than by reading the file's
        // text. Two reasons, and the second is the better one:
        //
        //   · a whole-file read this detector cannot follow is a Class D blind
        //     spot, and `codeOf(readFileSync(…))` is exactly that shape;
        //   · `toMatch(/export function resolveFlueModel/)` proves a STRING is
        //     present. Importing it proves the export exists and is callable,
        //     which is the claim actually worth making.
        //
        // The companion claim — that this module does not register a provider
        // — needs no assertion of its own: it lives under `src/`, so the sweep
        // above already covers it.
        expect(typeof resolveFlueModel).toBe('function');
        expect(resolveFlueModel({ residency: 'EXTERNAL' })).toHaveProperty('ok');
    });
});
