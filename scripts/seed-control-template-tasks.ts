/**
 * Standalone, idempotent seeder for authored CONTROL-TEMPLATE TASKS.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Same rationale as `seed-policy-templates.ts` and `seed-self-assessments.ts`,
 * with a sharper edge. Two independent gaps kept authored task content out of
 * every database:
 *
 *   1. `prisma/seed.ts`'s internal-controls loop upserts the ControlTemplate
 *      and its requirement links, and never writes `ControlTemplateTask` at
 *      all. It read the fixture through an `as` cast whose type had no `tasks`
 *      field, so the authored content was discarded silently at the type
 *      boundary rather than failing anywhere.
 *
 *   2. Prod deploys do not run `prisma/seed.ts` (the entrypoint runs
 *      `migrate deploy` plus targeted seeders only), so even once (1) is fixed
 *      the content would reach dev and CI and stop there.
 *
 * The consequence was that 865 authored tasks shipped through a bespoke
 * conformance gate, an actionability ratchet and 24 green CI checks into a
 * database that received none of them — every gate read the fixture, and no
 * gate crossed the delivery boundary.
 *
 * This seeder closes (2); `prisma/seed.ts` closes (1); and
 * `tests/integration/control-template-task-delivery.test.ts` asserts the thing
 * neither of them can assert about itself — that rows actually land.
 *
 * ═══ SAFE TO RE-RUN, ON PRODUCTION ═══
 *
 * Writes go through `reconcileTemplateTasks`, which is keyed on
 * `(templateId, contentHash)` and never deletes: unchanged content is skipped,
 * edited content updates in place at the same `sortOrder`, and a task the
 * fixture no longer claims is marked `deprecatedAt` so it stops being
 * installed without disturbing tenants who already installed it.
 *
 *   tsx scripts/seed-control-template-tasks.ts   (npm run db:seed-control-tasks)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fixtureObject } from '../prisma/fixture-io';
import {
    seedInternalControls,
    seedAuthoredTemplateTasks,
    type PolicyFrameworkMap,
} from '../prisma/control-template-seed';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

// esbuild inlines the fixture into the bundle at build time, so the runtime
// image needs no fixture files present.
const FIXTURE = require('../prisma/fixtures/internal-controls.json') as unknown;
const POLICY_MAP = fixtureObject<{ policies: PolicyFrameworkMap }>(
    'fixtures/internal-controls-policy-framework-map',
    require('../prisma/fixtures/internal-controls-policy-framework-map.json'),
    'policies',
).policies;

/**
 * Framework fixtures whose templates ALREADY exist in every environment (they
 * come from seed-catalog.ts / framework-import), so only their authored tasks
 * need delivering. Add a fixture here the moment it gains authored tasks —
 * otherwise the content sits in the repo reaching nothing, which is the exact
 * failure this file was written for.
 */
const TASK_ONLY_FIXTURES: Array<{ label: string; data: unknown }> = [
    { label: 'DORA', data: require('../prisma/fixtures/dora-control-templates.json') as unknown },
    { label: 'NIS2', data: require('../prisma/fixtures/nis2-control-templates.json') as unknown },
];

async function main(): Promise<void> {
    console.log('🌱 Seeding authored control-template tasks...');

    const r = await seedInternalControls(prisma, FIXTURE, POLICY_MAP);
    console.log(
        `  templates: ${r.templates.created} created, ${r.templates.updated} updated; ` +
            `${r.requirementLinks} requirement links`,
    );
    console.log(`  fixture: ${r.fixtureTaskCount} authored tasks`);

    for (const { label, data } of TASK_ONLY_FIXTURES) {
        const f = await seedAuthoredTemplateTasks(prisma, data);
        if (f.fixtureTaskCount === 0) {
            console.log(`  ${label}: no authored tasks in fixture, skipped`);
            continue;
        }
        console.log(
            `  ${label}: ${f.fixtureTaskCount} authored -> created ${f.created}, updated ${f.updated}, ` +
                `unchanged ${f.unchanged}, deprecated ${f.deprecated}` +
                (f.missingTemplates.length
                    ? ` ⚠ ${f.missingTemplates.length} template(s) absent: ${f.missingTemplates.slice(0, 8).join(', ')}`
                    : ''),
        );
    }

    const live = await prisma.controlTemplateTask.count({ where: { deprecatedAt: null } });
    console.log(
        `✅ Control-template tasks seeded (created ${r.created}, updated ${r.updated}, ` +
            `unchanged ${r.unchanged}, deprecated ${r.deprecated}; ${live} live rows total).`,
    );
}

main()
    .catch((err) => {
        console.error('❌ Control-template task seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
