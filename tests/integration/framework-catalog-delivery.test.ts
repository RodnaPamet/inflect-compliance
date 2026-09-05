/**
 * A CatalogFile fixture REACHES THE DATABASE — framework, requirements,
 * templates, requirement links, pack and authored tasks.
 *
 * ═══ WHY ═══
 *
 * `applyCatalogFile` is the only function that creates all six together, and
 * until `scripts/seed-framework-catalogs.ts` existed its sole non-test caller
 * was a manual operator CLI. A framework could be completely described in the
 * repo and reach no environment because nobody ran a command — which is how
 * production's catalogue came to differ from the fixtures by 133 templates in
 * one direction and 237 in the other.
 *
 * This is the companion to `control-template-task-delivery.test.ts`. That one
 * proves authored TASKS land on templates that already exist; this one proves a
 * whole framework lands when it does not.
 *
 * It calls the same loader and applier the seeder calls, rather than
 * re-implementing them: a delivery test that re-implements its own delivery
 * proves only that two pieces of code agree, which is the failure this whole
 * area was built to end.
 */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE = path.join(REPO_ROOT, 'prisma/fixtures/soc2-control-templates.json');

let prisma: PrismaClient;
const file = loadAndValidateCatalogFile(FIXTURE);

describe('a CatalogFile fixture reaches the database', () => {
    beforeAll(async () => {
        prisma = prismaTestClient();
        await resetDatabase(prisma);
        await applyCatalogFile(prisma, file, FIXTURE);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the fixture carries what it claims (not vacuous)', () => {
        // Every assertion below is satisfiable by an empty catalog, which is
        // the exact shape of the bug this area exists to prevent.
        expect(file.requirements.length).toBeGreaterThan(0);
        expect(file.templates.length).toBeGreaterThan(0);
        expect(file.templates.reduce((n, t) => n + t.tasks.length, 0)).toBeGreaterThan(0);
    });

    it('creates the framework and every requirement', async () => {
        const framework = await prisma.framework.findFirstOrThrow({
            where: { key: file.framework.key },
        });
        const requirements = await prisma.frameworkRequirement.findMany({
            where: { frameworkId: framework.id },
        });
        expect(requirements).toHaveLength(file.requirements.length);
        expect(requirements.map((r) => r.code).sort()).toEqual(
            file.requirements.map((r) => r.code).sort(),
        );
    });

    it('creates every template with its requirement links', async () => {
        const codes = file.templates.map((t) => t.code);
        const templates = await prisma.controlTemplate.findMany({
            where: { code: { in: codes } },
            include: { requirementLinks: true },
        });
        expect(templates).toHaveLength(codes.length);

        // Links are what make a template reachable: a framework-pack install
        // finds templates BY requirement link, so a template seeded without
        // them is present and unreachable.
        const expectedLinks = file.templates.reduce((n, t) => n + t.requirementCodes.length, 0);
        expect(templates.reduce((n, t) => n + t.requirementLinks.length, 0)).toBe(expectedLinks);
    });

    it('lands every authored task, with its fields intact', async () => {
        const codes = file.templates.map((t) => t.code);
        const templates = await prisma.controlTemplate.findMany({
            where: { code: { in: codes } },
            include: { tasks: { where: { deprecatedAt: null }, orderBy: { sortOrder: 'asc' } } },
        });
        const byCode = new Map(templates.map((t) => [t.code, t]));

        const authoredTotal = file.templates.reduce((n, t) => n + t.tasks.length, 0);
        const landed = templates.reduce((n, t) => n + t.tasks.length, 0);
        expect(landed).toBe(authoredTotal);

        // Counting rows alone would not notice the older seed loops' failure
        // mode, which wrote only { templateId, title, description } and dropped
        // phase, sortOrder, evidenceHint and suggestedRole on the floor.
        const source = file.templates.find((t) => t.tasks.length > 0)!;
        const rows = byCode.get(source.code)!.tasks;
        rows.forEach((row, i) => {
            const src = source.tasks[i]!;
            expect(row.title).toBe(src.title.en);
            expect(row.phase).toBe(src.phase);
            expect(row.sortOrder).toBe(src.sortOrder);
            expect(row.contentHash).toBeTruthy();
            if (src.evidenceHint) expect(row.evidenceHint).toBe(src.evidenceHint.en);
            if (src.suggestedRole) expect(row.suggestedRole).toBe(src.suggestedRole);
        });
    });

    it('creates the pack and links it to the templates', async () => {
        const pack = await prisma.frameworkPack.findUniqueOrThrow({
            where: { key: file.pack!.key },
            include: { templateLinks: true },
        });
        expect(pack.templateLinks).toHaveLength(file.pack!.templateCodes!.length);
    });

    it('re-running is idempotent — no duplicates, no churn', async () => {
        // The seeder runs on EVERY production deploy. A second pass that
        // created rows would grow the catalogue without bound.
        const before = await prisma.controlTemplateTask.count();
        const templatesBefore = await prisma.controlTemplate.count();

        await applyCatalogFile(prisma, file, FIXTURE);

        expect(await prisma.controlTemplateTask.count()).toBe(before);
        expect(await prisma.controlTemplate.count()).toBe(templatesBefore);
    });
});
