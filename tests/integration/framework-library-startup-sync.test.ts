/**
 * The framework libraries and their crosswalks REACH A DATABASE at container
 * start, and the sync that delivers them leaves the catalogue's rows alone.
 *
 * ═══ WHY ═══
 *
 * `syncAllLibraries` is the only writer of library framework rows and of the
 * mapping sets, and until `scripts/sync-framework-libraries.ts` nothing in a
 * deployed environment called it. Every surface that reads the crosswalks
 * worked in tests and nowhere else.
 *
 * This calls `syncLibrariesAtStartup`, the function the script calls, against
 * a database the catalogue has already written, in the order the entrypoint
 * runs them. A delivery test that re-implemented the delivery would prove only
 * that two pieces of code agree.
 *
 * ═══ WHAT IT HOLDS ═══
 *
 *   • every library whose row no catalogue owns is created, and every mapping
 *     set on disk is imported — none is dropped by the importer's log-and-
 *     continue;
 *   • the two rows a catalogue owns under a library's own key (AIUC-1, COSO)
 *     come out of the sync byte-identical, and a control linked to one keeps
 *     its status;
 *   • a second run writes nothing;
 *   • the lists that OFFER frameworks show one row per framework.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { REPO_ROOT } from '../helpers/repo-files';
import { loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { scanLibraryDirectory, parseLibraryFile } from '@/app-layer/libraries';
import { syncLibrariesAtStartup } from '@/app-layer/usecases/library-sync';
import { listFrameworks } from '@/app-layer/usecases/framework';
import { listFrameworks as listMappableFrameworks } from '@/app-layer/usecases/control';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const LIBRARIES_DIR = path.join(REPO_ROOT, 'src/data/libraries');
const MAPPINGS_DIR = path.join(LIBRARIES_DIR, 'mappings');
const DIRS = { librariesDir: LIBRARIES_DIR, mappingsDir: MAPPINGS_DIR };

/**
 * The catalogue fixtures this database gets before the sync. The two whose
 * key a library also declares, plus three whose library twin the offer lists
 * must hide. Not every fixture: a library whose twin is absent here is the
 * case that proves the hiding depends on the twin.
 */
const CATALOGUE = [
    'prisma/fixtures/aiuc-1-control-templates.json',
    'prisma/fixtures/coso-icf-2013-control-templates.json',
    'prisma/fixtures/iso27001-control-templates.json',
    'prisma/fixtures/dora-control-templates.json',
    'prisma/fixtures/nis2-control-templates.json',
];
const OWNED_BY_A_LIBRARY_KEY = ['AIUC-1', 'COSO-ICF-2013'];
const TENANT = 'libsync-tenant';

/** Everything about a catalogue-owned row the sync could plausibly rewrite. */
async function snapshot(key: string): Promise<string> {
    const fw = await prisma.framework.findUniqueOrThrow({
        where: { key },
        select: {
            name: true, version: true, description: true, metadataJson: true,
            contentHash: true, sourceUrn: true, kind: true,
            requirements: {
                orderBy: { code: 'asc' },
                select: { code: true, title: true, description: true, section: true, deprecatedAt: true },
            },
        },
    });
    return JSON.stringify(fw);
}

/**
 * `Tenant` is not in `resetDatabase`'s table list, so a suite that creates a
 * tenant removes it itself, before and after, as the inherited-coverage suite
 * does. Its delta rows cascade with it.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: TENANT };
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [TENANT]);
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

const libraryKeys = scanLibraryDirectory(LIBRARIES_DIR).map(
    (e) => parseLibraryFile(e.filePath).objects.framework.ref_id,
);
const mappingSetFiles = fs.readdirSync(MAPPINGS_DIR).filter((f) => f.endsWith('.yaml'));

describeFn('framework libraries reach the database at container start', () => {
    const before = new Map<string, string>();
    let first: Awaited<ReturnType<typeof syncLibrariesAtStartup>>;
    let cosoControlId: string;
    let syncStartedAt: Date;

    beforeAll(async () => {
        await resetDatabase(prisma);
        await clearOwnRows();
        for (const rel of CATALOGUE) {
            const abs = path.join(REPO_ROOT, rel);
            await applyCatalogFile(prisma, loadAndValidateCatalogFile(abs), abs);
        }

        // A tenant whose IMPLEMENTED control hangs off the catalogue's COSO row:
        // the control a rewrite of that row would put up for review.
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const coso = await prisma.framework.findUniqueOrThrow({ where: { key: 'COSO-ICF-2013' } });
        const p1 = await prisma.frameworkRequirement.findFirstOrThrow({
            where: { frameworkId: coso.id, code: 'P1' },
        });
        const control = await prisma.control.create({
            data: { tenantId: TENANT, code: 'LS-P1', name: 'Code of conduct', status: 'IMPLEMENTED' },
        });
        await prisma.controlRequirementLink.create({
            data: { tenantId: TENANT, controlId: control.id, requirementId: p1.id },
        });
        cosoControlId = control.id;

        for (const key of OWNED_BY_A_LIBRARY_KEY) before.set(key, await snapshot(key));
        syncStartedAt = new Date();
        first = await syncLibrariesAtStartup(prisma, DIRS);
    });

    afterAll(async () => {
        await clearOwnRows();
        await prisma.$disconnect();
    });

    it('the population is what it claims (not vacuous)', () => {
        for (const key of OWNED_BY_A_LIBRARY_KEY) expect(libraryKeys).toContain(key);
        expect(libraryKeys.length).toBeGreaterThan(OWNED_BY_A_LIBRARY_KEY.length);
        expect(mappingSetFiles.length).toBeGreaterThan(0);
    });

    it('leaves every row with a pack to the catalogue', () => {
        expect(first.catalogueOwnedKeys).toEqual(
            expect.arrayContaining([...OWNED_BY_A_LIBRARY_KEY, 'ISO27001', 'DORA', 'NIS2']),
        );
    });

    it('creates every library whose row no catalogue owns', async () => {
        const expected = libraryKeys.filter((k) => !OWNED_BY_A_LIBRARY_KEY.includes(k)).sort();
        expect(first.results.map((r) => r.frameworkKey).sort()).toEqual(expected);
        expect(first.results.every((r) => r.action === 'created')).toBe(true);
        const rows = await prisma.framework.findMany({ where: { key: { in: expected } }, select: { key: true } });
        expect(rows.map((r) => r.key).sort()).toEqual(expected);
    });

    it('imports every mapping set on disk', () => {
        // Set-level: the importer logs a set it cannot import and moves on, so a
        // dropped set shows only as a missing result. Entry-level errors are a
        // different, pre-existing matter: 10 entries in iso27001-to-iso27701 and
        // iso27701-to-gdpr cite clause-group nodes (`5` … `8`) their libraries
        // do not make assessable, so no requirement row exists for them. That is
        // mapping CONTENT, independent of delivery, and the script reports the
        // count on every run.
        expect(first.mappingSets.results).toHaveLength(mappingSetFiles.length);
        expect(first.mappingSets.results.every((r) => !r.skippedDuplicate)).toBe(true);
    });

    it('a crosswalk citing a catalogue-owned framework resolves against its row', async () => {
        const aiuc = await prisma.framework.findUniqueOrThrow({ where: { key: 'AIUC-1' } });
        const iso = await prisma.framework.findUniqueOrThrow({ where: { key: 'ISO27001-2022' } });
        const set = await prisma.requirementMappingSet.findFirstOrThrow({
            where: { sourceFrameworkId: iso.id, targetFrameworkId: aiuc.id },
            include: { _count: { select: { mappings: true } } },
        });
        expect(set._count.mappings).toBeGreaterThan(0);
    });

    it('rewrites nothing on the rows the catalogue owns', async () => {
        for (const key of OWNED_BY_A_LIBRARY_KEY) {
            expect(await snapshot(key)).toBe(before.get(key));
        }
    });

    it('puts no linked control up for review and records no framework delta', async () => {
        const control = await prisma.control.findUniqueOrThrow({ where: { id: cosoControlId } });
        expect(control.status).toBe('IMPLEMENTED');
        // Counted from the sync's start: the diff table is global reference data
        // that other suites leave rows in.
        expect(await prisma.frameworkVersionDiff.count({ where: { createdAt: { gte: syncStartedAt } } })).toBe(0);
        expect(await prisma.tenantFrameworkDelta.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('writes nothing on a second run', async () => {
        const second = await syncLibrariesAtStartup(prisma, DIRS);
        expect(second.summary).toMatchObject({ created: 0, updated: 0 });
        expect(second.summary.skipped).toBe(first.results.length);
        expect(second.mappingSets.summary.imported).toBe(0);
        expect(second.mappingSets.summary.skipped).toBe(mappingSetFiles.length);
    });

    describe('the lists that offer frameworks', () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT });

        it.each([
            ['the Frameworks page', async () => (await listFrameworks(ctx)).map((f) => f.key)],
            ['the control-mapping picker', async () => (await listMappableFrameworks(ctx)).map((f) => f.key)],
        ])('%s shows one row per framework', async (_surface, keys) => {
            const offered = await keys();
            // The catalogue rows, including the two a library shares a key with.
            for (const key of ['ISO27001', 'DORA', 'NIS2', 'AIUC-1', 'COSO-ICF-2013']) expect(offered).toContain(key);
            // Their library twins.
            for (const key of ['ISO27001-2022', 'DORA-2022', 'NIS2-2022']) expect(offered).not.toContain(key);
            // Library-only frameworks are offered (owner decision, 2026-10-24).
            for (const key of ['GDPR', 'NIST-CSF-2.0']) expect(offered).toContain(key);
            // A library whose catalogue twin this database does not hold has no
            // installable row in its family, so it stays offered: the hiding
            // depends on the twin, not on being a library.
            expect(offered).toContain('SOC2-2017');
        });
    });
});
