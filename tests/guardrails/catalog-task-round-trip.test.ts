/**
 * Every task that ships in a fixture must survive the catalogue loader, and
 * its content hash must be stable.
 *
 * WHY THIS IS THE USEFUL ASSERTION TODAY. There is no catalogue directory
 * yet: `framework-import.ts` takes a `--input` path, and the five curated
 * fixtures are still read by `require()` inside `seed.ts`. The loader exists
 * to replace that, so the thing worth protecting is the property that makes
 * the replacement possible — the content already on disk must parse under the
 * schema the loader will use.
 *
 * It is not hypothetical. `CatalogTaskSchema.steps` was specified as
 * `.min(3)`, and the 205 tasks these fixtures already carry have no steps at
 * all; a required `steps` would have made the loader unable to read the very
 * files it is migrating toward. This test is what says so out loud.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    CatalogTaskSchema,
    canonicalJson,
    taskContentHash,
} from '../../prisma/catalog-loader';
import { REPO_ROOT } from '../helpers/repo-files';

/** Fixture files that seed control templates. */
const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

interface FixtureTask {
    title?: unknown;
    description?: unknown;
}

function fixtureFiles(): string[] {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('control-templates.json'))
        .sort();
}

function tasksIn(file: string): Array<{ file: string; code: string; task: FixtureTask }> {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as unknown;
    const templates = (Array.isArray(raw) ? raw : ((raw as { templates?: unknown[] }).templates ?? [])) as Array<{
        code?: string;
        tasks?: FixtureTask[];
    }>;
    return templates.flatMap((t) =>
        (t.tasks ?? []).map((task) => ({ file, code: t.code ?? '(no code)', task })),
    );
}

describe('catalog task round trip', () => {
    const files = fixtureFiles();

    it('finds the fixtures it is supposed to be guarding', () => {
        // A scan that silently found nothing would pass every assertion below.
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    it('every task already on disk is readable by the loader schema', () => {
        const rejected: string[] = [];
        for (const file of files) {
            for (const { code, task } of tasksIn(file)) {
                // The legacy shape is a bare `{title, description}` string
                // pair; the loader's shape is locale maps. Both must load,
                // because the fixtures are mid-migration and will be for
                // several PRs yet.
                const asLocale = {
                    title: typeof task.title === 'string' ? { en: task.title } : task.title,
                    description:
                        typeof task.description === 'string'
                            ? { en: task.description }
                            : task.description,
                };
                if (!CatalogTaskSchema.safeParse(asLocale).success) {
                    rejected.push(`${file}:${code}`);
                }
            }
        }
        expect(rejected).toEqual([]);
    });

    it('counts the tasks it checked, so an empty scan cannot read as a pass', () => {
        const total = files.reduce((n, f) => n + tasksIn(f).length, 0);
        // 205 on the day this was written. A floor, not an equality: content
        // PRs add tasks, and this must not need editing every time they do.
        expect(total).toBeGreaterThanOrEqual(200);
    });
});

describe('content hash identity', () => {
    const task = {
        title: { en: 'Inventory the key-management lifecycle' },
        description: { en: 'Record every key, its owner and its rotation interval.' },
        phase: 'IMPLEMENT' as const,
        sortOrder: 2,
    };

    it('does not depend on key order', () => {
        // The reason `canonicalJson` exists rather than `JSON.stringify`.
        // Insertion order would make the same task hash differently depending
        // on how it was authored, so every re-apply would report every task as
        // changed and "changed" would stop meaning anything.
        const reordered = {
            sortOrder: task.sortOrder,
            phase: task.phase,
            description: task.description,
            title: task.title,
        };
        expect(canonicalJson(reordered)).toBe(canonicalJson(task));
        expect(taskContentHash(reordered)).toBe(taskContentHash(task));
    });

    it('is stable across repeated computation', () => {
        expect(taskContentHash(task)).toBe(taskContentHash(task));
    });

    it('changes when any authored field changes', () => {
        const base = taskContentHash(task);
        expect(taskContentHash({ ...task, phase: 'REVIEW' })).not.toBe(base);
        expect(taskContentHash({ ...task, sortOrder: 3 })).not.toBe(base);
        expect(taskContentHash({ ...task, title: { en: 'Something else' } })).not.toBe(base);
    });

    it('changes when only a non-English locale changes', () => {
        // The scalar columns carry `en`, so a Bulgarian-only edit writes
        // identical columns. It is still a change, and the reconcile has to
        // see it or the translation never lands.
        const withBg = { ...task, title: { en: task.title.en, bg: 'Инвентаризация' } };
        expect(taskContentHash(withBg)).not.toBe(taskContentHash(task));
    });
});
