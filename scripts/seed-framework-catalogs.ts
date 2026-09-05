/**
 * Standalone, idempotent seeder for CATALOG-SHAPED framework fixtures.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `seed-control-template-tasks.ts` delivers authored TASKS onto templates that
 * already exist. That is enough for DORA and NIS2, whose templates production
 * already carries. It is not enough for a framework production has never seen:
 * `applyCatalogFile` is the only function that creates a Framework, its
 * FrameworkRequirements, the ControlTemplates, their requirement links AND a
 * FrameworkPack together, in that order, with cross-validation first.
 *
 * Until now its ONLY non-test caller was `scripts/framework-import.ts`, a
 * manual operator CLI. So a framework could be fully described in the repo and
 * still reach no environment unless somebody remembered to run a command —
 * which is how production ended up with a catalogue that diverges from the
 * fixtures by 133 templates in one direction and 237 in the other.
 *
 * ═══ VALIDATE EVERYTHING, THEN APPLY ═══
 *
 * Every file is loaded and cross-validated BEFORE any of them is applied, so a
 * typo in the third file cannot leave the first two half-applied. This mirrors
 * `assertCatalogConsistency`, which `applyCatalogFile` runs before its own
 * writes for the same reason at one level down.
 *
 * ═══ SAFE TO RE-RUN, ON PRODUCTION ═══
 *
 * `applyCatalogFile` upserts throughout, and its task writes go through
 * `reconcileTemplateTasks` — contentHash-keyed, update-in-place,
 * deprecate-by-absence, never delete. A second run reports every task
 * unchanged.
 *
 *   tsx scripts/seed-framework-catalogs.ts              (npm run db:seed-catalogs)
 *   tsx scripts/seed-framework-catalogs.ts --dry-run    validate only, no writes
 *
 * `--dry-run` exists because the validate phase is the half most likely to fail
 * on a fixture edit, and it needs no database — so a fixture can be checked
 * before it is anywhere near production.
 */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadAndValidateCatalogFile } from '../prisma/catalog-loader';
import { applyCatalogFile } from '../prisma/catalog-applier';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

/**
 * Catalog-shaped fixtures, applied in order.
 *
 * A fixture belongs here when production may not already have its framework —
 * otherwise `seed-control-template-tasks.ts` is the cheaper path, since it
 * touches only tasks. Add a file here and
 * `tests/guardrails/catalog-fixtures-are-delivered.test.ts` stops failing for
 * it; forget to, and it fails until you do.
 */
const CATALOG_FIXTURES = [
    'prisma/fixtures/soc2-control-templates.json',
    'prisma/fixtures/ssdf-control-templates.json',
    'prisma/fixtures/cis-v8-ig1-control-templates.json',
    'prisma/fixtures/asvs-l1-control-templates.json',
    'prisma/fixtures/iso27701-control-templates.json',
];

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
    console.log(`🌱 Seeding framework catalogs${DRY_RUN ? ' (dry run — validate only)' : ''}...`);

    // Phase 1 — load and cross-validate EVERY file before writing anything.
    const loaded = CATALOG_FIXTURES.map((rel) => {
        const abs = path.resolve(process.cwd(), rel);
        return { rel, abs, file: loadAndValidateCatalogFile(abs) };
    });
    console.log(`  validated ${loaded.length} catalog file(s)`);

    if (DRY_RUN) {
        for (const { rel, file } of loaded) {
            console.log(
                `  ✓ ${rel}: ${file.framework.key}, ${file.requirements.length} requirements, ` +
                    `${file.templates.length} templates, ` +
                    `${file.templates.reduce((n, t) => n + t.tasks.length, 0)} authored tasks` +
                    (file.pack ? `, pack ${file.pack.key}` : ''),
            );
        }
        console.log('✅ Validation passed. No writes attempted.');
        return;
    }

    // Phase 2 — apply.
    for (const { rel, abs, file } of loaded) {
        const r = await applyCatalogFile(prisma, file, abs);
        console.log(
            `  ✓ ${rel}: framework ${r.framework.key} (${r.framework.created ? 'created' : 'existing'}), ` +
                `${r.requirements.upserted} requirements, ` +
                `${r.templates.created} templates created / ${r.templates.existing} existing` +
                (r.pack ? `, pack ${r.pack.key} (${r.pack.templatesLinked} linked)` : ''),
        );
    }

    console.log('✅ Framework catalogs seeded.');
}

main()
    .catch((err) => {
        console.error('❌ Framework-catalog seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
