/**
 * Standalone, idempotent seeder for the global POLICY-TEMPLATE library.
 *
 * Same rationale as `seed-self-assessments.ts`: the ~45 global `PolicyTemplate`
 * rows are populated from vendored fixtures by `prisma/seed.ts`, which prod
 * deploys do NOT run (the entrypoint runs `prisma migrate deploy` + targeted
 * seeders only). So new templates added to a fixture never reach an
 * already-seeded environment. This seeder upserts ONLY the global template
 * fixtures (ciso-toolkit MIT + imported + IC-original gap-fill), keyed by
 * `externalRef` OR `title` exactly like `prisma/seed.ts`, so it is safe to run
 * on any environment (including production) and safe to re-run. Wire it into the
 * container entrypoint so the library self-heals on every deploy.
 *
 *   tsx scripts/seed-policy-templates.ts   (npm run db:seed-policy-templates)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fixtureObject } from '../prisma/fixture-io';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

interface TemplateFixture {
    templates: Array<{
        externalRef: string;
        title: string;
        category: string;
        language: string;
        contentType: string;
        contentText: string;
        tags: string;
        source: string;
    }>;
}

// esbuild inlines these JSON fixtures into the bundle at build time, so the
// runtime image needs no fixture files present.
const FIXTURES: Array<{ label: string; data: TemplateFixture }> = [
    {
        label: 'ciso-toolkit',
        data: fixtureObject<TemplateFixture>(
            'fixtures/policy-templates-ciso-toolkit',
            require('../prisma/fixtures/policy-templates-ciso-toolkit.json'),
            'templates',
        ),
    },
    {
        label: 'imported',
        data: fixtureObject<TemplateFixture>(
            'fixtures/policy-templates-imported',
            require('../prisma/fixtures/policy-templates-imported.json'),
            'templates',
        ),
    },
    {
        label: 'original-gaps',
        data: fixtureObject<TemplateFixture>(
            'fixtures/policy-templates-original-gaps',
            require('../prisma/fixtures/policy-templates-original-gaps.json'),
            'templates',
        ),
    },
];

async function main(): Promise<void> {
    console.log('🌱 Seeding global policy-template library...');
    let created = 0;
    let updated = 0;
    for (const { label, data } of FIXTURES) {
        for (const t of data.templates) {
            const payload = {
                title: t.title,
                category: t.category,
                language: t.language,
                contentType: t.contentType as 'MARKDOWN',
                contentText: t.contentText,
                tags: t.tags,
                isGlobal: true,
                source: t.source,
                externalRef: t.externalRef,
            };
            const existing = await prisma.policyTemplate.findFirst({
                where: { OR: [{ externalRef: t.externalRef }, { title: t.title }] },
            });
            if (existing) {
                await prisma.policyTemplate.update({ where: { id: existing.id }, data: payload });
                updated += 1;
            } else {
                await prisma.policyTemplate.create({ data: payload });
                created += 1;
            }
        }
        console.log(`  ✓ ${label}: ${data.templates.length} templates`);
    }
    const total = await prisma.policyTemplate.count();
    console.log(`✅ Policy templates seeded (created ${created}, updated ${updated}; total ${total}).`);
}

main()
    .catch((err) => {
        console.error('❌ Policy-template seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
