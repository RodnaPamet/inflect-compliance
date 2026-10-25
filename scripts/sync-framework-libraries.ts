/**
 * Idempotent sync of the YAML framework libraries and the cross-framework
 * mapping sets in `src/data/libraries/`, run at every container start.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `syncAllLibraries` is the only writer of library framework rows and of
 * `RequirementMapping`, and until this script nothing in a deployed environment
 * called it: not the entrypoint, not a job, not a workflow. So the crosswalks
 * the repo ships (ISO 27001 ⇄ AIUC-1, SOC 2 ⇄ ISO 27001, …) and every surface
 * that reads them — inherited coverage on a framework page, gap analysis,
 * traceability — reached tests and any database somebody had synced by hand,
 * and no other.
 *
 * ═══ WHAT IT WRITES, AND WHAT IT LEAVES ALONE ═══
 *
 * Runs AFTER `seed-framework-catalogs.ts` in `scripts/entrypoint.sh`, for two
 * reasons: mapping sets that cite a catalogue-owned framework (`AIUC-1`)
 * resolve against the row the catalogue just wrote, and "has a pack" is how
 * `syncLibrariesAtStartup` tells a catalogue row from a library row, so the
 * catalogue must have written its packs first. A library whose framework row
 * the catalogue owns is not imported; see that function for why.
 *
 * Unchanged libraries and mapping sets are skipped on their content hash, so
 * a second run writes nothing. A library version bump propagates a framework
 * delta to installed tenants, as the importer always has.
 *
 *   tsx scripts/sync-framework-libraries.ts      (npm run db:sync-libraries)
 *
 * ═══ HOW IT EXITS ═══
 *
 * Explicitly, with `process.exit`. The delta propagation reads through the
 * app's Prisma client, not the one created here, so a run that propagated a
 * delta would otherwise leave that pool open and hold the container start.
 */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { prisma as appPrisma } from '@/lib/prisma';
import { syncLibrariesAtStartup } from '@/app-layer/usecases/library-sync';
import { scanMappingSetDirectory } from '@/app-layer/services/mapping-set-importer';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

async function main(): Promise<number> {
    console.log('🌱 Syncing framework libraries and mapping sets...');

    const librariesDir = path.resolve(process.cwd(), 'src/data/libraries');
    const mappingsDir = path.join(librariesDir, 'mappings');
    const result = await syncLibrariesAtStartup(prisma, { librariesDir, mappingsDir });

    const { summary, mappingSets } = result;
    console.log(
        `  ✓ libraries: ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged` +
            ` (left to the catalogue: ${result.catalogueOwnedKeys.length} row(s))`,
    );

    // The importer logs a set it cannot import and moves on, so a set that
    // failed is only visible as one missing from the results. Counted against
    // the files on disk, and a non-zero exit, so the entrypoint says so.
    const onDisk = scanMappingSetDirectory(mappingsDir).length;
    const notImported = onDisk - mappingSets.results.length;
    console.log(
        `  ${notImported > 0 ? '⚠' : '✓'} mapping sets: ${mappingSets.summary.imported} imported, ` +
            `${mappingSets.summary.skipped} unchanged, ${notImported} failed of ${onDisk}, ` +
            `${mappingSets.summary.totalEntries} entries written, ` +
            `${mappingSets.summary.retired} retired (their entry left its file), ` +
            `${mappingSets.summary.failed} entries unresolved (the importer logs each)`,
    );
    if (notImported > 0) return 1;

    console.log('✅ Framework libraries synced.');
    return 0;
}

main()
    .catch((err) => {
        console.error('❌ Framework-library sync failed:', err);
        return 1;
    })
    .then(async (code) => {
        await Promise.allSettled([prisma.$disconnect(), appPrisma.$disconnect()]);
        process.exit(code);
    });
