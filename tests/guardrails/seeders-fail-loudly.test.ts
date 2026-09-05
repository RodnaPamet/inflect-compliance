/**
 * A seeder that throws must EXIT NON-ZERO.
 *
 * ═══ WHY ═══
 *
 * `prisma/seed.ts` ended with `main().catch(console.error)` for the life of the
 * file. `console.error` logs and returns — it neither rethrows nor sets an exit
 * code — so a throw anywhere in its 2,600 lines was printed and the process
 * still exited 0. The seed could not fail.
 *
 * The cost was paid on 2026-09-05. A fixture was reshaped into a different
 * top-level type and a consumer forty lines into the seed still read it through
 * an `as` cast; `for...of` threw on an object. The seed died there, reported
 * success, and CI carried on. The failure surfaced fifteen minutes later as E2E
 * specs for ISO 27001 and AI governance failing on data that had never been
 * seeded — three subsystems away from the change, with the real error sitting
 * unread in the log above a green tick.
 *
 * ═══ WHAT THIS ASSERTS, AND WHAT IT CANNOT ═══
 *
 * It reads the tail of every seed entrypoint and requires the rejection handler
 * to set a non-zero exit code, or rethrow, or call process.exit. It is a source
 * check, so it cannot prove the handler RUNS — only that a failure has somewhere
 * to go. That is the whole of the bug it exists for: the handler ran fine, and
 * did nothing.
 *
 * The four seeders under scripts/ already did this correctly. Only the largest,
 * and the one CI depends on, did not — which is the usual shape: the file
 * everything relies on is the one nobody re-reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';

/** A file is a seed entrypoint if it invokes a top-level `main()` chain. */
const ENTRYPOINT = /\bmain\(\)\s*\n?\s*\./;

function seedEntrypoints(): string[] {
    return repoRelativeFiles()
        .filter((rel) => /^(prisma|scripts)\/.*seed.*\.(ts|mjs)$/.test(rel))
        .filter((rel) => {
            try {
                return ENTRYPOINT.test(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
            } catch {
                return false;
            }
        });
}

/**
 * Does the rejection path give the failure somewhere to go?
 *
 * Scans the INVOCATION TAIL — from the last top-level `main()`-style call to
 * the end of the file — rather than trying to extract the catch argument.
 * The first draft did the latter with
 * `/\.catch\(([\s\S]*?)\)\s*\.finally/`, whose non-greedy group stops at
 * the first `)` it meets, which for any block-bodied handler is a paren INSIDE
 * the handler. It reported `seed-catalog.ts` and `seed-staging.ts` as silent
 * when both call `process.exit(1)` correctly. A detector that cannot parse the
 * correct form will be trusted right up until it is believed about a real one.
 */
function failsLoudly(src: string): boolean {
    const call = src.lastIndexOf('main()') >= 0 ? src.lastIndexOf('main()') : src.lastIndexOf('()');
    const tail = src.slice(call);
    return (
        /process\.exitCode\s*=\s*[1-9]/.test(tail) ||
        /process\.exit\(\s*[1-9]/.test(tail) ||
        /\.catch\([^)]*\{[\s\S]*\bthrow\b/.test(tail)
    );
}

describe('every seeder fails loudly', () => {
    const entrypoints = seedEntrypoints();

    it('finds the seed entrypoints (not vacuous)', () => {
        // Every assertion below passes on an empty list — the same shape as the
        // bug. If a rename or a refactor blinds this scan, this notices.
        expect(entrypoints.length).toBeGreaterThanOrEqual(4);
        expect(entrypoints).toContain('prisma/seed.ts');
    });

    it('sets a non-zero exit code when the seed throws', () => {
        const silent = entrypoints.filter(
            (rel) => !failsLoudly(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
        );
        expect(silent).toEqual([]);
    });

    it('no seeder hands its rejection straight to console.error', () => {
        // The exact spelling that caused it. Named separately from the check
        // above so the failure says what is wrong rather than only that
        // something is: `.catch(console.error)` reads like error handling and
        // is its absence.
        const swallowing = entrypoints.filter((rel) =>
            /\.catch\(\s*console\.(error|warn|log)\s*\)/.test(
                fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
            ),
        );
        expect(swallowing).toEqual([]);
    });
});
