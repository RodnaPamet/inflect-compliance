/**
 * Standalone, idempotent seeder for the global RISK-TEMPLATE library.
 *
 * Same rationale as `seed-policy-templates.ts`: `prisma/seed.ts` is not run on
 * a production deploy, so a template written only there never reaches a
 * deployed database. This writes every built-in set
 * (`prisma/risk-template-fixtures.ts`), upserting by stable `id`, so it is safe
 * on any environment, including production, and safe to re-run. It is wired
 * into `scripts/entrypoint.sh`.
 *
 *   tsx scripts/seed-risk-templates.ts   (npm run db:seed-risk-templates)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { seedRiskTemplates } from '../prisma/risk-template-fixtures';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

async function main(): Promise<void> {
    console.log('🌱 Seeding global risk-template library...');
    for (const { label, count } of await seedRiskTemplates(prisma)) {
        console.log(`  ✓ ${label}: ${count} templates`);
    }
    const total = await prisma.riskTemplate.count();
    console.log(`✅ Risk templates seeded (total ${total}).`);
}

main()
    .catch((err) => {
        console.error('❌ Risk-template seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
