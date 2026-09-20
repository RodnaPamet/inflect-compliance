/**
 * COSO ICF 2013 reaches a database through the production import path.
 *
 * ── WHAT THIS PROVES THAT THE LIBRARY GUARD CANNOT ──────────────────────────
 *
 * `tests/guardrails/coso-framework-coverage.test.ts` reads the YAML and asserts
 * the enumeration is complete. That is a claim about a FILE. This is the claim
 * about a DATABASE: that `importLibraryFromFile` — the same function the runtime
 * import uses — turns that file into a `Framework` row and 17 assessable
 * `FrameworkRequirement` rows, and that running it twice does not duplicate
 * them.
 *
 * The distinction is not academic here. `FrameworkRequirement` carries
 * `@@unique([frameworkId, code])`, so double-sourcing cannot silently duplicate
 * — it THROWS. A second import that was not short-circuited by the content hash
 * would not quietly add rows; it would fail the next deploy's seed. So the
 * re-import assertion below is about deploy safety, not tidiness.
 *
 * ── THE COMPONENTS ARE NOT REQUIREMENTS, AND THAT IS THE POINT ──────────────
 *
 * 22 nodes go in and 17 assessable rows come out. The five components are
 * grouping nodes; `library-importer` records them in the tree but they are not
 * assessable, so nothing can be "compliant with the Control Environment". That
 * asymmetry is what makes the principle the unit a control links to, which is
 * what the content PRs depend on.
 */
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { importLibraryFromFile } from '@/app-layer/services/library-importer';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const ROOT = path.resolve(__dirname, '../..');
const COSO_FILE = path.join(ROOT, 'src/data/libraries/coso-icf-2013.yaml');

const PRINCIPLES = Array.from({ length: 17 }, (_, i) => `P${i + 1}`);

describeFn('the COSO library imports into a database', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('creates the framework and its 17 assessable requirements', async () => {
        const result = await importLibraryFromFile(prisma, COSO_FILE, { propagateDelta: false });

        expect(result.action).toBe('created');
        expect(result.frameworkKey).toBeTruthy();

        const framework = await prisma.framework.findFirst({
            where: { key: result.frameworkKey },
            include: { requirements: true },
        });
        expect(framework).not.toBeNull();
        expect(result.frameworkKey).toBe('COSO-ICF-2013');
        expect(result.requirementsCreated).toBe(17);

        // UNFILTERED on purpose. An earlier draft selected `/^P\d+$/` before
        // comparing, which would have hidden the very thing the next test
        // claims to check: a component arriving as a requirement row would have
        // been filtered out and the assertion would still have passed. The set
        // equality below is the whole stored set, so a 23rd row of any shape
        // fails here.
        const codes = (framework?.requirements ?? [])
            .map((r) => r.code)
            .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        expect(codes).toEqual(PRINCIPLES);
    });

    it('is a no-op on re-import rather than a duplicate-key failure', async () => {
        const before = await prisma.frameworkRequirement.count();

        // The same file again. `@@unique([frameworkId, code])` means an import
        // that failed to short-circuit would THROW here rather than add rows —
        // which is why this asserts the count AND that the call resolves.
        const second = await importLibraryFromFile(prisma, COSO_FILE, { propagateDelta: false });

        const after = await prisma.frameworkRequirement.count();
        expect(after).toBe(before);
        expect(second.requirementsCreated).toBe(0);
        expect(second.requirementsDeprecated).toBe(0);
    });

    it('stores the 17 principles and NONE of the five components', async () => {
        // The first draft of this test looped the component rows asserting each
        // was not in PRINCIPLES — which cannot fail, because 'CE' is never 'P4'.
        // An assertion that cannot fail is the defect this repo keeps finding,
        // and writing one inside a test whose whole subject is "did the right
        // rows land" would have been the worst place to put it.
        //
        // The real claim is a COUNT and a SET: the importer writes assessable
        // nodes only, measured at exactly 17 with no component among them. If
        // grouping nodes ever start being written, this fails — which is the
        // point, because a component that became assessable would be something
        // a tenant could be "compliant with", and a control could link to an
        // obligation that states nothing testable.
        const rows = await prisma.frameworkRequirement.findMany({
            where: { framework: { key: 'COSO-ICF-2013' } },
            select: { code: true },
        });
        expect(rows).toHaveLength(17);
        const codes = new Set(rows.map((r) => r.code));
        for (const component of ['CE', 'RA', 'CA', 'IC', 'MA']) {
            expect(codes.has(component)).toBe(false);
        }
    });
});
