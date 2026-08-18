/**
 * The compliance-calendar aggregation must be importable in the BullMQ worker.
 *
 * ═══ THE FAILURE THIS PREVENTS ═══
 *
 * `@/auth` builds the NextAuth provider array at module scope. In a plain Node
 * process that is fatal:
 *
 *     ERR_MODULE_NOT_FOUND  file:///app/node_modules/next/headers   (at boot)
 *     TypeError: Google is not a function                    (at job execution)
 *
 * `context-system.ts:1-37` documents this from a real incident — eight
 * registered jobs dragged the whole NextAuth tree in, four of them only
 * transitively through a usecase, with nothing in their own file to say so —
 * and states the rule: nothing on a job path may import `@/lib/auth`, `@/auth`,
 * or anything reaching them.
 *
 * The aggregation reached it through ONE function:
 *
 *     compliance-calendar/index.ts  → hasPermission from permission-middleware
 *       → permission-middleware:36  → getTenantCtx from @/app-layer/context   (VALUE import)
 *         → context.ts:2            → getSessionOrThrow from @/lib/auth
 *           → lib/auth.ts:14        → auth from @/auth
 *             → auth.ts:35-40       → next-auth/providers/{google,azure-ad,credentials}
 *
 * ═══ WHY IT WOULD NOT HAVE BEEN CAUGHT ═══
 *
 * `executor-registry.ts` loads each job with a dynamic `await import(...)` at
 * EXECUTION time. So the worker boots clean, CI stays green, and the failure
 * arrives the first time the job actually runs — in production, at whatever
 * hour it is scheduled for. A nightly push that has never once succeeded is
 * indistinguishable from a feature nobody uses.
 *
 * ═══ WHY THIS WALKS THE GRAPH INSTEAD OF GREPPING ═══
 *
 * A source-text check on the aggregation's own imports would pass while the
 * edge lived one hop away — which is exactly how it survived: five of the six
 * calendar files imported `hasPermission` as a VALUE and never called it, so
 * removing the import from `index.ts` alone would have left the edge intact
 * and this test green.
 *
 * So it resolves the real transitive graph from disk and fails with the actual
 * import chain, because "something reaches next-auth" is unactionable without
 * knowing which hop to cut.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** Modules that must never appear on a worker-reachable path. */
const FORBIDDEN = [/^next-auth(\/|$)/, /^next\/headers$/];

/** Local specifiers that resolve to a file we should keep walking into. */
function resolveLocal(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return null;

    for (const cand of [
        `${base}.ts`, `${base}.tsx`,
        path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
    ]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
}

/**
 * Every specifier this file imports at MODULE SCOPE.
 *
 * `import type` is excluded deliberately — it erases at compile time and
 * cannot drag anything into the runtime graph. That distinction is the whole
 * fix for `shared.ts`, which kept the edge alive purely by importing a value
 * it never called.
 *
 * A dynamic `await import(...)` is also excluded: it is how the executor
 * registry legitimately defers loading, and treating it as an edge would flag
 * the entire job tree.
 */
function staticImports(file: string): string[] {
    const src = fs.readFileSync(file, 'utf8');
    const out: string[] = [];
    // import ... from 'x'  /  import 'x'  /  export ... from 'x'
    const re = /^\s*(?:import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) {
        const line = m[0];
        // `import { type A, type B } from` is still a value import statement,
        // but if EVERY named binding is `type`-prefixed nothing is emitted.
        const named = line.match(/\{([^}]*)\}/);
        if (named && !/^\s*import\s+\w/.test(line)) {
            const parts = named[1].split(',').map((p) => p.trim()).filter(Boolean);
            if (parts.length > 0 && parts.every((p) => p.startsWith('type '))) continue;
        }
        out.push(m[1]);
    }
    return out;
}

/** Walk the static graph, returning the first path that reaches a forbidden module. */
function findForbiddenPath(entry: string): string[] | null {
    const seen = new Set<string>();
    const stack: Array<{ file: string; trail: string[] }> = [
        { file: entry, trail: [path.relative(ROOT, entry)] },
    ];

    while (stack.length) {
        const { file, trail } = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);

        for (const spec of staticImports(file)) {
            if (FORBIDDEN.some((re) => re.test(spec))) {
                return [...trail, spec];
            }
            const next = resolveLocal(spec, file);
            if (next && !seen.has(next)) {
                stack.push({ file: next, trail: [...trail, path.relative(ROOT, next)] });
            }
        }
    }
    return null;
}

const AGGREGATION = path.join(SRC, 'app-layer/usecases/compliance-calendar/index.ts');

describe('the calendar aggregation is worker-safe', () => {
    it('sanity — the aggregation entry point exists and imports things', () => {
        // A graph walk from a missing or empty file passes vacuously.
        expect(fs.existsSync(AGGREGATION)).toBe(true);
        expect(staticImports(AGGREGATION).length).toBeGreaterThan(5);
    });

    it('reaches no next-auth or next/headers import', () => {
        const chain = findForbiddenPath(AGGREGATION);
        // Reported as the full chain, because "something reaches next-auth" is
        // unactionable without knowing which hop to cut.
        expect(chain === null ? null : chain.join('\n  → ')).toBeNull();
    });

    it('the walker really does find the edge when it exists — not vacuous', () => {
        // The whole test is worthless if the walker cannot see the chain it was
        // written for. `permission-middleware` still legitimately reaches
        // next-auth via getTenantCtx, so it is a live positive control that
        // cannot rot into a no-op.
        const chain = findForbiddenPath(path.join(SRC, 'lib/security/permission-middleware.ts'));
        expect(chain).not.toBeNull();
        expect(chain!.join(' ')).toMatch(/next-auth|next\/headers/);
    });

    it('the leaf module itself is clean', () => {
        expect(findForbiddenPath(path.join(SRC, 'lib/security/permission-key.ts'))).toBeNull();
    });

    it('no calendar file imports hasPermission from the middleware', () => {
        // The direct form of the rule, as a second line of defence: the graph
        // walk proves the property, this names the specific regression so the
        // failure says what to do.
        const dir = path.join(SRC, 'app-layer/usecases/compliance-calendar');
        const offenders = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.ts'))
            .filter((f) => /from '@\/lib\/security\/permission-middleware'/.test(
                fs.readFileSync(path.join(dir, f), 'utf8'),
            ));
        expect(offenders).toEqual([]);
    });
});
