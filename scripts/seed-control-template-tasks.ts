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
import {
    seedInternalControls,
    type PolicyFrameworkMap,
} from '../prisma/internal-controls-seed';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

// esbuild inlines the fixture into the bundle at build time, so the runtime
// image needs no fixture files present.
const FIXTURE = require('../prisma/fixtures/internal-controls.json') as unknown;
const POLICY_MAP = (
    require('../prisma/fixtures/internal-controls-policy-framework-map.json') as {
        policies: PolicyFrameworkMap;
    }
).policies;

async function main(): Promise<void> {
    console.log('🌱 Seeding authored control-template tasks...');

    const r = await seedInternalControls(prisma, FIXTURE, POLICY_MAP);
    console.log(
        `  templates: ${r.templates.created} created, ${r.templates.updated} updated; ` +
            `${r.requirementLinks} requirement links`,
    );
    console.log(`  fixture: ${r.fixtureTaskCount} authored tasks`);

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
