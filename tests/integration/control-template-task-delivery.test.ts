/**
 * Authored control-template tasks REACH THE DATABASE.
 *
 * ═══ WHY THIS TEST EXISTS ═══
 *
 * On 2026-09-04, 865 authored control tasks shipped through a bespoke
 * conformance gate, an actionability ratchet, 1,634 local suites and 24 green
 * CI checks into a database that received none of them. `prisma/seed.ts` read
 * `internal-controls.json` through an `as` cast whose type had no `tasks`
 * field, so the content was discarded at the type boundary — silently, because
 * a cast cannot fail — and `ControlTemplateTask` was never written.
 *
 * Every gate that passed was reading the same JSON the seeder was throwing
 * away. Not one of them crossed the delivery boundary, so all of them agreed,
 * and their agreement meant nothing.
 *
 * This test is the one assertion that could have caught it: it seeds into a
 * real database and counts rows. It calls `seedInternalControls` — the
 * same function both seeders call — rather than re-implementing delivery,
 * because a test that re-implements what it checks only proves two pieces of
 * code agree, which is precisely the failure above.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import {
    loadAuthoredControlTasks,
    seedInternalControls,
} from '../../prisma/control-template-seed';
import { GENERIC_TEMPLATE_TASKS } from '../../prisma/generic-template-tasks';

const FIXTURE = require('../../prisma/fixtures/internal-controls.json') as unknown;

let prisma: PrismaClient;
let templateIds: string[] = [];
let seeded: Awaited<ReturnType<typeof seedInternalControls>>;

/**
 * Every count below is scoped to the templates under test.
 *
 * A global `controlTemplateTask.count()` reads ~1,490 rows here, because the
 * other populations legitimately carry template tasks and `resetDatabase`
 * preserves the global catalogue. Scoping is not a workaround — an unscoped
 * count would pass or fail on what OTHER fixtures happen to hold.
 */
describe('authored control-template tasks reach the database', () => {
    const authored = loadAuthoredControlTasks(FIXTURE);
    const codes = [...authored.byCode.keys()];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await resetDatabase(prisma);
        // No template pre-creation: the seeder owns that too, and production
        // has zero ICN- templates, so template creation IS part of delivery.
        seeded = await seedInternalControls(prisma, FIXTURE);
        templateIds = (
            await prisma.controlTemplate.findMany({
                where: { code: { in: codes } },
                select: { id: true },
            })
        ).map((t) => t.id);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the fixture actually carries authored tasks (the test is not vacuous)', () => {
        // Without this, every assertion below passes on an empty fixture — the
        // same shape of nothing that let the original defect look healthy.
        expect(authored.controlCount).toBeGreaterThan(0);
        expect(authored.taskCount).toBeGreaterThan(0);
    });

    it('creates the ControlTemplate rows themselves', async () => {
        // Production has ZERO ICN- templates — its catalogue came from
        // framework-import, not these fixtures — so a tasks-only seeder would
        // find nothing to attach to and report success having done nothing.
        // created vs updated depends on whether the global catalogue survived
        // resetDatabase (it does), so assert the total — what matters is that
        // every authored control HAS a template afterwards, however it got one.
        expect(seeded.templates.created + seeded.templates.updated).toBeGreaterThanOrEqual(
            codes.length,
        );
        expect(templateIds).toHaveLength(codes.length);
    });

    it('every authored task lands as a ControlTemplateTask row', async () => {
        // created + unchanged, not created alone. `resetDatabase` PRESERVES the
        // global catalogue, so a template whose authored tasks already carry
        // matching content hashes reports them as `unchanged` and this run
        // creates nothing — correct behaviour, and asserting `created` alone
        // made the test pass only on a database that had never seen this
        // content. CI gets a fresh one every run, so it stayed green there
        // while failing locally the moment the same content was seeded twice.
        //
        // What actually needs to be true is that this run ACCOUNTED FOR every
        // authored task, however it got there, and that they are all live
        // below. The anti-vacuity assertion above is what stops 0 === 0
        // satisfying this.
        expect(seeded.created + seeded.unchanged).toBe(authored.taskCount);

        const live = await prisma.controlTemplateTask.count({
            where: { templateId: { in: templateIds }, deprecatedAt: null },
        });
        expect(live).toBe(authored.taskCount);
    });

    it('the authored FIELDS survive delivery, not just title and description', async () => {
        // The pre-existing seed loops that DID write tasks wrote only
        // `{ templateId, title, description }`, so phase, sortOrder, steps,
        // evidenceHint and suggestedRole would have been dropped even once the
        // rows existed. Counting rows alone would not have noticed.
        const [code, tasks] = [...authored.byCode.entries()][0]!;
        const template = await prisma.controlTemplate.findUniqueOrThrow({ where: { code } });
        const rows = await prisma.controlTemplateTask.findMany({
            where: { templateId: template.id, deprecatedAt: null },
            orderBy: { sortOrder: 'asc' },
        });

        expect(rows).toHaveLength(tasks.length);
        rows.forEach((row, i) => {
            const src = tasks[i]!;
            expect(row.title).toBe(src.title.en);
            expect(row.description).toBe(src.description.en);
            expect(row.phase).toBe(src.phase);
            expect(row.sortOrder).toBe(src.sortOrder);
            expect(row.contentHash).toBeTruthy();
            if (src.evidenceHint) expect(row.evidenceHint).toBe(src.evidenceHint.en);
            if (src.suggestedRole) expect(row.suggestedRole).toBe(src.suggestedRole);
            if (src.steps) {
                expect(Array.isArray(row.stepsJson)).toBe(true);
                expect(row.stepsJson as unknown[]).toHaveLength(src.steps.length);
            }
        });
    });

    it('an OPERATE task keeps the artifact it names', async () => {
        // evidenceHint on OPERATE is the one field the authoring spec makes
        // mandatory, so it is the one most worth proving survives the trip.
        const operate = await prisma.controlTemplateTask.findMany({
            where: { templateId: { in: templateIds }, phase: 'OPERATE', deprecatedAt: null },
            select: { title: true, evidenceHint: true },
        });
        expect(operate.length).toBeGreaterThan(0);
        expect(operate.filter((t) => !t.evidenceHint?.trim()).map((t) => t.title)).toEqual([]);
    });

    it("retires production's generic placeholders, all of which share sortOrder 0", async () => {
        // THE PRODUCTION SHAPE, reproduced exactly. Every one of prod's 1,155
        // template tasks is one of five generic placeholder strings, carries a
        // NULL contentHash, and sits at sortOrder 0 — the loops that created
        // them predate both columns and took their defaults.
        //
        // Keying the reconcile by sortOrder collapses those five rows into one
        // Map entry, and the four it drops are invisible to both the update
        // and the deprecation pass. They would survive as live boilerplate
        // beside the authored tasks: a customer opening a DORA control would
        // see six real tasks and four "Document procedure or policy".
        // A DIFFERENT control from the deprecation test below, which shares
        // this database and counts rows on the template it uses.
        const entries = [...authored.byCode.entries()];
        const [code, tasks] = entries[entries.length - 1]!;
        const template = await prisma.controlTemplate.findUniqueOrThrow({ where: { code } });

        await prisma.controlTemplateTask.deleteMany({ where: { templateId: template.id } });
        // Imported, not spelled out: `no-generic-task-strings.test.ts` forbids
        // a sixth copy of these strings, and it is right to — the placeholders
        // this test reproduces are the ones that live in exactly one place.
        for (const { title } of GENERIC_TEMPLATE_TASKS) {
            await prisma.controlTemplateTask.create({
                data: { templateId: template.id, title, description: null, sortOrder: 0 },
            });
        }
        expect(
            await prisma.controlTemplateTask.count({
                where: { templateId: template.id, deprecatedAt: null },
            }),
        ).toBe(GENERIC_TEMPLATE_TASKS.length);

        await seedInternalControls(prisma, FIXTURE);

        const live = await prisma.controlTemplateTask.findMany({
            where: { templateId: template.id, deprecatedAt: null },
            orderBy: { sortOrder: 'asc' },
        });
        // Exactly the authored set — no placeholder survives.
        expect(live).toHaveLength(tasks.length);
        expect(live.map((r) => r.title)).toEqual(tasks.map((t) => t.title.en));
        expect(live.every((r) => r.contentHash)).toBe(true);

        // Retired, not deleted: a tenant may already have installed them.
        expect(
            await prisma.controlTemplateTask.count({
                where: { templateId: template.id, deprecatedAt: { not: null } },
            }),
        ).toBe(GENERIC_TEMPLATE_TASKS.length - 1); // one row is reused in place at sortOrder 0
    });

    it('re-running is idempotent — no duplicates, no churn', async () => {
        // The seeder runs on EVERY production deploy. If a second run created
        // rows, the table would grow without bound and every tenant install
        // would pick up duplicates.
        const before = await prisma.controlTemplateTask.count({ where: { templateId: { in: templateIds } } });
        const second = await seedInternalControls(prisma, FIXTURE);

        expect(second.created).toBe(0);
        expect(second.updated).toBe(0);
        expect(second.deprecated).toBe(0);
        expect(second.unchanged).toBe(authored.taskCount);
        expect(
            await prisma.controlTemplateTask.count({ where: { templateId: { in: templateIds } } }),
        ).toBe(before);
    });

    it('a task the fixture stops claiming is deprecated, never deleted', async () => {
        // A tenant may already have installed it, and its Task rows outlive the
        // template by design. Deprecation stops re-installation without
        // disturbing what exists.
        //
        // Asserted as DELTAS, not absolutes. Every run of this test leaves one
        // deprecated row behind and the restore below creates a fresh live row
        // at the same sortOrder, so the template's total row count grows by one
        // per run — correct behaviour (nothing is ever deleted) that an
        // absolute count reads as failure on the second run. That is the same
        // state-dependence #2319 fixed one assertion up, and it was mine both
        // times: a test that only passes against a database it has not already
        // touched is testing the database, not the code.
        const [code, tasks] = [...authored.byCode.entries()][0]!;
        const template = await prisma.controlTemplate.findUniqueOrThrow({ where: { code } });
        const where = { templateId: template.id };

        const before = await prisma.controlTemplateTask.findMany({ where });
        const beforeDeprecated = before.filter((r) => r.deprecatedAt !== null).length;

        // `title` is required — the seeder filters malformed controls, and a
        // fixture entry without one is exactly that.
        const trimmed = {
            controls: [{ code, title: `Template ${code}`, tasks: tasks.slice(0, -1) }],
        };
        const r = await seedInternalControls(prisma, trimmed);
        expect(r.deprecated).toBe(1);

        const after = await prisma.controlTemplateTask.findMany({ where });
        expect(after).toHaveLength(before.length); // nothing deleted
        expect(after.filter((t) => t.deprecatedAt !== null)).toHaveLength(beforeDeprecated + 1);

        // Restore, so ordering between tests cannot leak.
        await seedInternalControls(prisma, FIXTURE);
        expect(
            await prisma.controlTemplateTask.count({ where: { ...where, deprecatedAt: null } }),
        ).toBe(tasks.length);
    });
});
