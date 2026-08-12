/**
 * B3-5 (a) / B3-6 — the task repository layer exposes ONE seam, under the
 * canonical name.
 *
 * B3-5 deleted a five-line `@deprecated` re-export that bound a second name
 * to the same class. A second name is not free: it lets two call sites
 * believe they are talking to different repositories, and it kept the
 * `WorkItem` → `Task` rename half-finished indefinitely.
 *
 * B3-6 then finished that rename, which INVERTS which name is the smell.
 * `TaskRepository` is now the class and the filename; the name that must
 * not come back is `WorkItemRepository`. Re-introducing it — as a
 * compatibility shim, or by a partial revert — puts the layer back in the
 * two-names state this pair of changes exists to end.
 *
 * This test loads every module in the repositories layer and inspects the
 * RUNTIME exports — not the source text. It fails if either regression
 * returns:
 *
 *   1. an export literally named `WorkItemRepository`, or
 *   2. any two exported classes across the layer that are the SAME object
 *      identity under two different names (the general aliasing case).
 *
 * The second assertion is what makes this durable: re-adding the alias
 * under some other name (`WorkItemRepo`, `IssueRepository`, …) still fails.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_DIR = path.resolve(__dirname, '../../src/app-layer/repositories');

describe('task repository seam', () => {
    /** Every exported binding in the layer: module file → export name → value. */
    let exportsByModule: Array<{ file: string; name: string; value: unknown }>;

    beforeAll(async () => {
        const files = fs
            .readdirSync(REPO_DIR)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

        // Parser sanity — if the directory read broke, every assertion
        // below would vacuously pass.
        expect(files.length).toBeGreaterThan(10);

        exportsByModule = [];
        for (const file of files) {
            const mod: Record<string, unknown> = await import(
                path.join(REPO_DIR, file)
            );
            for (const [name, value] of Object.entries(mod)) {
                exportsByModule.push({ file, name, value });
            }
        }
        expect(exportsByModule.length).toBeGreaterThan(10);
    });

    it('exports no binding named WorkItemRepository', () => {
        const offenders = exportsByModule
            .filter((e) => e.name === 'WorkItemRepository')
            .map((e) => `${e.file} exports '${e.name}'`);

        expect(offenders).toEqual([]);
    });

    /**
     * Aliases that exist today and are NOT part of this change.
     *
     * `src/app-layer/repositories/IssueRepository.ts` re-exports four
     * task classes under `Issue*` names. Unlike the re-export B3-5 deleted,
     * that file is load-bearing for the `/issues` API surface and is
     * asserted by `tests/unit/issue-guardrails.test.ts`, so removing it is
     * a separate decision from this one.
     *
     * This is a DOWNWARD ratchet: entries come off as the `Issue*` naming
     * is retired, and nothing new goes on. A `WorkItemRepository` alias is
     * deliberately absent — re-adding it fails this test.
     */
    const KNOWN_ALIASES: Record<string, string> = {
        'IssueRepository === TaskRepository':
            'IssueRepository.ts backs the /issues API surface; retiring the Issue* naming is tracked separately.',
        'IssueLinkRepository === TaskLinkRepository':
            'Same file as IssueRepository — retired together with the Issue* naming.',
        'IssueCommentRepository === TaskCommentRepository':
            'Same file as IssueRepository — retired together with the Issue* naming.',
        'IssueWatcherRepository === TaskWatcherRepository':
            'Same file as IssueRepository — retired together with the Issue* naming.',
    };

    it('introduces no NEW class aliasing across the repositories layer', () => {
        // Group every exported *function/class* value by object identity.
        const byIdentity = new Map<unknown, Set<string>>();
        for (const { name, value } of exportsByModule) {
            if (typeof value !== 'function') continue;
            if (!byIdentity.has(value)) byIdentity.set(value, new Set());
            byIdentity.get(value)!.add(name);
        }

        const aliased = [...byIdentity.values()]
            .filter((names) => names.size > 1)
            .map((names) => [...names].sort().join(' === '));

        const unexpected = aliased.filter((a) => !(a in KNOWN_ALIASES));
        expect(unexpected).toEqual([]);
    });

    it('has no stale KNOWN_ALIASES entries', () => {
        const byIdentity = new Map<unknown, Set<string>>();
        for (const { name, value } of exportsByModule) {
            if (typeof value !== 'function') continue;
            if (!byIdentity.has(value)) byIdentity.set(value, new Set());
            byIdentity.get(value)!.add(name);
        }
        const aliased = new Set(
            [...byIdentity.values()]
                .filter((names) => names.size > 1)
                .map((names) => [...names].sort().join(' === ')),
        );

        // A fixed alias must be deleted from the map in the same diff.
        const stale = Object.keys(KNOWN_ALIASES).filter((k) => !aliased.has(k));
        expect(stale).toEqual([]);

        // Every entry carries a real written reason.
        for (const reason of Object.values(KNOWN_ALIASES)) {
            expect(reason.length).toBeGreaterThan(20);
        }
    });

    it('TaskRepository is present and is the task seam', async () => {
        const mod = await import('@/app-layer/repositories/TaskRepository');
        expect(typeof mod.TaskRepository).toBe('function');
    });
});
