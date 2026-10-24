/**
 * Coverage a framework inherits from a tenant's OTHER frameworks, end to end
 * against a real database.
 *
 * The claim under test is the one the mapping sets exist for: a tenant that
 * already holds ISO 42001 controls, opening AIUC-1, sees which requirements
 * those controls reach and through what — rather than fifty blanks — while the
 * framework's own coverage figures stay untouched, because a curated mapping is
 * never coverage.
 *
 * Three tenants, each isolating one claim:
 *
 *   A  the ISO 42001 holder: controls on three ISO 42001 requirements (two
 *      reaching AIUC-1 by INTERSECT, one only by RELATED) and one control on
 *      an AIUC-1 requirement itself. Asserts every status, route and count.
 *   B  the SEEDED representation: one control on the seed row `ISO42001` /
 *      `A.6.2.8`, which the mapping (authored against `ISO42001-2023`) only
 *      reaches through the family collapse. Also the cross-tenant probe.
 *   C  nothing at all: nothing reached, and nothing leaked in from A or B.
 *
 * Frameworks and mappings are GLOBAL rows, imported through the production
 * importers from the shipped YAML, so this exercises the real data.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import * as path from 'path';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { importLibraryFromFile } from '@/app-layer/services/library-importer';
import {
    computeMappingSetHash,
    importMappingSet,
    parseMappingSetFile,
} from '@/app-layer/services/mapping-set-importer';
import { computeCoverage, computeInheritedCoverage } from '@/app-layer/usecases/framework';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const ISO_LIBRARY_URN = 'urn:inflect:library:iso-42001';

const TA = 'inhcov-tenant-a';
const TB = 'inhcov-tenant-b';
const TC = 'inhcov-tenant-c';
const TENANTS = [TA, TB, TC];
const userIds: Record<string, string> = {};

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: userIds[tenantId] });

async function requirementIds(frameworkKey: string): Promise<Map<string, string>> {
    const fw = await prisma.framework.findFirstOrThrow({ where: { key: frameworkKey } });
    const rows = await prisma.frameworkRequirement.findMany({
        where: { frameworkId: fw.id },
        select: { id: true, code: true },
    });
    return new Map(rows.map((r) => [r.code, r.id]));
}

async function linkControl(tenantId: string, controlCode: string, requirementId: string): Promise<void> {
    const control = await prisma.control.create({
        data: { tenantId, code: controlCode, name: `Control ${controlCode}`, status: 'IMPLEMENTED' },
    });
    await prisma.controlRequirementLink.create({
        data: { tenantId, controlId: control.id, requirementId },
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.map((tid) => hashForLookup(`owner@${tid}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

describeFn('framework coverage inherited from other frameworks', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
        await clearOwnRows();

        await importLibraryFromFile(prisma, path.join(LIB_DIR, 'iso-42001.yaml'), { propagateDelta: false });
        await importLibraryFromFile(prisma, path.join(LIB_DIR, 'aiuc-1.yaml'), { propagateDelta: false });
        for (const file of ['iso-42001-to-aiuc-1.yaml', 'aiuc-1-to-iso-42001.yaml']) {
            const set = parseMappingSetFile(path.join(LIB_DIR, 'mappings', file));
            const result = await importMappingSet(prisma, set, computeMappingSetHash(set));
            expect(result.errors).toEqual([]);
        }

        const iso = await requirementIds('ISO42001-2023');
        const aiuc = await requirementIds('AIUC-1');

        // The SEED-shaped representation of ISO 42001 beside the library one:
        // same family urn, different key, one requirement row.
        const isoSeed = await prisma.framework.create({
            data: { key: 'ISO42001', name: 'ISO/IEC 42001', version: '2023', kind: 'INDUSTRY_STANDARD', sourceUrn: ISO_LIBRARY_URN },
        });
        const seededLogging = await prisma.frameworkRequirement.create({
            data: { frameworkId: isoSeed.id, code: 'A.6.2.8', title: 'Event logs', sortOrder: 0 },
        });

        for (const tenantId of TENANTS) {
            await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
            const email = `owner@${tenantId}.test`;
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            });
            userIds[tenantId] = user.id;
        }

        // A: logging (A.6.2.8 → E015, INTERSECT), verification and validation
        // (A.6.2.4 → six testing requirements, INTERSECT), societal impact
        // (A.5.5 → F001 / F002, RELATED only) — and one AIUC-1 control of its own.
        await linkControl(TA, 'A-6.2.8', iso.get('A.6.2.8')!);
        await linkControl(TA, 'A-6.2.4', iso.get('A.6.2.4')!);
        await linkControl(TA, 'A-5.5', iso.get('A.5.5')!);
        await linkControl(TA, 'A-AIUC-A001', aiuc.get('A001')!);

        // B: logging, on the SEEDED row only.
        await linkControl(TB, 'B-6.2.8', seededLogging.id);
    });

    afterAll(async () => {
        await clearOwnRows();
        await resetDatabase(prisma);
        await prisma.$disconnect();
    });

    it('shows an ISO 42001 holder which AIUC-1 requirements their controls reach', async () => {
        const report = await computeInheritedCoverage(ctxFor(TA), 'AIUC-1');

        expect(report.total).toBe(50);
        expect(report.truncated).toBe(false);
        expect(report.summary).toEqual({ direct: 1, partiallyCovered: 7, reviewNeeded: 2, notCovered: 40 });
        expect(Object.fromEntries(report.requirements.map((r) => [r.code, r.status]))).toEqual({
            A009: 'PARTIALLY_COVERED',
            B001: 'PARTIALLY_COVERED',
            C002: 'PARTIALLY_COVERED',
            C010: 'PARTIALLY_COVERED',
            D004: 'PARTIALLY_COVERED',
            E015: 'PARTIALLY_COVERED',
            E018: 'PARTIALLY_COVERED',
            F001: 'REVIEW_NEEDED',
            F002: 'REVIEW_NEEDED',
        });
        expect(report.sourceFrameworks).toEqual([
            { key: 'ISO42001-2023', name: expect.any(String), requirements: 9 },
        ]);
    });

    it('names the route and the tenant control behind each requirement', async () => {
        const report = await computeInheritedCoverage(ctxFor(TA), 'AIUC-1');
        const logging = report.requirements.find((r) => r.code === 'E015')!;

        expect(
            logging.routes.map((r) => [r.frameworkKey, r.requirementCode, r.strength, r.controls.map((c) => c.code)]),
        ).toEqual([['ISO42001-2023', 'A.6.2.8', 'INTERSECT', ['A-6.2.8']]]);
    });

    it('leaves the framework\'s own coverage figures untouched', async () => {
        // Inherited coverage is never coverage: the direct report still counts
        // only the one control linked to an AIUC-1 requirement itself.
        const coverage = await computeCoverage(ctxFor(TA), 'AIUC-1');
        expect(coverage.mapped).toBe(1);
        expect(coverage.unmapped).toBe(49);
    });

    it('reaches a control held on the SEEDED representation of the source framework', async () => {
        const report = await computeInheritedCoverage(ctxFor(TB), 'AIUC-1');

        expect(report.summary).toEqual({ direct: 0, partiallyCovered: 1, reviewNeeded: 0, notCovered: 49 });
        const logging = report.requirements.find((r) => r.code === 'E015')!;
        // Reported under the framework the MAPPING cites, holding the tenant's
        // control on the seeded row.
        expect(
            logging.routes.map((r) => [r.frameworkKey, r.requirementCode, r.controls.map((c) => c.code)]),
        ).toEqual([['ISO42001-2023', 'A.6.2.8', ['B-6.2.8']]]);
    });

    it('keeps one tenant\'s controls out of another\'s report', async () => {
        const b = await computeInheritedCoverage(ctxFor(TB), 'AIUC-1');
        const bControls = b.requirements.flatMap((r) => r.routes.flatMap((x) => x.controls.map((c) => c.code)));
        expect(bControls).toEqual(['B-6.2.8']);

        const c = await computeInheritedCoverage(ctxFor(TC), 'AIUC-1');
        expect(c.requirements).toEqual([]);
        expect(c.sourceFrameworks).toEqual([]);
        expect(c.summary).toEqual({ direct: 0, partiallyCovered: 0, reviewNeeded: 0, notCovered: 50 });
    });

    it('works in the other direction: an AIUC-1 control reaches ISO 42001', async () => {
        const report = await computeInheritedCoverage(ctxFor(TA), 'ISO42001-2023');

        // A001 → A.8.2 and A001 → A.7.2 are both RELATED, so the requirement is
        // flagged for review, never counted.
        const userInfo = report.requirements.find((r) => r.code === 'A.8.2')!;
        expect(userInfo.status).toBe('REVIEW_NEEDED');
        expect(userInfo.routes.map((r) => [r.frameworkKey, r.requirementCode, r.strength])).toEqual([
            ['AIUC-1', 'A001', 'RELATED'],
        ]);
        // The three ISO 42001 requirements A holds controls on read DIRECT.
        expect(report.summary.direct).toBe(3);
    });

    it('refuses a framework that does not exist', async () => {
        await expect(computeInheritedCoverage(ctxFor(TA), 'NO-SUCH-FRAMEWORK')).rejects.toThrow(
            'Framework not found',
        );
    });
});
