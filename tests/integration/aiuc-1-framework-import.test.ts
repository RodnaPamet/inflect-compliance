/**
 * AIUC-1 reaches a database through BOTH writers, and they share one row.
 *
 * ── WHAT THIS PROVES THAT THE GUARDRAIL CANNOT ──────────────────────────────
 *
 * `tests/guardrails/aiuc-1-framework-coverage.test.ts` proves the library and
 * the CatalogFile AGREE as files: same key, same requirements field for field.
 * That is necessary for one Framework row and not sufficient. The two writers
 * take different paths to the same table — `importLibrary` creates on a fresh
 * key and diffs on an existing one, `applyCatalogFile` upserts on
 * `frameworkId_code` — and `FrameworkRequirement` carries
 * `@@unique([frameworkId, code])`, so a writer that took its create arm against
 * the other's row would not quietly duplicate; it would THROW on the next
 * deploy's seed. Only a database can show the paths really converge.
 *
 * So each order is run against a fresh database, and the claim is about ROW
 * IDS, not counts: a requirement deleted and re-created under the same code is
 * still a broken link for every control and assessment that pointed at the old
 * id.
 *
 * `propagateDelta: false` for the same reason as the agentic import test:
 * delta propagation is a separate, fail-safe subsystem with its own coverage.
 */
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { importLibraryFromFile } from '@/app-layer/services/library-importer';

import { loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../..');
const LIB_FILE = path.join(ROOT, 'src/data/libraries/aiuc-1.yaml');
const FIXTURE = path.join(ROOT, 'prisma/fixtures/aiuc-1-control-templates.json');
const file = loadAndValidateCatalogFile(FIXTURE);
const KEY = 'AIUC-1';
const AUTHORED_TASKS = file.templates.reduce((n, t) => n + t.tasks.length, 0);

/** The one framework row, its requirement ids by code, and its live template tasks. */
async function snapshot() {
    const frameworks = await prisma.framework.findMany({ where: { key: KEY }, select: { id: true } });
    const requirements = await prisma.frameworkRequirement.findMany({
        where: { framework: { key: KEY } },
        select: { id: true, code: true, title: true, description: true, section: true },
        orderBy: { code: 'asc' },
    });
    const tasks = await prisma.controlTemplateTask.count({
        where: { deprecatedAt: null, template: { code: { startsWith: 'AIUC-' } } },
    });
    return { frameworks, requirements, tasks };
}

describeFn('AIUC-1: library first, then the catalogue', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the library import creates the framework and its 50 requirements, and no domain rows', async () => {
        const result = await importLibraryFromFile(prisma, LIB_FILE, { propagateDelta: false });
        expect({ action: result.action, key: result.frameworkKey, created: result.requirementsCreated })
            .toEqual({ action: 'created', key: KEY, created: 50 });

        // UNFILTERED: the whole stored set. A domain node ("A" … "F") arriving
        // as a requirement row would be something a tenant could be "compliant
        // with" that states nothing testable.
        const { requirements } = await snapshot();
        expect(requirements.map((r) => r.code)).toEqual(file.requirements.map((r) => r.code).sort());
    });

    it('re-importing the library is a no-op rather than a duplicate-key failure', async () => {
        const second = await importLibraryFromFile(prisma, LIB_FILE, { propagateDelta: false });
        expect({ action: second.action, created: second.requirementsCreated, deprecated: second.requirementsDeprecated })
            .toEqual({ action: 'skipped', created: 0, deprecated: 0 });
    });

    it('the catalogue then adopts the SAME framework row and the SAME requirement rows', async () => {
        const before = await snapshot();
        const result = await applyCatalogFile(prisma, file, FIXTURE);
        const after = await snapshot();

        expect(result.framework).toEqual({ id: before.frameworks[0]!.id, key: KEY, created: false });
        expect(after.frameworks).toEqual(before.frameworks);
        // Same ids AND same content: the catalogue's requirements are generated
        // from the library, so adopting the rows rewrites nothing in them.
        expect(after.requirements).toEqual(before.requirements);
    });

    it('lands all fifty templates, their links, the pack and every authored task', async () => {
        const templates = await prisma.controlTemplate.findMany({
            where: { code: { startsWith: 'AIUC-' } },
            include: { requirementLinks: { include: { requirement: { select: { code: true } } } } },
        });
        const links = templates
            .map((t) => `${t.code}->${t.requirementLinks.map((l) => l.requirement.code).join(',')}`)
            .sort();
        expect(links).toEqual(file.templates.map((t) => `${t.code}->${t.requirementCodes.join(',')}`).sort());

        const pack = await prisma.frameworkPack.findUniqueOrThrow({
            where: { key: 'AIUC_1_BASELINE' },
            include: { templateLinks: true },
        });
        expect(pack.templateLinks).toHaveLength(50);

        // Authored tasks, not the generic five applyCatalogFile writes for an
        // empty task list.
        expect((await snapshot()).tasks).toBe(AUTHORED_TASKS);
    });

    it('re-applying the catalogue changes nothing', async () => {
        const before = await snapshot();
        const result = await applyCatalogFile(prisma, file, FIXTURE);
        expect(result.tasks).toEqual({ created: 0, updated: 0, deprecated: 0, unchanged: AUTHORED_TASKS });
        expect(await snapshot()).toEqual(before);
    });
});

describeFn('AIUC-1: catalogue first, then the library', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the library import adopts the catalogue row instead of colliding with it', async () => {
        await applyCatalogFile(prisma, file, FIXTURE);
        const before = await snapshot();
        expect(before.requirements).toHaveLength(50);

        // The catalogue writes no contentHash, so the library sees a changed
        // framework and takes its DIFF arm. That arm must find every code
        // already present and identical: nothing created, nothing deprecated,
        // and no row id moved.
        const result = await importLibraryFromFile(prisma, LIB_FILE, { propagateDelta: false });
        expect({ created: result.requirementsCreated, deprecated: result.requirementsDeprecated })
            .toEqual({ created: 0, deprecated: 0 });
        const after = await snapshot();
        expect(after.frameworks).toEqual(before.frameworks);
        expect(after.requirements).toEqual(before.requirements);
        expect(after.tasks).toBe(AUTHORED_TASKS);
    });
});
