/**
 * Standalone, idempotent seeder for the built-in VENDOR-ASSESSMENT
 * questionnaire templates — the Supplier Due Diligence Questionnaire and the
 * Supplier Security Assessment.
 *
 * Why this exists as its own script (not just `prisma/seed.ts`):
 * `VendorAssessmentTemplate` is RLS-tenant-scoped, so the "global" baseline
 * questionnaires have to be materialised as a real (tenantId, key, version:1)
 * row PER TENANT. `prisma/seed.ts` seeds them into the demo tenant only, and
 * the full seed also provisions demo tenants/users so it is unsafe against
 * production. When these questionnaires are added after a prod DB is already
 * seeded, existing tenants would otherwise never receive them.
 *
 * This script seeds ONLY the two questionnaire templates, into EVERY tenant,
 * via a (tenantId, key, version) existence check, so it is safe to run on any
 * environment (including production) and safe to re-run. Run with:
 *   tsx scripts/seed-vendor-questionnaires.ts   (npm run db:seed-vendor-questionnaires)
 *
 * Connection: a plain PrismaClient connects as the `postgres` superuser, which
 * the RLS `superuser_bypass` policy admits — so per-tenant writes with an
 * explicit `tenantId` succeed WITHOUT `runInTenantContext`, mirroring how
 * `prisma/seed.ts` already writes these rows.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fixtureObject } from '../prisma/fixture-io';

// Prisma 7 — adapter is required for PrismaClient construction.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

type FixtureOption = { label: string; value: string; points: number };
type FixtureQuestion = {
    prompt: string;
    answerType: string;
    required: boolean;
    weight: number;
    options?: FixtureOption[];
    riskPoints?: Record<string, number>;
};
type FixtureSection = {
    title: string;
    description: string | null;
    weight: number;
    questions: FixtureQuestion[];
};
type Fixture = {
    key: string;
    name: string;
    description: string;
    scoringConfig: unknown;
    sections: FixtureSection[];
};

// require() so esbuild inlines the fixture JSON into the bundled entrypoint.
const FIXTURES: Fixture[] = [
    fixtureObject<Fixture>(
        'fixtures/vendor-questionnaire-supplier-due-diligence',
        require('../prisma/fixtures/vendor-questionnaire-supplier-due-diligence.json'),
        'sections',
    ),
    fixtureObject<Fixture>(
        'fixtures/vendor-questionnaire-supplier-security-assessment',
        require('../prisma/fixtures/vendor-questionnaire-supplier-security-assessment.json'),
        'sections',
    ),
];

async function seedFixtureForTenant(tenantId: string, fixture: Fixture): Promise<boolean> {
    const existing = await prisma.vendorAssessmentTemplate.findUnique({
        where: { tenantId_key_version: { tenantId, key: fixture.key, version: 1 } },
        select: { id: true },
    });
    if (existing) return false; // idempotent — already seeded for this tenant.

    const tpl = await prisma.vendorAssessmentTemplate.create({
        data: {
            tenantId,
            key: fixture.key,
            version: 1,
            isLatestVersion: true,
            isPublished: true,
            isGlobal: true,
            name: fixture.name,
            description: fixture.description,
            scoringConfigJson: fixture.scoringConfig as object,
            createdByUserId: null,
        },
    });

    let sOrder = 0;
    for (const section of fixture.sections) {
        const sec = await prisma.vendorAssessmentTemplateSection.create({
            data: {
                tenantId,
                templateId: tpl.id,
                sortOrder: sOrder++,
                title: section.title,
                description: section.description,
                weight: section.weight,
            },
        });
        let qOrder = 0;
        for (const q of section.questions) {
            await prisma.vendorAssessmentTemplateQuestion.create({
                data: {
                    tenantId,
                    templateId: tpl.id,
                    sectionId: sec.id,
                    sortOrder: qOrder++,
                    prompt: q.prompt,
                    answerType: q.answerType as never,
                    required: q.required,
                    weight: q.weight,
                    optionsJson: q.options ?? undefined,
                    riskPointsJson: q.riskPoints ?? undefined,
                },
            });
        }
    }
    return true;
}

async function main(): Promise<void> {
    console.log('🌱 Seeding built-in vendor-assessment questionnaire templates...');
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    let created = 0;
    let skipped = 0;
    for (const { id } of tenants) {
        for (const fixture of FIXTURES) {
            const didCreate = await seedFixtureForTenant(id, fixture);
            if (didCreate) created += 1;
            else skipped += 1;
        }
    }
    console.log(
        `✅ Vendor questionnaires seeded across ${tenants.length} tenant(s): created ${created}, skipped ${skipped} (already present).`,
    );
}

main()
    .catch((err) => {
        console.error('❌ Vendor-questionnaire seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
