/**
 * Standalone, idempotent seeder for the global RISK-TEMPLATE library's
 * fixture-backed sets.
 *
 * Same rationale as `seed-policy-templates.ts`: `prisma/seed.ts` is not run on
 * a production deploy, so a template that lives only there never reaches an
 * already-seeded environment. This seeder upserts the fixture-backed sets by
 * their stable `id`, so it is safe on any environment, including production,
 * and safe to re-run. It is wired into `scripts/entrypoint.sh`.
 *
 * Today that is the FINOS AI Governance Framework risks
 * (`prisma/fixtures/risk-templates-finos-aigf.json`). The older built-in sets
 * (generic, privacy, SSDF, CIS, ASVS) are still inline in `prisma/seed.ts`,
 * which several guards read; moving them here is a separate change.
 *
 *   tsx scripts/seed-risk-templates.ts   (npm run db:seed-risk-templates)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fixtureObject } from '../prisma/fixture-io';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export interface RiskTemplateFixture {
    templates: Array<{
        id: string;
        title: string;
        description: string;
        category: string;
        defaultLikelihood: number;
        defaultImpact: number;
        frameworkTag: string;
    }>;
}

// esbuild inlines the fixture JSON into the bundle at build time, so the
// runtime image needs no fixture files present.
const FIXTURES: Array<{ label: string; data: RiskTemplateFixture }> = [
    {
        label: 'finos-aigf',
        data: fixtureObject<RiskTemplateFixture>(
            'fixtures/risk-templates-finos-aigf',
            require('../prisma/fixtures/risk-templates-finos-aigf.json'),
            'templates',
        ),
    },
];

async function main(): Promise<void> {
    console.log('🌱 Seeding global risk-template library...');
    for (const { label, data } of FIXTURES) {
        for (const t of data.templates) {
            const { id, ...fields } = t;
            await prisma.riskTemplate.upsert({
                where: { id },
                create: { id, ...fields },
                update: fields,
            });
        }
        console.log(`  ✓ ${label}: ${data.templates.length} templates`);
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
