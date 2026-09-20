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
    CatalogTemplateSchema,
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

describe('the three projecting fields survive the whole chain', () => {
    /**
     * `objective`, `successCriteria` and `testingMethodology` are the ONLY prose
     * a Control can inherit from its template — `ControlTemplateProjectionSource`
     * declares exactly those three and not `description`, because `Control` has
     * no description column.
     *
     * Every link in that chain was independently broken until #2664:
     *
     *   fixture   -> CatalogTemplateSchema   did not declare them, and Zod
     *                                        STRIPS unknown keys, so they were
     *                                        gone before anything saw them
     *   schema    -> catalog-applier         never wrote them, on create or
     *                                        on an existing row
     *   template  -> Control                 projection was fine, and had
     *                                        nothing to carry
     *
     * The middle two are visible in a diff. The first is not: a fixture author
     * would have added the fields, seen green, and shipped nothing. That is what
     * this asserts.
     */
    it('the loader schema preserves them rather than silently stripping them', () => {
        const parsed = CatalogTemplateSchema.parse({
            code: 'RT-1',
            title: 'Round trip',
            category: 'Test',
            objective: 'To establish the thing the control exists to establish.',
            successCriteria: 'The register exists and every row carries an owner.',
            testingMethodology: 'Evidence:\nObtain the register and sample ten rows.',
        });
        expect(parsed.objective).toBe('To establish the thing the control exists to establish.');
        expect(parsed.successCriteria).toBe('The register exists and every row carries an owner.');
        expect(parsed.testingMethodology).toContain('Evidence:');
    });

    it('the applier writes them on create and one-way fills them on an existing row', () => {
        // Source-level, because the DB round trip lives in
        // tests/integration/framework-catalog-delivery.test.ts. Comments are
        // stripped first: this file's own prose names all three fields, so a
        // raw match would pass on the explanation rather than the code.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'prisma/catalog-applier.ts'), 'utf-8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const field of ['objective', 'successCriteria', 'testingMethodology']) {
            // written on create
            expect(code).toContain(`${field}: t.${field} ?? null`);
            // and filled on an existing row, only when it is empty
            expect(code).toContain(`existing.${field} == null && t.${field}`);
        }
    });

    it('the projection still carries exactly these three', () => {
        // If a fourth prose field is ever added to Control, this is where the
        // omission shows up — the projection is the single seam and this list
        // is the claim about it.
        const src = fs.readFileSync(
            path.join(REPO_ROOT, 'src/app-layer/usecases/control/template-projection.ts'),
            'utf-8',
        );
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).toContain('objective: template.objective');
        expect(code).toContain('successCriteria: template.successCriteria');
        expect(code).toContain('testingMethodology: template.testingMethodology');
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
