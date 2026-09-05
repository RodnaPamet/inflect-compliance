/**
 * Agentic frameworks land through the EXISTING library-import path (real DB).
 *
 * The OWASP Agentic AI Top 10 and the IMDA MGF ship as library CONTENT on the
 * same Store → Parse → Compare → Upsert pipeline as ISO 27001 / NIS2 / AISVS.
 * The point of reusing that path rather than hand-rolling a seeder is
 * idempotency, so this suite proves idempotency rather than asserting it:
 *
 *   - a first import creates one framework and exactly ten ASI requirements;
 *   - a second import of the same file is SKIPPED on the content hash — one
 *     framework row, ten requirement rows, and the SAME row ids (no churn that
 *     would orphan control links or evidence pinned to a requirement);
 *   - a REVISED library (bumped version, reworded risk) UPDATES in place — the
 *     ASI04 row keeps its id and gains the new title. It does not fork a second
 *     framework, which is why the library ref_id carries no edition suffix;
 *   - the same holds for the IMDA MGF across its four dimensions.
 *
 * Framework/FrameworkRequirement are a GLOBAL catalogue (no tenantId, no RLS),
 * so the suite owns its two keys and wipes them either side.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as path from 'path';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { importLibrary, importLibraryFromFile } from '@/app-layer/services/library-importer';
import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const LIB_DIR = path.resolve(__dirname, '../../src/data/libraries');
const ASI_FILE = path.join(LIB_DIR, 'owasp-agentic-top10.yaml');
const MGF_FILE = path.join(LIB_DIR, 'imda-mgf-2026.yaml');

const ASI_KEY = 'OWASP-ASI-TOP10';
const MGF_KEY = 'IMDA-MGF-2026';

const ASI_CODES = [
    'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05',
    'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
];

/** Import options that keep the suite to the import path itself. */
const OPTS = { propagateDelta: false } as const;

async function wipe() {
    for (const key of [ASI_KEY, MGF_KEY]) {
        const fw = await prisma.framework.findFirst({ where: { key } });
        if (!fw) continue;
        await prisma.frameworkRequirement.deleteMany({ where: { frameworkId: fw.id } });
        await prisma.framework.delete({ where: { id: fw.id } });
    }
}

/** Live (non-deprecated) requirement rows for a framework key, in sort order. */
async function liveRequirements(key: string) {
    const fw = await prisma.framework.findFirstOrThrow({ where: { key } });
    return prisma.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });
}

describeFn('agentic frameworks via the library-import path', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await wipe();
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    describe('OWASP Agentic AI Top 10', () => {
        it('first import creates the framework and the ten canonical ASI requirements', async () => {
            const result = await importLibraryFromFile(prisma, ASI_FILE, OPTS);

            expect(result.action).toBe('created');
            expect(result.frameworkKey).toBe(ASI_KEY);
            expect(result.requirementsCreated).toBe(10);

            const reqs = await liveRequirements(ASI_KEY);
            expect(reqs.map((r) => r.code)).toEqual(ASI_CODES);
            // The identifier is the contract; the title is not. Both must exist,
            // but only the code set is pinned.
            expect(reqs.filter((r) => !r.title).map((r) => r.code)).toEqual([]);
        });

        it('re-importing the same file is skipped, leaving one framework and ten requirements', async () => {
            const before = await liveRequirements(ASI_KEY);

            const result = await importLibraryFromFile(prisma, ASI_FILE, OPTS);
            expect(result.action).toBe('skipped');
            expect(result.requirementsCreated).toBe(0);
            expect(result.requirementsDeprecated).toBe(0);

            // No duplicate framework, no duplicate requirements, and — the part
            // that matters for anything already linked to a requirement — the
            // same row ids.
            expect(await prisma.framework.count({ where: { key: ASI_KEY } })).toBe(1);
            const after = await liveRequirements(ASI_KEY);
            expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
            expect(after.map((r) => r.code)).toEqual(ASI_CODES);
        });

        it('a revised library updates ASI04 in place rather than forking a framework', async () => {
            const beforeFw = await prisma.framework.findFirstOrThrow({ where: { key: ASI_KEY } });
            const beforeAsi04 = (await liveRequirements(ASI_KEY)).find((r) => r.code === 'ASI04')!;

            // A realistic revision: OWASP bumps the edition and rewords a risk.
            // The ref_id is unchanged, which is the whole point of leaving the
            // edition out of it.
            const stored = parseLibraryFile(ASI_FILE);
            stored.version = 2;
            const node = stored.objects.framework.requirement_nodes.find((n) => n.ref_id === 'ASI04')!;
            node.name = 'Agentic Supply Chain and Dependency Compromise';
            const revised = loadLibrary(stored, 'owasp-agentic-top10.yaml@v2');
            expect(revised.contentHash).not.toBe(beforeFw.contentHash);

            const result = await importLibrary(prisma, revised, OPTS);
            expect(result.action).toBe('updated');
            expect(result.changedCodes).toContain('ASI04');
            expect(result.requirementsCreated).toBe(0);
            expect(result.requirementsDeprecated).toBe(0);

            expect(await prisma.framework.count({ where: { key: ASI_KEY } })).toBe(1);
            const afterFw = await prisma.framework.findFirstOrThrow({ where: { key: ASI_KEY } });
            expect(afterFw.id).toBe(beforeFw.id);
            expect(afterFw.version).toBe('2');

            const afterAsi04 = (await liveRequirements(ASI_KEY)).find((r) => r.code === 'ASI04')!;
            expect(afterAsi04.id).toBe(beforeAsi04.id);
            expect(afterAsi04.title).toBe('Agentic Supply Chain and Dependency Compromise');

            // Still ten risks, still the same identifiers.
            expect((await liveRequirements(ASI_KEY)).map((r) => r.code)).toEqual(ASI_CODES);
        });
    });

    describe('IMDA Model AI Governance Framework', () => {
        it('imports every assessable requirement across the four dimensions', async () => {
            const lib = loadLibrary(parseLibraryFile(MGF_FILE), 'imda-mgf-2026.yaml');
            const expectedCodes = lib.framework.nodes.filter((n) => n.assessable).map((n) => n.refId);

            const result = await importLibraryFromFile(prisma, MGF_FILE, OPTS);
            expect(result.action).toBe('created');
            expect(result.requirementsCreated).toBe(expectedCodes.length);

            const reqs = await liveRequirements(MGF_KEY);
            expect(reqs.map((r) => r.code)).toEqual(expectedCodes);

            // Grouping nodes are structure, not assessable rows — the four
            // dimensions must NOT land as requirements a customer has to answer.
            expect(reqs.filter((r) => /^MGF-D\d$/.test(r.code))).toEqual([]);
            expect(new Set(reqs.map((r) => r.section)).size).toBe(4);
        });

        it('re-importing is skipped and leaves one framework with a stable row set', async () => {
            const before = await liveRequirements(MGF_KEY);

            const result = await importLibraryFromFile(prisma, MGF_FILE, OPTS);
            expect(result.action).toBe('skipped');

            expect(await prisma.framework.count({ where: { key: MGF_KEY } })).toBe(1);
            const after = await liveRequirements(MGF_KEY);
            expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
        });
    });
});
