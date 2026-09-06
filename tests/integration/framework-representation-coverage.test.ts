/**
 * Framework coverage across the TWO representations of one framework.
 *
 * Every framework in this repo can exist twice in `Framework`: the row
 * `prisma/seed.ts` writes and the row `library-importer.ts` writes from
 * `src/data/libraries/`. Their `key` values must differ (`Framework.key` is
 * `@unique`), and a tenant's `ControlRequirementLink` rows hang off whichever
 * one its database happened to get. The two disagree on TWO independent axes:
 *
 *   IDENTITY   `sourceUrn` ties them; rows written before that convention
 *              carry `null` and resolve through `LEGACY_KEY_FAMILY_URNS`.
 *   SPELLING   ISO 27001 Annex A control 15 of clause 5 is `A.5.15` in the
 *              library and `5.15` in the seed fixture.
 *
 * `usecases/framework/coverage.ts` and `services/cross-framework-traceability.ts`
 * joined on requirement id and framework key alone, so for such a tenant the
 * two sides never met: a control that IS mapped reported as a gap. Nothing
 * errors — the number is simply wrong, and wrong in the direction that looks
 * like a customer who has done no work.
 *
 * WHY THE FIXTURE HAS TWO FAMILIES. A single-representation fixture passes
 * before and after the fix and proves nothing, and a fixture with only ONE
 * two-representation family cannot separate the two axes. So:
 *
 *   ISO 27001   seed row carries NO `sourceUrn` (the deployed state — an
 *               existing database is not re-seeded), and the two rows spell
 *               Annex A differently. Clause `7` is spelled IDENTICALLY in
 *               both, which is what isolates the identity axis from the
 *               spelling axis inside one family.
 *   SOC 2       both rows carry `sourceUrn`, and both spell `CC6.1` the same.
 *               Nothing here needs the legacy key map.
 *
 * The two mutation proofs therefore land on different assertions:
 *   emptying `LEGACY_KEY_FAMILY_URNS`  reddens both ISO 27001 assertions and
 *                                      leaves SOC 2 green;
 *   neutering `canonicalRequirementCode` reddens ONLY the Annex A assertion.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { computeCoverage, generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { performGapAnalysis } from '@/app-layer/usecases/gap-analysis';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

/** The urn both representations of each family carry, verbatim from the YAML. */
const ISMS_URN = 'urn:inflect:library:iso27001-2022';
const SOC2_URN = 'urn:inflect:library:soc2-2017';

/** The tenant that holds every control, all of them on the SEEDED rows. */
const TA = 'fwrep-tenant-a';
/** The tenant that holds nothing — the negative control and the isolation probe. */
const TB = 'fwrep-tenant-b';
const TENANTS = [TA, TB];

const fx: Record<string, { userId: string }> = {};
const requirementIds = new Map<string, string>();

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: fx[tenantId].userId,
    });

/** `<frameworkKey>::<code>` → requirement id, filled by `createRepresentation`. */
const reqId = (frameworkKey: string, code: string): string => {
    const id = requirementIds.get(`${frameworkKey}::${code}`);
    if (!id) throw new Error(`fixture missing requirement ${frameworkKey}::${code}`);
    return id;
};

async function createRepresentation(
    key: string,
    name: string,
    sourceUrn: string | null,
    requirements: Array<{ code: string; title: string }>,
): Promise<void> {
    const fw = await prisma.framework.create({
        data: { key, name, version: '1', kind: 'ISO_STANDARD', sourceUrn },
    });
    for (const [i, r] of requirements.entries()) {
        const row = await prisma.frameworkRequirement.create({
            data: { frameworkId: fw.id, code: r.code, title: r.title, sortOrder: i },
        });
        requirementIds.set(`${key}::${r.code}`, row.id);
    }
}

async function linkControl(tenantId: string, controlCode: string, requirementId: string): Promise<void> {
    const control = await prisma.control.create({
        data: { tenantId, code: controlCode, name: `Control ${controlCode}`, status: 'IMPLEMENTED' },
    });
    await prisma.controlRequirementLink.create({
        data: { tenantId, controlId: control.id, requirementId },
    });
}

/**
 * `resetDatabase` does not clear Tenant / User / TenantMembership, so the suite
 * clears its own. AuditLog and TenantMembership go through
 * `session_replication_role = 'replica'` because the immutable-audit-log
 * trigger and the last-OWNER guard both fire on an ordinary DELETE and would
 * take the whole suite down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.map((id) => hashForLookup(`owner@${id}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

describeFn('coverage across the two representations of one framework', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
        await clearOwnRows();

        // ISO 27001 — the family that disagrees on BOTH axes.
        await createRepresentation('ISO27001', 'ISO/IEC 27001', null, [
            { code: '5.15', title: 'Access control' },
            { code: '7', title: 'Support' },
        ]);
        await createRepresentation('ISO27001-2022', 'ISO/IEC 27001:2022', ISMS_URN, [
            { code: 'A.5.15', title: 'Access control' },
            { code: '7', title: 'Support' },
        ]);

        // SOC 2 — the family that agrees on the spelling and ties itself
        // together with `sourceUrn` on BOTH rows, needing no legacy key.
        await createRepresentation('SOC2', 'SOC 2', SOC2_URN, [
            { code: 'CC6.1', title: 'Logical access' },
        ]);
        await createRepresentation('SOC2-2017', 'SOC 2 (2017 TSC)', SOC2_URN, [
            { code: 'CC6.1', title: 'Logical access' },
        ]);

        // A curated mapping, authored the way every shipped mapping set is:
        // against the LIBRARY representation of both frameworks.
        const mappingSet = await prisma.requirementMappingSet.create({
            data: {
                sourceFrameworkId: (await prisma.framework.findFirstOrThrow({ where: { key: 'SOC2-2017' } })).id,
                targetFrameworkId: (await prisma.framework.findFirstOrThrow({ where: { key: 'ISO27001-2022' } })).id,
                name: 'SOC 2 → ISO 27001',
            },
        });
        await prisma.requirementMapping.create({
            data: {
                mappingSetId: mappingSet.id,
                sourceRequirementId: reqId('SOC2-2017', 'CC6.1'),
                targetRequirementId: reqId('ISO27001-2022', 'A.5.15'),
                strength: 'EQUAL',
            },
        });

        for (const tenantId of TENANTS) {
            await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
            const email = `owner@${tenantId}.test`;
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            });
            fx[tenantId] = { userId: user.id };
        }

        // Tenant A's whole posture hangs off the SEEDED rows — the state a
        // database provisioned before library-sync ran is actually in.
        await linkControl(TA, 'A-ANNEX-515', reqId('ISO27001', '5.15'));
        await linkControl(TA, 'A-CLAUSE-7', reqId('ISO27001', '7'));
        await linkControl(TA, 'A-SOC2-CC61', reqId('SOC2', 'CC6.1'));
    });

    afterAll(async () => {
        await clearOwnRows();
        // Hand the GLOBAL catalogue back empty. This suite creates four
        // Framework rows plus a mapping set, and a `RequirementMapping` row is
        // a foreign key onto a `FrameworkRequirement`: leaving them behind
        // makes the next suite that deletes a framework by key fail on an FK
        // violation in its own setup, in a file that touched none of this.
        // `resetDatabase` truncates Framework/FrameworkRequirement CASCADE,
        // which takes the mapping set with them.
        await resetDatabase(prisma);
        await prisma.$disconnect();
    });

    // ─── Identity axis ───────────────────────────────────────────────

    it('a clause both representations spell identically is mapped through the legacy-key family', async () => {
        const coverage = await computeCoverage(ctxFor(TA), 'ISO27001-2022');

        // Clause `7` carries no `A.` prefix, so no code canonicalisation is in
        // play: the ONLY thing standing between the seeded link and the
        // library requirement is the family collapse, and the seeded row's
        // `sourceUrn` is null — `LEGACY_KEY_FAMILY_URNS` is what resolves it.
        expect(coverage.unmappedRequirements.map((r) => r.code)).not.toContain('7');
        expect(coverage.controlMappings).toContainEqual(
            expect.objectContaining({ requirementCode: '7', controlCode: 'A-CLAUSE-7' }),
        );
    });

    it('a family whose rows both carry sourceUrn reconciles without any legacy key', async () => {
        const coverage = await computeCoverage(ctxFor(TA), 'SOC2-2017');

        expect(coverage.total).toBe(1);
        expect(coverage.mapped).toBe(1);
        expect(coverage.coveragePercent).toBe(100);
        expect(coverage.controlMappings).toContainEqual(
            expect.objectContaining({ requirementCode: 'CC6.1', controlCode: 'A-SOC2-CC61' }),
        );
    });

    // ─── Spelling axis ───────────────────────────────────────────────

    it('an Annex A control the two representations spell differently is mapped', async () => {
        const coverage = await computeCoverage(ctxFor(TA), 'ISO27001-2022');

        // The tenant's link names `5.15`; this framework declares `A.5.15`.
        // Only `canonicalRequirementCode` makes those one obligation.
        expect(coverage.unmappedRequirements.map((r) => r.code)).not.toContain('A.5.15');
        expect(coverage.controlMappings).toContainEqual(
            expect.objectContaining({ requirementCode: 'A.5.15', controlCode: 'A-ANNEX-515' }),
        );
    });

    // ─── The shape of the answer ─────────────────────────────────────

    it('reports full coverage without inflating the denominator with the sibling representation', async () => {
        const coverage = await computeCoverage(ctxFor(TA), 'ISO27001-2022');

        // TWO, not four: the sibling representation's rows expand which
        // requirements count as MAPPED, never how many there are to map.
        expect(coverage.total).toBe(2);
        expect(coverage.mapped).toBe(2);
        expect(coverage.unmapped).toBe(0);
        expect(coverage.coveragePercent).toBe(100);
    });

    it('the readiness report agrees with the coverage page for the same tenant', async () => {
        const report = await generateReadinessReport(ctxFor(TA), 'ISO27001-2022');

        expect(report.coverage.total).toBe(2);
        expect(report.coverage.mapped).toBe(2);
        expect(report.coverage.coveragePercent).toBe(100);
        expect(report.summary.implementedRequirements).toBe(2);
    });

    it('a tenant that holds no controls still reads as zero', async () => {
        // The negative half, and it is load-bearing: a "fix" that collapsed
        // everything into one family without checking WHOSE links they are
        // would report tenant B as fully covered off tenant A's controls.
        const coverage = await computeCoverage(ctxFor(TB), 'ISO27001-2022');

        expect(coverage.total).toBe(2);
        expect(coverage.mapped).toBe(0);
        expect(coverage.coveragePercent).toBe(0);
        expect(coverage.unmappedRequirements.map((r) => r.code).sort()).toEqual(['7', 'A.5.15']);
    });

    // ─── The mapping side ────────────────────────────────────────────

    it('gap analysis resolves a mapping authored against the other representation', async () => {
        // The mapping names ISO 27001 by its LIBRARY key and its LIBRARY
        // spelling (`ISO27001-2022` / `A.5.15`); the caller asks about the
        // seeded framework (`ISO27001` / `5.15`). Both axes have to collapse
        // or the requirement reads NOT_COVERED — the same wrong number the
        // coverage page produced, on a different surface.
        const result = await performGapAnalysis({
            sourceFrameworkKey: 'SOC2-2017',
            targetFrameworkKey: 'ISO27001',
            // `FrameworkRequirement` has no `assessable` column, so the
            // default filter is a Prisma validation error rather than a
            // narrower query. Out of scope here; see the PR notes.
            includeNonAssessable: true,
            maxDepth: 1,
        });

        expect(result).not.toBeNull();
        const annexA = result!.entries.find((e) => e.targetRequirement.requirementCode === '5.15');
        expect(annexA).toBeDefined();
        expect(annexA!.status).toBe('COVERED');
        expect(annexA!.bestConfidence).toBe('FULL');
    });
});
