/**
 * Epic 41 — backfill default dashboard widgets for existing orgs.
 *
 * One-time script. For every Organization in the DB whose
 * `OrgDashboardWidget` count is zero, insert the default preset
 * via `seedDefaultOrgDashboard`. Idempotent: orgs that already
 * have any widget (including from a partial prior run, or from
 * manual configuration) are left untouched — never duplicated.
 *
 * ## Deployment order
 *   1. `prisma migrate deploy` lands the `OrgDashboardWidget` table
 *      (Epic 41 prompt 1 migration `20260430101500_…`).
 *   2. Deploy the application code (creates new orgs with the seed
 *      already wired — see `src/app/api/org/route.ts`).
 *   3. Run this script once on prod with `--execute` to backfill the
 *      orgs that pre-date the wiring.
 *
 * ## Why a script and not a SQL data migration?
 *   The widget rows depend on the `DEFAULT_ORG_DASHBOARD_PRESET`
 *   constant which lives in TypeScript with proper Zod typing. A
 *   raw SQL data migration would duplicate the preset structure as
 *   bare INSERTs, drifting from the typed source over time. The
 *   script imports the real seeder so a future preset update
 *   automatically flows through to the next backfill.
 *
 * ## Usage
 *   npm run db:backfill-org-widgets             # dry-run (default)
 *   npm run db:backfill-org-widgets -- --execute # write
 *
 * ## Safety
 *   Default mode is DRY-RUN: counts the orgs that would be seeded
 *   without writing anything. Pass `--execute` to actually insert
 *   the preset rows. The script prints a per-org summary either way.
 */

process.env.SKIP_ENV_VALIDATION = '1';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { seedDefaultOrgDashboard } from '../src/app-layer/usecases/org-dashboard-presets';

interface OrgRow {
    id: string;
    slug: string;
    widgetCount: number;
}

async function main(): Promise<void> {
    const execute = process.argv.includes('--execute');
    const mode = execute ? 'EXECUTE' : 'DRY RUN';

    console.log(`\n── Epic 41 — backfill-org-dashboard-widgets — ${mode} ──\n`);
    if (!execute) {
        console.log('  No writes performed. Rerun with --execute to persist.\n');
    }

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
    let seeded = 0;
    let skipped = 0;
    let totalCreated = 0;

    try {
        const orgs = await prisma.organization.findMany({
            select: {
                id: true,
                slug: true,
                _count: { select: { dashboardWidgets: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        const rows: OrgRow[] = orgs.map((o) => ({
            id: o.id,
            slug: o.slug,
            widgetCount: o._count.dashboardWidgets,
        }));

        console.log(`  Found ${rows.length} organisation(s).\n`);

        for (const row of rows) {
            if (row.widgetCount > 0) {
                console.log(
                    `  · ${row.slug.padEnd(36)} skipped — already has ${row.widgetCount} widget(s)`,
                );
                skipped++;
                continue;
            }

            if (!execute) {
                console.log(
                    `  + ${row.slug.padEnd(36)} would seed 8 default widgets`,
                );
                seeded++;
                continue;
            }

            const result = await seedDefaultOrgDashboard(prisma, row.id);
            if (result.seeded) {
                console.log(
                    `  + ${row.slug.padEnd(36)} seeded ${result.created} widget(s)`,
                );
                seeded++;
                totalCreated += result.created;
            } else {
                // Race: a parallel process inserted between our
                // count read and the seeder's count check. Skipped
                // to preserve idempotency.
                console.log(
                    `  · ${row.slug.padEnd(36)} skipped — race with concurrent writer`,
                );
                skipped++;
            }
        }

        console.log(
            `\n── Summary ─────────────────────────────────────────`,
        );
        console.log(`  Orgs total       : ${rows.length}`);
        console.log(`  Orgs seeded      : ${seeded}${execute ? '' : ' (would seed)'}`);
        console.log(`  Orgs skipped     : ${skipped}`);
        if (execute) {
            console.log(`  Widgets inserted : ${totalCreated}`);
        }
        console.log('');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    // Print the error but exit with non-zero so any orchestrator
    // (CI, Watchtower, manual operator) sees the failure.
    console.error('\nbackfill-org-dashboard-widgets failed:', err);
    process.exit(1);
});
