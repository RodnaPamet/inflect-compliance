/**
 * A fixture that carries authored tasks has something that DELIVERS them.
 *
 * ═══ THE BUG THIS GENERALISES ═══
 *
 * 865 authored control tasks shipped into `internal-controls.json` and reached
 * no database. The seed loop read that fixture through an `as` cast whose type
 * had no `tasks` field, so the content was dropped at the type boundary, and
 * every gate that certified it — a conformance test, an actionability ratchet,
 * 24 green CI checks — was reading the same JSON the seeder discarded.
 *
 * That was fixed for one fixture. This is the check that stops the NEXT one:
 * `TSC-` (29), `SDLC-` (19), `CIS-` (15), `ASVS-` (13) and `PIMS-` (10) are all
 * queued for authoring, and each would land in a fixture file with exactly the
 * same silence available to it.
 *
 * ═══ WHY IT SCANS THE SEEDER RATHER THAN THE DATABASE ═══
 *
 * A guardrail cannot reach a database — DB-requiring tests belong in
 * `tests/integration`, and one lives there
 * (`control-template-task-delivery.test.ts`) proving rows actually land. This
 * is the cheaper companion, and it answers a different question: not "do these
 * tasks arrive?" but "is this fixture WIRED to anything at all?" A fixture
 * nobody references cannot be caught by a delivery test that never loads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');
const SEEDER = path.join(REPO_ROOT, 'scripts/seed-control-template-tasks.ts');
/**
 * The second delivery path. `seed-control-template-tasks.ts` writes tasks onto
 * templates that already exist; `seed-framework-catalogs.ts` applies a whole
 * CatalogFile — framework, requirements, templates, links and pack — for a
 * framework production may never have seen. A fixture delivered by either is
 * delivered, so both count as wiring here.
 */
const CATALOG_SEEDER = path.join(REPO_ROOT, 'scripts/seed-framework-catalogs.ts');

/** Fixture files referenced by the standalone prod seeder. */
const seederSource = [SEEDER, CATALOG_SEEDER]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

/**
 * Fixtures whose authored tasks reach no production database, with the reason.
 *
 * A DOWNWARD RATCHET. These five were found by this guardrail on its first run
 * — 205 authored tasks nobody knew were undelivered — and they are listed
 * rather than fixed here because the fix is not wiring: production carries none
 * of their TEMPLATES either. `TSC-`, `SDLC-`, `CIS-`, `ASVS-` and `PIMS-` do
 * not exist in prod at all, because its catalogue was built by
 * `seed-catalog.ts` / `framework-import` from `src/data/libraries/*.yaml`,
 * which is a different population from these fixtures. Delivering their tasks
 * means first deciding to put 86 new templates into a customer-facing
 * catalogue, which is a product decision and not a wiring one.
 *
 * Shrink this list. Do not grow it: a NEW fixture that gains authored tasks
 * must be wired, because nothing about it is hard.
 */
const KNOWN_UNDELIVERED: Record<string, string> = {
    'ssdf-control-templates.json': 'SDLC- (19 templates, 42 tasks). No SDLC- template exists in prod.',
    'cis-v8-ig1-control-templates.json': 'CIS- (15 templates, 30 tasks). No CIS- template exists in prod.',
    'asvs-l1-control-templates.json': 'ASVS- (13 templates, 26 tasks). No ASVS- template exists in prod.',
    'iso27701-control-templates.json': 'PIMS- (10 templates, 20 tasks). No PIMS- template exists in prod.',
};

/** Every fixture that carries at least one authored task. */
function fixturesWithAuthoredTasks(): Array<{ file: string; tasks: number }> {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .flatMap((file) => {
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
            } catch {
                return [];
            }
            const obj = (raw ?? {}) as { controls?: unknown[]; templates?: unknown[] };
            const list = (Array.isArray(raw) ? raw : (obj.controls ?? obj.templates ?? [])) as Array<{
                tasks?: unknown[];
            }>;
            const tasks = list.reduce(
                (n, e) => n + (Array.isArray(e?.tasks) ? e.tasks.length : 0),
                0,
            );
            return tasks > 0 ? [{ file, tasks }] : [];
        });
}

describe('authored tasks have a delivery path', () => {
    const authored = fixturesWithAuthoredTasks();

    it('the scan finds the fixtures that carry tasks (not vacuous)', () => {
        // Every assertion below is trivially satisfied by an empty list, which
        // is the shape of the original bug: nothing delivered, nothing
        // complained. If a fixture rename or a shape change blinds this scan,
        // this is what notices.
        expect(authored.length).toBeGreaterThan(0);
    });

    it('every fixture carrying authored tasks is referenced by the prod seeder', () => {
        // The seeder is what runs on a production deploy. A fixture it does not
        // name is content that reaches dev and CI at best, and in the original
        // bug reached neither.
        const unreferenced = authored
            .filter(({ file }) => !seederSource.includes(file) && !KNOWN_UNDELIVERED[file])
            .map(({ file, tasks }) => `${file} (${tasks} authored tasks, delivered by nothing)`);
        expect(unreferenced).toEqual([]);
    });

    it('the seeder names no fixture that has stopped carrying tasks', () => {
        // The reverse rot: a fixture wired for delivery whose tasks were
        // removed. Harmless at runtime, but it makes the wiring list a claim
        // about content that is no longer true.
        // Only TEMPLATE fixtures. The seeder also names
        // `internal-controls-policy-framework-map.json`, which carries the
        // policy -> framework mapping and no templates at all; asking whether
        // it has authored tasks is a category error.
        const named = fs
            .readdirSync(FIXTURE_DIR)
            .filter((f) => f.endsWith('.json') && seederSource.includes(f))
            .filter((f) => {
                try {
                    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8'));
                    const obj = (raw ?? {}) as { controls?: unknown[]; templates?: unknown[] };
                    const list = (Array.isArray(raw) ? raw : (obj.controls ?? obj.templates ?? [])) as Array<{
                        code?: unknown;
                    }>;
                    return list.some((e) => typeof e?.code === 'string');
                } catch {
                    return false;
                }
            });
        const withTasks = new Set(authored.map((a) => a.file));
        expect(named.filter((f) => !withTasks.has(f))).toEqual([]);
    });

    it('every exempt fixture is real, still undelivered, and still carries tasks', () => {
        // Three ways an entry here can become a lie, all worth catching: the
        // file is gone, it has since been wired up, or its tasks were removed.
        const withTasks = new Set(authored.map((a) => a.file));
        const stale = Object.keys(KNOWN_UNDELIVERED).filter(
            (f) =>
                !fs.existsSync(path.join(FIXTURE_DIR, f)) ||
                seederSource.includes(f) ||
                !withTasks.has(f),
        );
        expect(stale).toEqual([]);
    });

    it('records how much authored content is undelivered, so it stays visible', () => {
        // 205 tasks across five fixtures. This number only goes down.
        const undelivered = authored
            .filter(({ file }) => KNOWN_UNDELIVERED[file])
            .reduce((n, a) => n + a.tasks, 0);
        expect(Object.keys(KNOWN_UNDELIVERED)).toHaveLength(4);
        expect(undelivered).toBe(118);
    });
});
