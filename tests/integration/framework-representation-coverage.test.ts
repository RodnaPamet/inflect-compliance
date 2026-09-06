/**
 * Framework coverage across the TWO representations of one framework.
 *
 * Every framework in this repo can exist twice in `Framework`: the row
 * `prisma/seed.ts` writes and the row `library-importer.ts` writes from
 * `src/data/libraries/`. Their `key` values must differ (`Framework.key` is
 * `@unique`), and a tenant's `ControlRequirementLink` rows hang off whichever
 * one its database happened to get. The two disagree on TWO independent axes:
 *
 *   IDENTITY   `sourceUrn` ties them; rows an existing database holds without
 *              one resolve through `LEGACY_KEY_FAMILY_URNS`.
 *   SPELLING   ISO 27001 Annex A control 15 of clause 5 is `A.5.15` in the
 *              library and `5.15` in the seed fixture.
 *
 * `usecases/framework/coverage.ts` and `services/cross-framework-traceability.ts`
 * joined on requirement id and framework key alone, so for such a tenant the
 * two sides never met: a control that IS mapped reported as a gap. Nothing
 * errors — the number is simply wrong, and wrong in the direction that looks
 * like a customer who has done no work.
 *
 * FOUR surfaces read those links, and this suite asserts they AGREE. Teaching
 * one of them to reconcile the representations and leaving the others behind is
 * worse than teaching none: coverage then says 100% beside an SoA saying
 * nothing is mapped, and neither says why.
 *
 * WHY THE FIXTURE HAS THREE FAMILIES. A single-representation fixture passes
 * before and after the fix and proves nothing, and one two-representation
 * family cannot separate the axes from each other. So:
 *
 *   ISO 27001   seeded row carries NO `sourceUrn` (the state of a database
 *               provisioned before the seed wrote one — an existing database
 *               is not re-seeded), and the two rows spell Annex A differently.
 *               Clauses `7` and `8` are spelled IDENTICALLY in both, which is
 *               what isolates the identity axis from the spelling axis.
 *   SOC 2       seeded row carries no `sourceUrn` either — the seed wrote none
 *               at all until the fix, and an existing database is never
 *               re-seeded — and both rows spell `CC6.1` the same. The identity
 *               axis alone, with no spelling difference to hide behind.
 *   ISO 42001   BOTH rows carry `sourceUrn`, so nothing here needs the legacy
 *               map, and both carry clause `8.2` AND Annex control `A.8.2` —
 *               different obligations. The `A.` strip is scoped to the ISO
 *               27001 family precisely so this family does not merge them.
 *
 * The mutation proofs land on different sets, and what each one leaves GREEN
 * is the load-bearing half — a mutation that reddens everything separates
 * nothing. Measured against this file, not asserted from the design:
 *
 *   emptying `LEGACY_KEY_FAMILY_URNS` reddens 9 of the 14 — every assertion
 *       that needs a SEEDED row to reach its library sibling — and leaves 5
 *       green. BOTH ISO 42001 ones are in that five, which is the separating
 *       half: those two rows carry the urn, so no legacy key was ever in play
 *       for them. The other three are green for a duller reason and NOT
 *       because the family collapsed — nothing in them depends on the seeded
 *       row being reached at all. `a control linked to BOTH representations`
 *       and `the SoA honours the override` both read the A-DUAL control's own
 *       library-side link, which this framework declares directly; `a tenant
 *       that holds no controls` is the negative control, and no mutation that
 *       narrows reach can turn it red. So do not read this as "every ISO
 *       27001 assertion reddens" — three of them do not.
 *   neutering `canonicalRequirementCode` to the identity leaves the clause `7`
 *       assertion green — `7` is spelled the same in both representations, so
 *       that one and only that one isolates identity from spelling. (It does
 *       NOT redden only the Annex A assertion: every ISO 27001 total, the
 *       readiness report, the SoA, the tree and the gap analysis go with it,
 *       because they all count the same requirement.)
 *   making the `A.` strip family-blind reddens ONLY the two ISO 42001
 *       assertions: that family carries clause `8.2` AND Annex `A.8.2` as
 *       different obligations, and a blanket strip merges them.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { computeCoverage, generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { getFrameworkTree } from '@/app-layer/usecases/framework/tree';
import { getSoA } from '@/app-layer/usecases/soa';
import { getRequirementTraceability, performGapAnalysis } from '@/app-layer/usecases/gap-analysis';
import type { FrameworkTreeNode } from '@/lib/framework-tree/types';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

/** The urn both representations of each family carry, verbatim from the YAML. */
const ISMS_URN = 'urn:inflect:library:iso27001-2022';
const SOC2_URN = 'urn:inflect:library:soc2-2017';
const AIMS_URN = 'urn:inflect:library:iso-42001';

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

/**
 * One control, linked to one or more requirements.
 *
 * The multi-link form exists for exactly one shape: a control the tenant has
 * attached to BOTH representations of one obligation. That is the only way
 * `@@unique([controlId, requirementId])` stops guaranteeing "at most one link
 * per (requirement, control)" once the representations are collapsed.
 */
async function linkControl(
    tenantId: string,
    controlCode: string,
    links: Array<{ requirementId: string; applicability?: 'APPLICABLE' | 'NOT_APPLICABLE'; justification?: string }>,
): Promise<void> {
    const control = await prisma.control.create({
        data: { tenantId, code: controlCode, name: `Control ${controlCode}`, status: 'IMPLEMENTED' },
    });
    for (const link of links) {
        await prisma.controlRequirementLink.create({
            data: {
                tenantId,
                controlId: control.id,
                requirementId: link.requirementId,
                applicability: link.applicability ?? null,
                applicabilityJustification: link.justification ?? null,
            },
        });
    }
}

/** Depth-first lookup — the tree builder nests requirements under synthesized sections. */
function findNode(nodes: readonly FrameworkTreeNode[], code: string): FrameworkTreeNode | undefined {
    for (const node of nodes) {
        if (node.code === code) return node;
        const hit = findNode(node.children, code);
        if (hit) return hit;
    }
    return undefined;
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
            { code: '8', title: 'Operation' },
        ]);
        await createRepresentation('ISO27001-2022', 'ISO/IEC 27001:2022', ISMS_URN, [
            { code: 'A.5.15', title: 'Access control' },
            { code: '7', title: 'Support' },
            { code: '8', title: 'Operation' },
        ]);

        // SOC 2 — the identity axis on its own. The seeded row carries no urn
        // (`prisma/seed.ts` wrote none), so ONLY the legacy key map ties it.
        await createRepresentation('SOC2', 'SOC 2', null, [
            { code: 'CC6.1', title: 'Logical access' },
        ]);
        await createRepresentation('SOC2-2017', 'SOC 2 (2017 TSC)', SOC2_URN, [
            { code: 'CC6.1', title: 'Logical access' },
        ]);

        // ISO 42001 — tied by `sourceUrn` on both rows, needing no legacy key,
        // and carrying the clause/Annex code collision that makes the ISO
        // 27001 `A.` strip family-scoped rather than global.
        for (const key of ['AIMS-SEED', 'AIMS-LIB']) {
            await createRepresentation(key, `ISO/IEC 42001 (${key})`, AIMS_URN, [
                { code: '8.2', title: 'AI risk assessment' },
                { code: 'A.8.2', title: 'System documentation' },
            ]);
        }

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
        await linkControl(TA, 'A-ANNEX-515', [{ requirementId: reqId('ISO27001', '5.15') }]);
        await linkControl(TA, 'A-CLAUSE-7', [{ requirementId: reqId('ISO27001', '7') }]);
        await linkControl(TA, 'A-SOC2-CC61', [{ requirementId: reqId('SOC2', 'CC6.1') }]);
        await linkControl(TA, 'A-AIMS-CLAUSE82', [{ requirementId: reqId('AIMS-SEED', '8.2') }]);

        // …except this one, which the tenant attached to BOTH representations
        // of clause 8, and scoped OUT against the library one. Two links, one
        // control, one obligation.
        await linkControl(TA, 'A-DUAL', [
            { requirementId: reqId('ISO27001', '8') },
            {
                requirementId: reqId('ISO27001-2022', '8'),
                applicability: 'NOT_APPLICABLE',
                justification: 'Scoped out for the ISMS certification boundary',
            },
        ]);
    });

    afterAll(async () => {
        await clearOwnRows();
        // Hand the GLOBAL catalogue back empty. This suite creates six
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

    it('a seeded SOC 2 row with no sourceUrn reconciles through the legacy key', async () => {
        // `prisma/seed.ts` now writes the urn, but an existing database is
        // never re-seeded, so its `SOC2` row still carries none — that is the
        // row this fixture models. Both representations spell `CC6.1`
        // identically, so this assertion depends on the `SOC2` entry in
        // `LEGACY_KEY_FAMILY_URNS` and on nothing else.
        const coverage = await computeCoverage(ctxFor(TA), 'SOC2-2017');

        expect(coverage.total).toBe(1);
        expect(coverage.mapped).toBe(1);
        expect(coverage.coveragePercent).toBe(100);
        expect(coverage.controlMappings).toContainEqual(
            expect.objectContaining({ requirementCode: 'CC6.1', controlCode: 'A-SOC2-CC61' }),
        );
    });

    it('a family whose rows both carry sourceUrn reconciles without any legacy key', async () => {
        const coverage = await computeCoverage(ctxFor(TA), 'AIMS-LIB');

        // The control hangs off the SEEDED clause `8.2`, and only the urn ties
        // the two rows: neither key appears in `LEGACY_KEY_FAMILY_URNS`.
        expect(coverage.controlMappings).toContainEqual(
            expect.objectContaining({ requirementCode: '8.2', controlCode: 'A-AIMS-CLAUSE82' }),
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

    it('the A. strip stays inside the ISO 27001 family, so 8.2 and A.8.2 stay apart', async () => {
        // ISO 42001 carries clause `8.2` (AI risk assessment) AND Annex control
        // `A.8.2` (system documentation) in BOTH representations — different
        // obligations. A family-blind strip would let the clause-8.2 control
        // satisfy the Annex control, inflating coverage on a route that works.
        const coverage = await computeCoverage(ctxFor(TA), 'AIMS-LIB');

        expect(coverage.total).toBe(2);
        expect(coverage.mapped).toBe(1);
        expect(coverage.unmappedRequirements.map((r) => r.code)).toEqual(['A.8.2']);
    });

    // ─── The shape of the answer ─────────────────────────────────────

    it('reports full coverage without inflating the denominator with the sibling representation', async () => {
        const coverage = await computeCoverage(ctxFor(TA), 'ISO27001-2022');

        // THREE, not six: the sibling representation's rows expand which
        // requirements count as MAPPED, never how many there are to map.
        expect(coverage.total).toBe(3);
        expect(coverage.mapped).toBe(3);
        expect(coverage.unmapped).toBe(0);
        expect(coverage.coveragePercent).toBe(100);
    });

    it('a control linked to BOTH representations of one obligation is reported once', async () => {
        // `@@unique([controlId, requirementId])` used to make this impossible;
        // collapsing the two representations onto one requirement row is what
        // re-opens it. Two identical `controlMappings` entries would also be
        // two identical rows in the coverage CSV export.
        const coverage = await computeCoverage(ctxFor(TA), 'ISO27001-2022');

        const dual = coverage.controlMappings.filter(
            (m) => m.requirementCode === '8' && m.controlCode === 'A-DUAL',
        );
        expect(dual).toHaveLength(1);
    });

    it('the readiness report agrees with the coverage page for the same tenant', async () => {
        const report = await generateReadinessReport(ctxFor(TA), 'ISO27001-2022');

        expect(report.coverage.total).toBe(3);
        expect(report.coverage.mapped).toBe(3);
        expect(report.coverage.coveragePercent).toBe(100);
        // Clause 8's only control is scoped out against THIS framework, so it
        // is neither implemented nor a gap — the other two are implemented.
        expect(report.summary.implementedRequirements).toBe(2);
        expect(report.summary.gapRequirements).toBe(0);
    });

    it('the SoA agrees with the coverage page for the same tenant', async () => {
        // The contradiction this closes: coverage saying 100% while the SoA,
        // reading the same links a requirement id at a time, said every
        // requirement was unmapped.
        const soa = await getSoA(ctxFor(TA), { framework: 'ISO27001-2022' });

        expect(soa.summary.total).toBe(3);
        expect(soa.summary.unmapped).toBe(0);
        expect(soa.entries.map((e) => e.requirementCode).sort()).toEqual(['7', '8', 'A.5.15']);

        const annexA = soa.entries.find((e) => e.requirementCode === 'A.5.15');
        expect(annexA?.applicable).toBe(true);
        expect(annexA?.mappedControls.map((c) => c.code)).toEqual(['A-ANNEX-515']);
    });

    it('the SoA honours the override written against the framework being asked about', async () => {
        const soa = await getSoA(ctxFor(TA), { framework: 'ISO27001-2022' });

        const clause8 = soa.entries.find((e) => e.requirementCode === '8');
        // One row, not two, even though the control arrives through two links.
        expect(clause8?.mappedControls).toHaveLength(1);
        // …and the surviving link is the one naming THIS framework, whose
        // per-framework `applicability` override scopes the control out.
        expect(clause8?.applicable).toBe(false);
        expect(clause8?.justification).toBe('Scoped out for the ISMS certification boundary');
    });

    it('the framework tree agrees with the coverage page for the same tenant', async () => {
        // Before the collapse this tree decorated every node `gap` for this
        // tenant while `computeCoverage` reported 100% off the same links.
        const tree = await getFrameworkTree(ctxFor(TA), 'ISO27001-2022');

        expect(findNode(tree.nodes, 'A.5.15')?.complianceStatus).toBe('compliant');
        expect(findNode(tree.nodes, '7')?.complianceStatus).toBe('compliant');
        // Clause 8 reads `compliant` here and NOT APPLICABLE on the SoA above,
        // and that divergence is NOT this fix's: the tree decorator reads
        // `Control.applicability` (its global column) and has never read the
        // per-framework `ControlRequirementLink.applicability` override that
        // the SoA and the readiness rollup both resolve. It predates the
        // collapse and is reachable without two representations — any tenant
        // scoping a control out of one framework sees it. Pinned here as the
        // measured behaviour rather than silently widened into this PR.
        expect(findNode(tree.nodes, '8')?.complianceStatus).toBe('compliant');
    });

    it('a tenant that holds no controls still reads as zero', async () => {
        // The negative half, and it is load-bearing: a "fix" that collapsed
        // everything into one family without checking WHOSE links they are
        // would report tenant B as fully covered off tenant A's controls.
        const coverage = await computeCoverage(ctxFor(TB), 'ISO27001-2022');

        expect(coverage.total).toBe(3);
        expect(coverage.mapped).toBe(0);
        expect(coverage.coveragePercent).toBe(0);
        expect(coverage.unmappedRequirements.map((r) => r.code).sort()).toEqual(['7', '8', 'A.5.15']);

        const soa = await getSoA(ctxFor(TB), { framework: 'ISO27001-2022' });
        expect(soa.summary.unmapped).toBe(3);
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

    it('single-requirement traceability resolves the same mapping', async () => {
        // The sibling of the usecase above, and it needs its own test: it
        // builds the target-key list and calls `buildTraceabilityReport`
        // itself, so reverting ITS two lines leaves `performGapAnalysis`
        // untouched and every mapping suite green.
        const report = await getRequirementTraceability({
            sourceRequirementId: reqId('SOC2-2017', 'CC6.1'),
            targetFrameworkKey: 'ISO27001',
            maxDepth: 1,
        });

        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].confidence).toBe('FULL');
        // The mapping lands on the LIBRARY row; the caller asked about the
        // seeded key. Both have to be recognised as one framework.
        expect(report.findings[0].target.frameworkKey).toBe('ISO27001-2022');
        expect(report.summary.bestConfidence).toBe('FULL');
    });
});
