/**
 * GUARD — nothing the BullMQ worker can reach may pull in the NextAuth tree.
 *
 * `scripts/worker.ts` is a plain Node process. `src/auth.ts` builds the
 * NextAuth provider array at MODULE SCOPE and `src/lib/auth.ts` imports
 * `next/headers`, neither of which survives that runtime:
 *
 *     ERR_MODULE_NOT_FOUND  file:///app/node_modules/next/headers   (at boot)
 *     TypeError: Google is not a function                    (at job execution)
 *
 * Both were the SAME edge — `context.ts` importing `getSessionOrThrow` — and
 * they presented differently only because the executor registry imports job
 * modules lazily: the first killed the process before any executor registered,
 * the second killed individual jobs while the worker looked healthy.
 *
 * This walks the actual import graph rather than checking one file, because the
 * damage was transitive. Several affected jobs never mentioned a context
 * builder in their own source — they reached one through a usecase, so nothing
 * in the file suggested the problem.
 *
 * It asserts a PROPERTY, deliberately, rather than listing affected modules.
 * The list was miscounted three times while diagnosing this (a `grep -l` that
 * matched prose in comments, and a conflation of the jobs/ and usecases/
 * trees), and any hand-maintained list goes stale the first time someone adds
 * a job.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve as resolvePath } from 'path';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

/** Modules that cannot be evaluated in the worker's plain-Node runtime. */
const FORBIDDEN = ['src/auth.ts', 'src/lib/auth.ts'];

const read = (abs: string) => readFileSync(abs, 'utf8');

/** Strip comments so prose naming a module is not read as an import. */
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Resolve an import specifier to a file under src/, or null if external. */
function resolveSpec(fromAbs: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = resolvePath(dirname(fromAbs), spec);
    else return null; // node_modules
    for (const cand of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
    ]) {
        if (existsSync(cand) && !readdirSyncIsDir(cand)) return cand;
    }
    return null;
}

function readdirSyncIsDir(p: string): boolean {
    try {
        readdirSync(p);
        return true;
    } catch {
        return false;
    }
}

/** STATIC import specifiers only — a dynamic import is not evaluated at load. */
function staticImports(src: string): string[] {
    const out: string[] = [];
    const re = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[1]);
    const re2 = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;
    while ((m = re2.exec(src))) out.push(m[1]);
    return out;
}

/** Walk the static import graph from `entry`; return the path if it reaches a forbidden module. */
function pathToForbidden(entry: string): string[] | null {
    const seen = new Set<string>();
    const stack: Array<{ file: string; trail: string[] }> = [
        { file: entry, trail: [entry] },
    ];
    while (stack.length) {
        const { file, trail } = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const rel = file.slice(ROOT.length + 1);
        if (FORBIDDEN.includes(rel)) return trail.map((f) => f.slice(ROOT.length + 1));
        let src: string;
        try {
            src = stripComments(read(file));
        } catch {
            continue;
        }
        for (const spec of staticImports(src)) {
            const next = resolveSpec(file, spec);
            if (next) stack.push({ file: next, trail: [...trail, next] });
        }
    }
    return null;
}

function jobEntrypoints(): string[] {
    const dir = join(SRC, 'app-layer', 'jobs');
    return readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
        .map((f) => join(dir, f));
}

describe('GUARD: the worker import graph never reaches the NextAuth tree', () => {
    const entries = jobEntrypoints();

    it('scans a real population', () => {
        // If this collapses, every assertion below passes vacuously.
        expect(entries.length).toBeGreaterThan(20);
    });

    it('the job-facing context module is clean', () => {
        // Named explicitly because it is the module the split created to BE
        // clean — if it ever reaches the auth tree, the split has been undone.
        const p = pathToForbidden(join(SRC, 'app-layer', 'context-system.ts'));
        expect(p).toBeNull();
    });

    it('no job module reaches src/auth.ts or src/lib/auth.ts', () => {
        const offenders = entries
            .map((e) => ({ entry: e.slice(ROOT.length + 1), path: pathToForbidden(e) }))
            .filter((r) => r.path !== null)
            // Render the full chain — the useful part of the failure is WHICH
            // edge pulled it in, which is exactly what was hard to find by hand.
            .map((r) => `${r.entry}\n    -> ${r.path!.join('\n    -> ')}`);

        expect(offenders).toEqual([]);
    });
});
