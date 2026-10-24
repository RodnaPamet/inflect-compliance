/**
 * Standalone, idempotent backfill: give already-installed template tasks the
 * checklist their template task now carries.
 *
 * Install copies a template task's steps onto the tenant's task once, so a task
 * installed before its template had steps keeps none until something revisits
 * it. This is that something. The rules for which tasks are filled — and why a
 * task that already has a checklist, a closed task and a task with no recorded
 * template are never touched — live with the logic in
 * `prisma/task-checklist-backfill.ts`.
 *
 * Runs on every container start, after the catalogue and task seeders, so steps
 * authored into a fixture reach the tasks installed from it on the deploy that
 * ships them. A second run fills nothing.
 *
 *   tsx scripts/backfill-task-checklists.ts   (npm run db:backfill-task-checklists)
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { backfillTemplateTaskChecklists } from '../prisma/task-checklist-backfill';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

async function main(): Promise<void> {
    console.log('🌱 Backfilling task checklists from their template steps...');
    const r = await backfillTemplateTaskChecklists(prisma);
    console.log(
        `✅ Task checklists backfilled: ${r.filled} filled of ${r.scanned} candidate task(s) ` +
            `(${r.noSteps} whose template carries no steps, ${r.raced} changed during the run).`,
    );
}

main()
    .catch((err) => {
        console.error('❌ Task-checklist backfill failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
