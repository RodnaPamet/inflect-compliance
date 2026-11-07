/**
 * The FINOS AI Governance Framework reaches a database through BOTH writers,
 * they share one row, and FINOS's own citations land as mappings.
 *
 * The guard (`tests/guardrails/finos-aigf-framework-coverage.test.ts`) proves
 * the library and the CatalogFile agree as files. Only a database shows that
 * the two writers' different paths — `importLibrary` diffing, `applyCatalogFile`
 * upserting on `frameworkId_code` — converge without a duplicate-key failure or
 * a moved requirement id, so each order runs against a fresh database and the
 * claim is about ROW IDS. Same shape as `aiuc-1-framework-import.test.ts`.
 *
 * The mapping sets are imported against the real ISO 42001 and EU AI Act
 * libraries: an entry that failed to resolve would be dropped silently by the
 * importer, so the count of created mappings is asserted, not just "no throw".
 */
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { importLibraryFromFile } from '@/app-layer/services/library-importer';
import {
    computeMappingSetHash,
    importMappingSet,
    parseMappingSetFile,
} from '@/app-layer/services/mapping-set-importer';

import { loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const LIB_FILE = path.join(LIB_DIR, 'finos-aigf.yaml');
const FIXTURE = path.join(ROOT, 'prisma/fixtures/finos-aigf-control-templates.json');
const file = loadAndValidateCatalogFile(FIXTURE);
const KEY = 'FINOS-AIGF';
const AUTHORED_TASKS = file.templates.reduce((n, t) => n + t.tasks.length, 0);

async function snapshot() {
    const frameworks = await prisma.framework.findMany({ where: { key: KEY }, select: { id: true } });
    const requirements = await prisma.frameworkRequirement.findMany({
        where: { framework: { key: KEY } },
        select: { id: true, code: true, title: true, description: true, section: true },
        orderBy: { code: 'asc' },
    });
    const tasks = await prisma.controlTemplateTask.count({
        where: { deprecatedAt: null, template: { code: { startsWith: 'FINOS-' } } },
    });
    return { frameworks, requirements, tasks };
}

describeFn('FINOS AIGF: library first, then the catalogue, then the mappings', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the library import creates the framework and its 25 mitigations, and no grouping rows', async () => {
        const result = await importLibraryFromFile(prisma, LIB_FILE, { propagateDelta: false });
        expect({ action: result.action, key: result.frameworkKey, created: result.requirementsCreated })
            .toEqual({ action: 'created', key: KEY, created: 25 });
        const { requirements } = await snapshot();
        expect(requirements.map((r) => r.code)).toEqual(file.requirements.map((r) => r.code).sort());
    });

    it('the catalogue then adopts the SAME framework row and the SAME requirement rows', async () => {
        const before = await snapshot();
        const result = await applyCatalogFile(prisma, file, FIXTURE);
        const after = await snapshot();

        expect(result.framework).toEqual({ id: before.frameworks[0]!.id, key: KEY, created: false });
        expect(after.frameworks).toEqual(before.frameworks);
        expect(after.requirements).toEqual(before.requirements);
    });

    it('lands all 25 templates, their links, the pack and every authored task', async () => {
        const templates = await prisma.controlTemplate.findMany({
            where: { code: { startsWith: 'FINOS-' } },
            include: { requirementLinks: { include: { requirement: { select: { code: true } } } } },
        });
        const links = templates
            .map((t) => `${t.code}->${t.requirementLinks.map((l) => l.requirement.code).join(',')}`)
            .sort();
        expect(links).toEqual(file.templates.map((t) => `${t.code}->${t.requirementCodes.join(',')}`).sort());

        const pack = await prisma.frameworkPack.findUniqueOrThrow({
            where: { key: 'FINOS_AIGF_BASELINE' },
            include: { templateLinks: true },
        });
        expect(pack.templateLinks).toHaveLength(25);
        expect((await snapshot()).tasks).toBe(AUTHORED_TASKS);
    });

    it('re-applying the catalogue changes nothing', async () => {
        const before = await snapshot();
        const result = await applyCatalogFile(prisma, file, FIXTURE);
        expect(result.tasks).toEqual({ created: 0, updated: 0, deprecated: 0, unchanged: AUTHORED_TASKS });
        expect(await snapshot()).toEqual(before);
    });

    it.each([
        ['iso-42001.yaml', 'finos-aigf-to-iso-42001.yaml'],
        ['eu-ai-act.yaml', 'finos-aigf-to-eu-ai-act.yaml'],
    ])('every FINOS citation in %s resolves to a mapping row', async (targetLib, mappingFile) => {
        await importLibraryFromFile(prisma, path.join(LIB_DIR, targetLib), { propagateDelta: false });
        const set = parseMappingSetFile(path.join(LIB_DIR, 'mappings', mappingFile));
        const result = await importMappingSet(prisma, set, computeMappingSetHash(set));
        expect(result.errors).toEqual([]);
        expect(result.created).toBe(set.mapping_entries.length);
    });
});

describeFn('FINOS AIGF: catalogue first, then the library', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('the library import adopts the catalogue row instead of colliding with it', async () => {
        await applyCatalogFile(prisma, file, FIXTURE);
        const before = await snapshot();
        expect(before.requirements).toHaveLength(25);

        const result = await importLibraryFromFile(prisma, LIB_FILE, { propagateDelta: false });
        expect({ created: result.requirementsCreated, deprecated: result.requirementsDeprecated })
            .toEqual({ created: 0, deprecated: 0 });
        const after = await snapshot();
        expect(after.frameworks).toEqual(before.frameworks);
        expect(after.requirements).toEqual(before.requirements);
        expect(after.tasks).toBe(AUTHORED_TASKS);
    });
});
