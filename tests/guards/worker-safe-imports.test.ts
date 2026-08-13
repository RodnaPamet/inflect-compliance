/**
 * GUARD — code the BullMQ worker can reach must not statically import
 * Next-server-only modules.
 *
 * `scripts/worker.ts` is a plain Node process. It is not a Next runtime, so
 * `next/headers` and friends are not resolvable inside it. A STATIC top-level
 * import of one of them anywhere in the worker's import graph therefore kills
 * the process at module load, before a single executor is registered.
 *
 * That is not hypothetical. `src/lib/auth.ts` carried
 * `import { cookies } from 'next/headers'` at module scope, and
 * `src/app-layer/context.ts` imports `getSessionOrThrow` from it — which every
 * usecase imports for `getTenantCtx`. The production worker crash-looped with
 *
 *     Error: ERR_MODULE_NOT_FOUND  url: file:///app/node_modules/next/headers
 *
 * for as long as that import existed, so NO background job ever ran: no
 * retention sweep, no evidence-expiry monitor, no deadline reminders, no
 * notification digests, no audit-stream flush. Nothing failed loudly — the jobs
 * simply never executed, and every dashboard that reads their output showed a
 * quiet, plausible zero.
 *
 * A DYNAMIC `await import('next/headers')` at the use site is fine and is the
 * established pattern (`src/auth.ts`, `src/lib/security/session-tracker.ts`):
 * importing the module no longer requires resolving Next, and the call site is
 * already inside a try/catch or a request-only branch.
 *
 * Scope: `src/lib/**` and `src/app-layer/**` are worker-reachable. `src/app/**`
 * is route/page code that only ever runs inside Next, and `src/i18n.ts` is the
 * next-intl config loaded by the Next runtime itself — both are exempt.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

/** Modules that only resolve inside a Next server runtime. */
const NEXT_ONLY_MODULES = ['next/headers', 'next/navigation', 'server-only'];

/** Trees the worker can reach through `scripts/worker.ts`. */
const WORKER_REACHABLE = ['src/lib', 'src/app-layer'];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            walk(rel, out);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            out.push(rel);
        }
    }
    return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * A `"use client"` module is browser code. It cannot appear in the worker's
 * import graph, and it is exactly where `next/navigation` hooks belong — so
 * excluding it is a statement about the runtime, not a carve-out for
 * convenience. A server module that needs an exemption does not get one; it
 * gets a dynamic import.
 */
const isClientModule = (src: string) => /^\s*['"]use client['"]/.test(src);

/** Strip comments so prose naming a banned module is not a false positive. */
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('GUARD: worker-reachable code has no static Next-only imports', () => {
    const files = WORKER_REACHABLE.flatMap((d) => walk(d));

    it('scans a real population (the detector is not vacuous)', () => {
        expect(files.length).toBeGreaterThan(200);
    });

    it.each(NEXT_ONLY_MODULES)('no static import of %s under src/lib or src/app-layer', (mod) => {
        // Matches `import ... from 'mod'` and bare `import 'mod'` at top level.
        // A dynamic `await import('mod')` is deliberately NOT matched.
        const staticImport = new RegExp(
            `^\\s*import\\s+(?:[^;]*?\\s+from\\s+)?['"]${mod.replace('/', '\\/')}['"]`,
            'm',
        );
        const offenders = files.filter((f) => {
            const src = read(f);
            if (isClientModule(src)) return false;
            return staticImport.test(stripComments(src));
        });
        expect(offenders).toEqual([]);
    });

    it('the known use sites still reach next/headers dynamically', () => {
        // Guards the other direction: someone "tidying" a dynamic import back
        // into a static one at these three sites reintroduces the crash.
        for (const f of [
            'src/lib/auth.ts',
            'src/auth.ts',
            'src/lib/security/session-tracker.ts',
        ]) {
            expect(read(f)).toMatch(/await import\(\s*['"]next\/headers['"]\s*\)/);
        }
    });

    it('context.ts — the module every usecase pulls — is clean', () => {
        // Called out by name because this is the edge that made ONE bad import
        // in lib/auth.ts fatal for the entire job subsystem.
        const src = stripComments(read('src/app-layer/context.ts'));
        for (const mod of NEXT_ONLY_MODULES) {
            expect(src).not.toMatch(new RegExp(`from\\s+['"]${mod.replace('/', '\\/')}['"]`));
        }
    });
});
