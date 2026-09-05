/**
 * Per-agent agentic-risk coverage, end to end against a real database.
 *
 * The measured gap this suite guards: before `computeAgentRiskCoverage`,
 * `AiSystemRequirementLink` had ZERO read sites in `src/` and
 * `usecases/framework/coverage.ts` joined `ControlRequirementLink` only, so
 * "which agentic risks is THIS agent covered for" was unanswerable. The whole
 * point of the answer is WHICH — a percentage tells an assessor nothing about
 * the risk that is open — so every assertion here names codes.
 *
 * Four tenants, each isolating one claim:
 *
 *   A  the ordinary case — scoped to all ten risks, controls for two of them.
 *      Asserts the COVERED and UNCOVERED lists exactly, element for element.
 *   B  cross-tenant. B holds the control for the risk A is missing. If tenant
 *      scoping leaked, A's uncovered list would silently shrink by one — a
 *      leak that makes the product look BETTER, which is the kind nobody
 *      reports.
 *   C  the commercial claim. C holds no agentic controls at all, only two ISO
 *      42001 controls, and still starts above zero: the shipped
 *      `iso-42001-to-owasp-agentic.yaml` mapping, imported through the real
 *      mapping-set importer, lights three risks as partially covered.
 *   D  the per-agent gate. Same tenant as A, same controls, an agent whose
 *      AI-system entry was never scoped. Nothing is COVERED. Delete the
 *      `scopedToAgent` conjunction and this is the test that fails — every
 *      other assertion in the file would still pass.
 *   F  the ISMS holder, built as `prisma/seed.ts` ACTUALLY writes ISO 27001:
 *      key `ISO27001`, Annex A numbered `5.15` (the library numbers the same
 *      control `A.5.15`), and — for the half of the run that models an
 *      already-provisioned database — no `sourceUrn` at all. Tenant D proves
 *      the seeded representation resolves for ISO 42001, where both
 *      representations agree on both axes; ISO 27001 agrees on NEITHER, and
 *      nothing in this suite built that shape, which is why an ISMS route
 *      that returned ten NOT_COVERED shipped looking correct.
 *
 * Frameworks and mappings are GLOBAL rows (no tenantId, no RLS), so the suite
 * imports them through the production path and owns the catalogue outright:
 * `resetDatabase` truncates Framework/FrameworkRequirement CASCADE, which is
 * why the import happens after it and the tenant fixtures after that.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { importLibraryFromFile } from '@/app-layer/services/library-importer';
import {
    computeMappingSetHash,
    importMappingSet,
    parseMappingSetFile,
} from '@/app-layer/services/mapping-set-importer';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { computeAgentRiskCoverage } from '@/app-layer/usecases/agent-coverage';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const ASI_FILE = path.join(LIB_DIR, 'owasp-agentic-top10.yaml');
const ISO_FILE = path.join(LIB_DIR, 'iso-42001.yaml');
const ISMS_FILE = path.join(LIB_DIR, 'iso27001-2022.yaml');
const MAP_FILE = path.join(LIB_DIR, 'mappings/iso-42001-to-owasp-agentic.yaml');
const ISMS_MAP_FILE = path.join(LIB_DIR, 'mappings/iso27001-to-owasp-agentic.yaml');

const ASI_CODES = [
    'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05',
    'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
];

const TA = 'agentcov-tenant-a';
const TB = 'agentcov-tenant-b';
const TC = 'agentcov-tenant-c';
const TD = 'agentcov-tenant-d';
const TF = 'agentcov-tenant-f';
const TENANTS = [TA, TB, TC, TD, TF];

/**
 * The library URN both representations of a framework carry — `prisma/seed.ts`
 * writes it verbatim as `Framework.sourceUrn`, and `library-importer.ts` writes
 * `library.urn`. It is the only thing that ties the seeded row (`OWASP-ASI`) to
 * the library row (`OWASP-ASI-TOP10`), whose `key` values must differ because
 * `Framework.key` is `@unique`.
 */
const ASI_LIBRARY_URN = 'urn:inflect:library:owasp-agentic-top10';
const ISO_LIBRARY_URN = 'urn:inflect:library:iso-42001';
const ISMS_LIBRARY_URN = 'urn:inflect:library:iso27001-2022';

/**
 * The six Annex A controls this mapping names as sources for ASI03, four of
 * them SUBSET — spelled the way the LIBRARY spells them, which is how
 * `iso27001-to-owasp-agentic.yaml` had to be authored (the importer resolves
 * refs against library keys). Tenant F holds a control on the SEEDED row for
 * each, spelled without the `A.`.
 */
const ISMS_ASI03_SOURCES = ['A.5.15', 'A.5.17', 'A.8.2', 'A.8.5', 'A.5.3', 'A.8.15'];
const seededAnnexACode = (libraryCode: string) => libraryCode.replace(/^A\./, '');

interface Fixture {
    userId: string;
    aiSystemId: string;
    agentId: string;
}
const fx: Record<string, Fixture> = {};
/** Tenant A's second agent: registered, but never scoped to any risk. */
let unscopedAgentId = '';

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: fx[tenantId].userId,
    });

/** Requirement rows by code, for whichever framework key is asked for. */
async function requirementIds(frameworkKey: string): Promise<Map<string, string>> {
    const fw = await prisma.framework.findFirstOrThrow({ where: { key: frameworkKey } });
    const rows = await prisma.frameworkRequirement.findMany({
        where: { frameworkId: fw.id },
        select: { id: true, code: true },
    });
    return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * Build the SEED-shaped representation of a framework beside the library one:
 * same `sourceUrn`, different `key`, same requirement codes. This is not a
 * contrivance — every framework in this repo ships in exactly these two
 * representations, and a tenant seeded before library-sync ran has its controls
 * hanging off the seeded rows.
 */
async function seedRepresentation(
    key: string,
    name: string,
    version: string,
    sourceUrn: string | null,
    requirements: Array<{ code: string; title: string }>,
): Promise<Map<string, string>> {
    const fw = await prisma.framework.create({
        data: { key, name, version, kind: 'INDUSTRY_STANDARD', sourceUrn },
    });
    const out = new Map<string, string>();
    for (const [i, req] of requirements.entries()) {
        const row = await prisma.frameworkRequirement.create({
            data: { frameworkId: fw.id, code: req.code, title: req.title, sortOrder: i },
        });
        out.set(req.code, row.id);
    }
    return out;
}

async function linkControl(
    tenantId: string,
    controlCode: string,
    requirementId: string,
): Promise<void> {
    const control = await prisma.control.create({
        data: { tenantId, code: controlCode, name: `Control ${controlCode}`, status: 'IMPLEMENTED' },
    });
    await prisma.controlRequirementLink.create({
        data: { tenantId, controlId: control.id, requirementId },
    });
}

/**
 * `resetDatabase` truncates none of the agent-register tables, so the suite
 * clears its own. AuditLog / TenantMembership go through
 * `session_replication_role = 'replica'` because the immutable-audit-log
 * trigger and the last-OWNER guard both fire on an ordinary DELETE and would
 * take the teardown — and therefore the whole suite — down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

describeFn('per-agent agentic-risk coverage', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
        await clearOwnRows();

        // The global catalogue, through the production import path. Mapping
        // sets go second: they resolve requirement CODES against rows the
        // framework import has to have created first.
        await importLibraryFromFile(prisma, ISO_FILE, { propagateDelta: false });
        await importLibraryFromFile(prisma, ISMS_FILE, { propagateDelta: false });
        await importLibraryFromFile(prisma, ASI_FILE, { propagateDelta: false });
        for (const file of [MAP_FILE, ISMS_MAP_FILE]) {
            const mappingSet = parseMappingSetFile(file);
            const result = await importMappingSet(prisma, mappingSet, computeMappingSetHash(mappingSet));
            // Every curated entry has to have resolved — an unresolved ref is
            // recorded and skipped, so the map would silently do less than it says.
            expect(result.errors).toEqual([]);
        }

        const asi = await requirementIds('OWASP-ASI-TOP10');
        const iso = await requirementIds('ISO42001-2023');

        // The seeded representation of the same two frameworks, alongside the
        // imported one. Tenant D's whole posture hangs off THESE rows.
        const asiSeed = await seedRepresentation(
            'OWASP-ASI',
            'OWASP Agentic AI Top 10',
            '1.0',
            ASI_LIBRARY_URN,
            ASI_CODES.map((code) => ({ code, title: `Risk ${code}` })),
        );
        const isoSeed = await seedRepresentation(
            'ISO42001',
            'ISO/IEC 42001:2023',
            '2023',
            ISO_LIBRARY_URN,
            [{ code: 'A.4.2', title: 'Document an inventory of AI system resources' }],
        );
        // The ISMS, as a REAL database holds it: the whole 93-row Annex A from
        // `prisma/fixtures/iso27001_2022_annexA.json`, numbered without the
        // `A.` the library uses, and — this is the deployed state, not a
        // contrivance — no `sourceUrn`, because `prisma/seed.ts` did not write
        // one until this change and an existing database is not re-seeded.
        const annexA = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'prisma/fixtures/iso27001_2022_annexA.json'), 'utf8'),
        ) as Array<{ key: string; title: string }>;
        const ismsSeed = await seedRepresentation(
            'ISO27001',
            'ISO/IEC 27001',
            '2022',
            null,
            annexA.map((r) => ({ code: r.key, title: r.title })),
        );

        for (const tenantId of TENANTS) {
            await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
            const email = `owner@${tenantId}.test`;
            const user = await prisma.user.create({
                data: { email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            });
            const aiSystem = await prisma.aiSystem.create({
                data: { tenantId, name: `Agent host ${tenantId}`, ownerUserId: user.id },
            });
            fx[tenantId] = { userId: user.id, aiSystemId: aiSystem.id, agentId: '' };

            const agent = await createRegisteredAgent(ctxFor(tenantId), {
                aiSystemId: aiSystem.id,
                name: `Agent ${tenantId}`,
                autonomyLevel: 3,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: user.id,
            });
            fx[tenantId].agentId = agent.id;

            // Every tenant scopes its agent's AI-system entry to all ten risks:
            // the scope is held constant so the differences below are about
            // CONTROLS, not about who filled in the register. Tenants D and F
            // scope against the SEEDED rows — a different id space for the
            // same ten codes.
            const scopeIds = tenantId === TD || tenantId === TF ? asiSeed : asi;
            await prisma.aiSystemRequirementLink.createMany({
                data: ASI_CODES.map((code) => ({
                    tenantId,
                    aiSystemId: aiSystem.id,
                    requirementId: scopeIds.get(code)!,
                })),
            });
        }

        // A: controls for two agentic risks.
        await linkControl(TA, 'A-ASI01', asi.get('ASI01')!);
        await linkControl(TA, 'A-ASI02', asi.get('ASI02')!);

        // B: the control for the risk A is missing — the cross-tenant probe.
        await linkControl(TB, 'B-ASI08', asi.get('ASI08')!);

        // C: no agentic controls at all. Two ISO 42001 controls, which is the
        // posture the "already holds ISO 42001" customer walks in with.
        await linkControl(TC, 'C-ISO-A42', iso.get('A.4.2')!);
        await linkControl(TC, 'C-ISO-A94', iso.get('A.9.4')!);

        // D: everything on the SEEDED representation — one agentic control on
        // the seeded ASI01 row, one ISO 42001 control on the seeded A.4.2 row.
        // The shipped mapping was authored against the LIBRARY keys, so both
        // the direct and the inherited answer here require the family collapse.
        await linkControl(TD, 'D-ASI01', asiSeed.get('ASI01')!);
        await linkControl(TD, 'D-ISO-A42', isoSeed.get('A.4.2')!);

        // F: an ISMS and nothing else. One control per ASI03 source row, on
        // the SEEDED Annex A numbering. Six controls, four of the six edges
        // SUBSET — the posture the "we already run an ISO 27001 ISMS"
        // customer walks in with, and the population the ISMS-side route was
        // built for.
        for (const libraryCode of ISMS_ASI03_SOURCES) {
            const code = seededAnnexACode(libraryCode);
            await linkControl(TF, `F-ISMS-${code}`, ismsSeed.get(code)!);
        }

        // A second agent in tenant A, on its own AI-system entry, with NO
        // requirement links at all.
        const unscopedSystem = await prisma.aiSystem.create({
            data: { tenantId: TA, name: 'Unscoped agent host', ownerUserId: fx[TA].userId },
        });
        const unscoped = await createRegisteredAgent(ctxFor(TA), {
            aiSystemId: unscopedSystem.id,
            name: 'Unscoped agent',
            autonomyLevel: 1,
            dataAccessScope: 'READ_METADATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: fx[TA].userId,
        });
        unscopedAgentId = unscoped.id;
    });

    afterAll(async () => {
        await clearOwnRows();
        // Hand the GLOBAL catalogue back empty. This suite imports two
        // libraries and a mapping set, and a `RequirementMapping` row is a
        // foreign key onto a `FrameworkRequirement`: leaving them behind makes
        // the next suite that deletes a framework by key fail on an FK
        // violation in its own setup, in a file that touched none of this.
        // `resetDatabase` truncates Framework/FrameworkRequirement CASCADE,
        // which takes the mapping sets with them.
        await resetDatabase(prisma);
        await prisma.$disconnect();
    });

    describe('A — the ordinary case', () => {
        it('names the two risks it covers and the eight it does not', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TA), fx[TA].agentId);

            expect(report.frameworkInstalled).toBe(true);
            expect(report.summary.covered).toEqual(['ASI01', 'ASI02']);
            expect(report.summary.uncovered).toEqual([
                'ASI03', 'ASI04', 'ASI05', 'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
            ]);
            expect(report.summary.coveragePercent).toBe(20);
        });

        it('reports every one of the ten risks exactly once, in publication order', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TA), fx[TA].agentId);
            expect(report.entries.map((e) => e.code)).toEqual(ASI_CODES);
        });

        it('says WHY ASI08 is open and which control closes ASI01', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TA), fx[TA].agentId);
            const byCode = new Map(report.entries.map((e) => [e.code, e]));

            const cascading = byCode.get('ASI08')!;
            expect(cascading.status).toBe('NOT_COVERED');
            expect(cascading.reason).toBe('NO_CONTROL');
            expect(cascading.scopedToAgent).toBe(true);
            expect(cascading.directControls).toEqual([]);

            const hijack = byCode.get('ASI01')!;
            expect(hijack.status).toBe('COVERED');
            expect(hijack.reason).toBeNull();
            expect(hijack.directControls.map((c) => c.code)).toEqual(['A-ASI01']);
        });

        it('partitions all ten risks across the four buckets', async () => {
            const { summary } = await computeAgentRiskCoverage(ctxFor(TA), fx[TA].agentId);
            const all = [
                ...summary.covered,
                ...summary.partiallyCovered,
                ...summary.reviewNeeded,
                ...summary.uncovered,
            ].sort();
            expect(all).toEqual(ASI_CODES);
        });
    });

    describe('B — two-tenant isolation', () => {
        it('does not let tenant B\'s control close tenant A\'s ASI08 gap', async () => {
            const a = await computeAgentRiskCoverage(ctxFor(TA), fx[TA].agentId);
            const b = await computeAgentRiskCoverage(ctxFor(TB), fx[TB].agentId);

            expect(a.summary.uncovered).toContain('ASI08');
            expect(b.summary.covered).toEqual(['ASI08']);
            expect(b.summary.uncovered).toEqual([
                'ASI01', 'ASI02', 'ASI03', 'ASI04', 'ASI05', 'ASI06', 'ASI07', 'ASI09', 'ASI10',
            ]);
        });

        it('refuses to read another tenant\'s agent at all', async () => {
            await expect(
                computeAgentRiskCoverage(ctxFor(TB), fx[TA].agentId),
            ).rejects.toThrow(/not found/i);
        });
    });

    describe('C — an ISO 42001 holder does not start at zero', () => {
        it('inherits partial coverage from ISO 42001 controls through the shipped mapping', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TC), fx[TC].agentId);

            // Nothing is COVERED: inherited coverage is capped, on purpose.
            expect(report.summary.covered).toEqual([]);
            // A.4.2 → ASI10 (SUBSET) and A.9.4 → ASI01 / ASI02 (INTERSECT).
            expect(report.summary.partiallyCovered).toEqual(['ASI01', 'ASI02', 'ASI10']);
            expect(report.summary.uncovered).toEqual([
                'ASI03', 'ASI04', 'ASI05', 'ASI06', 'ASI07', 'ASI08', 'ASI09',
            ]);
        });

        it('shows which ISO 42001 requirement and control the coverage came from', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TC), fx[TC].agentId);
            const rogue = report.entries.find((e) => e.code === 'ASI10')!;

            expect(rogue.status).toBe('PARTIALLY_COVERED');
            expect(rogue.directControls).toEqual([]);
            // Strongest route first: A.4.2 is SUBSET, A.9.4 is RELATED.
            expect(
                rogue.inheritedFrom.map((i) => [i.frameworkKey, i.requirementCode, i.strength]),
            ).toEqual([
                ['ISO42001-2023', 'A.4.2', 'SUBSET'],
                ['ISO42001-2023', 'A.9.4', 'RELATED'],
            ]);
            expect(rogue.inheritedFrom[0].controls.map((c) => c.code)).toEqual(['C-ISO-A42']);
        });
    });

    describe('D — two representations of one framework', () => {
        it('counts a control hanging off the SEEDED rows, not just the imported ones', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TD), fx[TD].agentId);

            // Tenant D holds no rows at all in the library id space. A
            // single-key lookup reports this tenant as covering nothing, and
            // "covers nothing" is indistinguishable from a tenant that has
            // done no work — which is why the family is resolved by sourceUrn.
            expect(report.frameworkInstalled).toBe(true);
            expect(report.entries.map((e) => e.code)).toEqual(ASI_CODES);
            expect(report.summary.covered).toEqual(['ASI01']);
        });

        it('resolves an inherited mapping across representations on the SOURCE side too', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TD), fx[TD].agentId);
            const rogue = report.entries.find((e) => e.code === 'ASI10')!;

            // The mapping edge points at the LIBRARY ISO 42001 A.4.2 row; the
            // tenant's control hangs off the SEEDED one. Match by id alone and
            // inherited coverage is permanently, silently zero on every seeded
            // database — the commercial claim quietly untrue rather than broken.
            expect(rogue.status).toBe('PARTIALLY_COVERED');
            expect(rogue.inheritedFrom.map((i) => i.requirementCode)).toEqual(['A.4.2']);
            expect(rogue.inheritedFrom[0].controls.map((c) => c.code)).toEqual(['D-ISO-A42']);
        });
    });

    describe('F — an ISO 27001 ISMS holder, on the SEEDED representation', () => {
        it('does not start at zero — the ISMS-side route delivers', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TF), fx[TF].agentId);

            // The regression this whole tenant exists for: before the fix
            // every one of these ten codes came back NOT_COVERED, because the
            // seeded ISO 27001 row carried no `sourceUrn` AND numbers Annex A
            // `5.15` where the mapping cites `A.5.15`. Two independent breaks,
            // one indistinguishable readout — a tenant that had done the work
            // looked exactly like a tenant that had done none.
            expect(report.frameworkInstalled).toBe(true);
            expect(report.summary.uncovered).toEqual(['ASI01', 'ASI04', 'ASI05', 'ASI08', 'ASI09']);
            expect(report.summary.partiallyCovered).toEqual(['ASI02', 'ASI03', 'ASI07']);
            expect(report.summary.reviewNeeded).toEqual(['ASI06', 'ASI10']);

            // Still nothing COVERED, and the percentage is still 0: inherited
            // coverage is capped, so "does not start at zero" is a claim about
            // the WHICH lists, never about the number.
            expect(report.summary.covered).toEqual([]);
            expect(report.summary.coveragePercent).toBe(0);
        });

        it('names every Annex A control behind ASI03, strongest route first', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TF), fx[TF].agentId);
            const identity = report.entries.find((e) => e.code === 'ASI03')!;

            expect(identity.status).toBe('PARTIALLY_COVERED');
            expect(identity.directControls).toEqual([]);
            expect(
                identity.inheritedFrom.map((i) => [i.requirementCode, i.strength]),
            ).toEqual([
                ['A.5.15', 'SUBSET'],
                ['A.5.17', 'SUBSET'],
                ['A.8.2', 'SUBSET'],
                ['A.8.5', 'SUBSET'],
                ['A.5.3', 'INTERSECT'],
                ['A.8.15', 'INTERSECT'],
            ]);

            // Each route reports the tenant's own control, held against the
            // SEEDED row it is named on — `5.15`, not `A.5.15`.
            expect(identity.inheritedFrom.map((i) => i.controls.map((c) => c.code))).toEqual([
                ['F-ISMS-5.15'],
                ['F-ISMS-5.17'],
                ['F-ISMS-8.2'],
                ['F-ISMS-8.5'],
                ['F-ISMS-5.3'],
                ['F-ISMS-8.15'],
            ]);
            // The route is reported under the framework the MAPPING cites.
            expect([...new Set(identity.inheritedFrom.map((i) => i.frameworkKey))]).toEqual([
                'ISO27001-2022',
            ]);
        });

        it('still says NO_CONTROL, not NOT_SCOPED, for the risks the ISMS cannot reach', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TF), fx[TF].agentId);
            const rogue = report.entries.find((e) => e.code === 'ASI05')!;

            // The scope links hang off the SEEDED ASI rows, so this doubles as
            // the ASI-side family check: get that wrong and every reason here
            // flips to NOT_SCOPED while the coverage lists stay the same.
            expect(rogue.scopedToAgent).toBe(true);
            expect(rogue.status).toBe('NOT_COVERED');
            expect(rogue.reason).toBe('NO_CONTROL');
            expect(rogue.inheritedFrom).toEqual([]);
        });

        it('reads identically once the seed writes the sourceUrn', async () => {
            // Two deployment states, one answer. A database seeded before
            // `prisma/seed.ts` carried `sourceUrn` reaches the family through
            // the legacy-key fallback; one seeded after reaches it through the
            // urn. If only the seed had been fixed, every tenant provisioned
            // before today would still read zero.
            const legacy = await computeAgentRiskCoverage(ctxFor(TF), fx[TF].agentId);
            try {
                await prisma.framework.update({
                    where: { key: 'ISO27001' },
                    data: { sourceUrn: ISMS_LIBRARY_URN },
                });
                const reseeded = await computeAgentRiskCoverage(ctxFor(TF), fx[TF].agentId);
                expect(reseeded.summary).toEqual(legacy.summary);
                expect(
                    reseeded.entries.find((e) => e.code === 'ASI03')!.inheritedFrom,
                ).toEqual(legacy.entries.find((e) => e.code === 'ASI03')!.inheritedFrom);
            } finally {
                await prisma.framework.update({
                    where: { key: 'ISO27001' },
                    data: { sourceUrn: null },
                });
            }
        });
    });

    describe('E — the per-agent gate', () => {
        it('covers nothing for an agent whose AI-system entry was never scoped', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TA), unscopedAgentId);

            // Tenant A holds the SAME two agentic controls this whole time.
            expect(report.summary.covered).toEqual([]);
            expect(report.summary.partiallyCovered).toEqual(['ASI01', 'ASI02']);
            expect(report.summary.uncovered).toEqual([
                'ASI03', 'ASI04', 'ASI05', 'ASI06', 'ASI07', 'ASI08', 'ASI09', 'ASI10',
            ]);
        });

        it('names the missing scope as the reason, not a missing control', async () => {
            const report = await computeAgentRiskCoverage(ctxFor(TA), unscopedAgentId);
            const hijack = report.entries.find((e) => e.code === 'ASI01')!;

            expect(hijack.scopedToAgent).toBe(false);
            expect(hijack.reason).toBe('NOT_SCOPED');
            expect(hijack.directControls.map((c) => c.code)).toEqual(['A-ASI01']);
        });
    });
});
