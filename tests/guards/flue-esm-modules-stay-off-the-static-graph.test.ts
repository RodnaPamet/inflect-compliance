/**
 * THE ESM-ONLY MODULES ARE REACHABLE ONLY BY ONE DYNAMIC EDGE.
 *
 * ── WHAT BREAKS IF THIS SLIPS ───────────────────────────────────────────────
 *
 * `@flue/runtime` and `@earendil-works/pi-ai` publish an `import` condition
 * and no `require` one. A jest suite in the `node` project that transitively
 * reaches either of them does not fail an assertion — it fails to LOAD, with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` or `Class extends value [object Module] is
 * not a constructor` from `pg`.
 *
 * `drivers/index.ts` is reached by a great many suites, and it now imports
 * `flue/driver.ts`. The one thing standing between those suites and an
 * unloadable package is that `driver.ts` reaches the execution half through
 * `await import('./execute')` rather than a static import. That is a property
 * of the import graph, so this guard walks the import graph — three
 * docstrings claim it, and a claim in a docstring is not enforcement.
 *
 * ── WHY REACHABILITY, NOT A FILE ALLOWLIST ──────────────────────────────────
 *
 * A list of "files that may import `@flue/runtime`" is satisfied by a file on
 * the list — while saying nothing about who imports THAT file. The defect this
 * is guarding against is exactly one edge too many somewhere in the middle, so
 * the question has to be asked from the roots: starting at the modules the app
 * really loads, following only STATIC edges, is an ESM-only module reached?
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';

import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

/** Packages that cannot be loaded from a CommonJS jest project. */
const ESM_ONLY_PACKAGES = ['@flue/runtime', '@earendil-works/pi-ai'];

/**
 * The roots ordinary suites load. `drivers/index.ts` is the one that matters —
 * it is the driver registry, and it now names the Flue driver.
 */
const ROOTS = [
    'src/lib/agentic/drivers/index.ts',
    'src/lib/agentic/drivers/static-driver.ts',
    'src/lib/agentic/flue/driver.ts',
    'src/app-layer/usecases/workflow-runs.ts',
];

/**
 * STATIC import specifiers in a module, comments masked.
 *
 * `codeOf` blanks comments while preserving offsets — without it this file's
 * own neighbours would be read as importers, since several of them spend a
 * docstring explaining which package must not be imported and from where.
 *
 * Dynamic `import(...)` is deliberately NOT matched: it is the boundary this
 * guard exists to confirm, not an edge to follow.
 */
function staticImportsOf(rel: string): string[] {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) return [];
    const code = codeOf(readFileSync(abs, 'utf8'));
    const specs: string[] = [];
    for (const m of code.matchAll(/^\s*import\s+[\s\S]*?\s*from\s+['"]([^'"]+)['"]/gm)) {
        specs.push(m[1]);
    }
    // Side-effect imports: `import 'x';`
    for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
        specs.push(m[1]);
    }
    return specs;
}

/**
 * The subset that survives compilation — `import type` clauses erased.
 *
 * The distinction matters for the census below and not for the walk above. A
 * type-only import creates no runtime edge, so it cannot make a package
 * unloadable; `runtime-bootstrap.ts` and `tools-adapter.ts` both name an
 * ESM-only package this way, deliberately, and both are in the ordinary graph.
 * Counting them as importers would force them onto an allowlist for a reason
 * that does not exist.
 */
function valueImportsOf(rel: string): string[] {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) return [];
    const code = codeOf(readFileSync(abs, 'utf8'));
    const specs: string[] = [];
    for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s*from\s+['"]([^'"]+)['"]/gm)) {
        if (/^type\s/.test(m[1])) continue;
        specs.push(m[2]);
    }
    for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
        specs.push(m[1]);
    }
    return specs;
}

/** Resolve a specifier to a repo-relative .ts file, or null if it is a package. */
function resolveToFile(fromRel: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) {
        base = path.join('src', spec.slice(2));
    } else if (spec.startsWith('.')) {
        base = path.normalize(path.join(path.dirname(fromRel), spec));
    } else {
        return null; // a package, not a repo file
    }
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (existsSync(path.join(REPO_ROOT, candidate))) return candidate;
    }
    return null;
}

/** Walk static edges from `roots`; return every repo file reached, plus packages seen. */
function staticClosure(roots: readonly string[]): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
        const rel = queue.pop()!;
        if (files.has(rel)) continue;
        files.add(rel);
        for (const spec of staticImportsOf(rel)) {
            const target = resolveToFile(rel, spec);
            if (target) queue.push(target);
            else packages.add(spec);
        }
    }
    return { files, packages };
}

describe('the ESM-only packages are outside the static graph the node project loads', () => {
    const closure = staticClosure(ROOTS);

    it('walked a real graph, not an empty one', () => {
        // Both assertions below are satisfied by a walk that found nothing.
        // This is what makes them mean something — and the named file is the
        // one whose presence proves the walk followed `@/` and relative
        // specifiers rather than stopping at the roots.
        expect(closure.files.size).toBeGreaterThan(30);
        expect(closure.files).toContain('src/lib/agentic/flue/driver-plan.ts');
        expect(closure.packages.size).toBeGreaterThan(3);
    });

    it('reaches neither ESM-only package', () => {
        const reached = [...closure.packages].filter((p) =>
            ESM_ONLY_PACKAGES.some((esm) => p === esm || p.startsWith(`${esm}/`)),
        );
        expect({ reached }).toEqual({ reached: [] });
    });

    it('does not reach the modules that import them', () => {
        // The same fact from the other side. `execute.ts` is the entry to the
        // ESM half; if the closure contains it, the package check above is one
        // edit away from failing regardless of what it says today.
        const esmSide = [
            'src/lib/agentic/flue/execute.ts',
            'src/lib/agentic/flue/agent.ts',
            'src/lib/agentic/flue/providers.ts',
            'src/lib/agentic/flue/runtime-start.ts',
        ];
        const reached = esmSide.filter((f) => closure.files.has(f));
        expect({ reached }).toEqual({ reached: [] });
    });

    it('the ESM half really does import those packages — so the scan has a subject', () => {
        // Without this, every assertion above is satisfied by an ESM half that
        // imports nothing, and the guard would keep passing after the thing it
        // guards had been deleted.
        const importers = ['src/lib/agentic/flue/execute.ts', 'src/lib/agentic/flue/agent.ts']
            .flatMap((f) => staticImportsOf(f))
            .filter((s) => ESM_ONLY_PACKAGES.some((esm) => s === esm || s.startsWith(`${esm}/`)));
        expect(importers.length).toBeGreaterThan(0);
    });

    it('the walk would SEE a static edge into the ESM half', () => {
        // The positive control. `staticClosure` returning a clean answer is
        // only meaningful if it can return a dirty one — so plant the edge
        // this guard exists to catch and confirm the walk follows it.
        const planted = staticClosure(['src/lib/agentic/flue/execute.ts']);
        expect(
            [...planted.packages].some((p) =>
                ESM_ONLY_PACKAGES.some((esm) => p === esm || p.startsWith(`${esm}/`)),
            ),
        ).toBe(true);
    });

    it('the driver reaches the execution half DYNAMICALLY, which is why the graph is clean', () => {
        // Names the mechanism. Without this, someone deleting the Flue driver
        // entirely would leave every assertion above green, and the guard
        // would read as proof of a property nothing was exercising.
        // NARROWED to the driver function, not read whole, and the assertion
        // gains from it twice over. It becomes the stronger claim — the
        // dynamic import is on the execution path itself, not merely somewhere
        // in the file — and a narrowed read is out of the whole-file
        // population that `assertion-needle-uniqueness-ratchet` measures,
        // which is the fix that ratchet exists to ask for.
        //
        // The needle is a LITERAL for the same family of reasons: a regex
        // carrying `\s*` is one the analyser skips outright.
        const driverBody = functionBodyOf(
            codeOf(readFileSync(path.join(REPO_ROOT, 'src/lib/agentic/flue/driver.ts'), 'utf8')),
            'runFlueDriver',
        );
        expect(driverBody).toContain("await import('./execute')");
        expect(staticImportsOf('src/lib/agentic/flue/driver.ts')).not.toContain('./execute');
    });
});

describe('every src/ file importing an ESM-only package is one of the known four', () => {
    // The list is small by design, and this is what keeps it small: a fifth
    // file appearing is a decision someone should make deliberately, with the
    // reachability walk above re-run against it.
    const ESM_SIDE = [
        'src/lib/agentic/flue/agent.ts',
        'src/lib/agentic/flue/execute.ts',
        'src/lib/agentic/flue/providers.ts',
        'src/lib/agentic/flue/runtime-start.ts',
    ];

    const SRC = repoRelativeFiles().filter(
        (f) => f.startsWith('src/') && /\.tsx?$/.test(f),
    );

    it('scanned a real population', () => {
        expect(SRC.length).toBeGreaterThan(500);
    });

    const isEsm = (s: string) =>
        ESM_ONLY_PACKAGES.some((esm) => s === esm || s.startsWith(`${esm}/`));

    it('lists exactly the value importers', () => {
        const importers = SRC.filter((f) => valueImportsOf(f).some(isEsm)).sort();
        expect(importers).toEqual([...ESM_SIDE].sort());
    });

    it('the type-only importers are named, not hidden', () => {
        // Recorded rather than filtered away. These are erased at runtime and
        // are therefore safe in the ordinary graph — but "safe because it is
        // type-only" is a claim that stops being true the moment someone drops
        // the `type` keyword, and a list nobody asserts is a list nobody
        // notices changing.
        const typeOnly = SRC.filter(
            (f) => staticImportsOf(f).some(isEsm) && !valueImportsOf(f).some(isEsm),
        ).sort();
        expect(typeOnly).toEqual([
            'src/lib/agentic/flue/runtime-bootstrap.ts',
            'src/lib/agentic/flue/tools-adapter.ts',
        ]);
    });

    it('the value/type split is a real distinction, not one the matcher invented', () => {
        // The control for the assertion above: `tools-adapter.ts` must show up
        // under one function and not the other. If `valueImportsOf` ever
        // stopped erasing type clauses — or started erasing everything — both
        // lists would agree and the split would be decorative.
        const adapter = 'src/lib/agentic/flue/tools-adapter.ts';
        expect(staticImportsOf(adapter).some(isEsm)).toBe(true);
        expect(valueImportsOf(adapter).some(isEsm)).toBe(false);
        // And the other direction, on a file that imports for real.
        expect(valueImportsOf('src/lib/agentic/flue/agent.ts').some(isEsm)).toBe(true);
    });
});
