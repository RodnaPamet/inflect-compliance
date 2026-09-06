/**
 * Every control-template fixture the repo ships can actually arrive in
 * production.
 *
 * ═══ WHY THIS IS NOT THE GUARD NEXT DOOR ═══
 *
 * `authored-tasks-are-delivered.test.ts` asks whether a fixture carrying
 * authored tasks is REFERENCED by a production seeder. That is a wiring
 * question, and wiring is not arrival.
 *
 * Measured on 2026-09-06 by seeding two clean databases — one by
 * `prisma/seed.ts`, one by the five seeders `scripts/entrypoint.sh` runs — and
 * diffing them:
 *
 *   Framework                       dev 17   prod  5
 *   ControlTemplate                 dev 512  prod 237
 *   FrameworkRequirement            dev 1134 prod 262
 *   ControlTemplateRequirementLink  dev 1912 prod 287
 *
 * Both fixtures that proved the point have since left. `dora-` and `nis2-`
 * were each named by the task seeder, so the wiring guard was green for them,
 * while their templates were created by neither production seeder — on a fresh
 * database the task seeder found nothing to attach to and said so, still
 * exiting 0:
 *
 *   DORA: 133 authored -> created 0 ⚠ 24 template(s) absent
 *   NIS2: 105 authored -> created 0 ⚠ 20 template(s) absent
 *
 * 238 authored tasks, zero rows, exit code 0. That is the same defect the
 * neighbouring guard exists to prevent, committed one level up by the guard
 * itself — it proved the reference and not the consequence.
 *
 * Read "fresh database" strictly. Live production HELD those 238 rows, because
 * its templates were put there by a one-off backfill years after the seeders
 * were written, so the task seeder found them. The exposure was never today's
 * data; it was a fresh deploy or a restore. The catalogue was not reproducible
 * from the repo, only recoverable from a database that already had it.
 *
 * Both are now CatalogFiles applied by scripts/seed-framework-catalogs.ts, so
 * one writer creates the templates and reconciles the tasks together and they
 * cannot come apart again.
 *
 * ═══ WHAT DELIVERS A TEMPLATE IN PRODUCTION ═══
 *
 * Exactly two things, and the prod image bundles only these:
 *   • `scripts/seed-framework-catalogs.ts` — applies a CatalogFile, creating
 *     the framework, requirements, templates, links and pack together.
 *   • `seedInternalControls`, called by `scripts/seed-control-template-tasks.ts`
 *     for `internal-controls.json` only.
 *
 * `prisma/seed.ts` is NOT one of them: it is not run on production deploys.
 * Neither is `scripts/backfill-framework-catalog.mjs`, a completed one-off that
 * nothing invokes — production holds the rest of its catalogue because a human
 * ran that once, which is not a delivery path.
 *
 * ═══ WHAT THIS CANNOT SEE ═══
 *
 * Populations `prisma/seed.ts` generates INLINE reach no fixture, so a
 * fixture-keyed scan is blind to them by construction — ISO 27001 Annex A (93
 * templates) among them. Naming that limit here rather than implying full
 * coverage: the companion `tests/integration/catalogue-parity.test.ts` seeds
 * both paths and diffs, which is the only check that sees everything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';
import { callExpressionOf, declarationOf } from '../helpers/source-blocks';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');
const CATALOG_SEEDER = path.join(REPO_ROOT, 'scripts/seed-framework-catalogs.ts');
const TASK_SEEDER = path.join(REPO_ROOT, 'scripts/seed-control-template-tasks.ts');

/**
 * The one fixture whose templates a seeder other than the catalog seeder
 * creates. `seedInternalControls` writes templates, policy links and tasks
 * together for this file and no other.
 */
const INTERNAL_CONTROLS = 'internal-controls.json';

/**
 * Template fixtures with no production delivery path, and the reason.
 *
 * A DOWNWARD RATCHET, and its end state is empty. Each entry is a framework a
 * fresh production database would simply not have. Closing one means giving it
 * a real path — reshaping the fixture into a CatalogFile and adding it to
 * `CATALOG_FIXTURES` — not deleting the line.
 *
 * Do not add an entry to make this pass. A NEW template fixture with no
 * delivery path is the bug this file is named for.
 */
const TEMPLATES_UNDELIVERED: Record<string, string> = {
    'iso9001-control-templates.json':
        'ISO 9001. Bare-array fixture, no prod path. Frozen for content (no source library) but the DELIVERY gap is independent of that.',
    'iso28000-control-templates.json': 'ISO 28000. As ISO 9001.',
    'iso39001-control-templates.json': 'ISO 39001. As ISO 9001.',
};

/** Fixtures listed in CATALOG_FIXTURES in the catalog seeder. */
function catalogFixtures(): Set<string> {
    const src = fs.readFileSync(CATALOG_SEEDER, 'utf8');
    const block = src.slice(src.indexOf('CATALOG_FIXTURES'));
    const names = new Set<string>();
    for (const m of block.matchAll(/prisma\/fixtures\/([A-Za-z0-9._-]+\.json)/g)) names.add(m[1]);
    return names;
}

/** Every fixture that declares at least one control-template code. */
function templateFixtures(): Array<{ file: string; codes: number }> {
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
            const list = (Array.isArray(raw) ? raw : (obj.templates ?? obj.controls ?? [])) as Array<{
                code?: unknown;
            }>;
            const codes = list.filter((t) => typeof t?.code === 'string').length;
            return codes > 0 ? [{ file, codes }] : [];
        });
}

describe('the shipped catalogue can reach production', () => {
    const fixtures = templateFixtures();
    const delivered = catalogFixtures();

    it('the scan sees template fixtures at all (denominator, not findings)', () => {
        // Every assertion below is satisfied by an empty list, which is the
        // shape of the bug one level up: a scan that stops matching reports a
        // clean bill of health for the subset it still understands.
        expect(fixtures.length).toBeGreaterThanOrEqual(10);
        expect(fixtures.reduce((n, f) => n + f.codes, 0)).toBeGreaterThan(300);
    });

    it('the catalog seeder names fixtures that exist and carry templates', () => {
        // A name in CATALOG_FIXTURES that matches no template-carrying fixture
        // is a delivery path to nothing, and would make the check below pass
        // for a framework that ships nothing.
        const carry = new Set(fixtures.map((f) => f.file));
        const bogus = [...delivered].filter(
            (f) => !fs.existsSync(path.join(FIXTURE_DIR, f)) || !carry.has(f),
        );
        expect(bogus).toEqual([]);
    });

    it('every template fixture has a production delivery path', () => {
        const orphans = fixtures
            .filter(({ file }) => file !== INTERNAL_CONTROLS && !delivered.has(file))
            .filter(({ file }) => !TEMPLATES_UNDELIVERED[file])
            .map(({ file, codes }) => `${file} (${codes} templates, no prod path)`);
        expect(orphans).toEqual([]);
    });

    it('seedInternalControls really is the internal-controls path', () => {
        // The exemption above is only honest while this holds. If the task
        // seeder stops calling seedInternalControls, internal-controls.json
        // joins the orphans and must not stay silently exempt.
        //
        // Both needles are bound to a construct rather than to the whole file.
        // `callExpressionOf` THROWS when the call is gone, so a rename fails
        // loudly instead of leaving a `toContain` to be satisfied by some
        // unrelated mention elsewhere in the seeder — the Class D shape this
        // repo ratchets down.
        const src = fs.readFileSync(TASK_SEEDER, 'utf8');
        expect(callExpressionOf(src, 'seedInternalControls')).toContain('FIXTURE');
        expect(declarationOf(src, 'FIXTURE')).toContain(INTERNAL_CONTROLS);
    });

    it('every exemption is real, still undelivered, and still carries templates', () => {
        const carry = new Map(fixtures.map((f) => [f.file, f.codes]));
        const stale = Object.keys(TEMPLATES_UNDELIVERED).filter(
            (f) =>
                !fs.existsSync(path.join(FIXTURE_DIR, f)) ||
                delivered.has(f) ||
                !carry.get(f),
        );
        expect(stale).toEqual([]);
    });

    it('records how many templates cannot reach production, so it stays visible', () => {
        // 54 across three fixtures — the frozen ISO 9001 / 28000 / 39001 sets.
        // Was 98 across five; DORA (24) and NIS2 (20) left by being reshaped
        // into CatalogFiles and wired into CATALOG_FIXTURES. Only ever down.
        //
        // What remains is a different problem from the one this ratchet
        // measures. Those three have no source library, so they are frozen for
        // CONTENT in control-task-actionability; delivering them would ship 54
        // templates whose every task is a generic placeholder. Delivery and
        // content are separate axes and this number speaks only to the first.
        const carry = new Map(fixtures.map((f) => [f.file, f.codes]));
        const undelivered = Object.keys(TEMPLATES_UNDELIVERED).reduce(
            (n, f) => n + (carry.get(f) ?? 0),
            0,
        );
        expect(Object.keys(TEMPLATES_UNDELIVERED).length).toBeLessThanOrEqual(3);
        expect(undelivered).toBeLessThanOrEqual(54);
    });
});
