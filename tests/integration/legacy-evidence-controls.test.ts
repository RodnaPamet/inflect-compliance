/**
 * Step 5b: filing a legacy recertification's evidence against the controls it
 * evidences.
 *
 * The suggestion is a question about the TENANT: "do you have a control mapped
 * to this requirement?" There is no framework-install table — `Framework` is
 * global — so the answer is `ControlRequirementLink`, which is tenant-scoped.
 * These tests therefore seed real framework requirements and real links, rather
 * than asserting against a hardcoded list that would agree with itself.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import {
    LEGACY_EVIDENCE_REQUIREMENTS,
    suggestLegacyEvidenceControls,
} from '@/app-layer/usecases/legacy-evidence-controls';

const prisma: PrismaClient = prismaTestClient();
const T1 = 'lec-tenant';
const T2 = 'lec-other';
const ctx = (tenantId = T1, role = 'ADMIN') => makeRequestContext(role, { tenantId });

let soc2ReqId = '';
let isoReqId = '';
let ourControlId = '';
let otherControlId = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
    // The REQUIREMENTS this fixture added, not the frameworks. The frameworks
    // are global and may be the seeded catalogue — deleting them would remove
    // rows this suite does not own.
    await prisma.frameworkRequirement.deleteMany({
        where: { title: { startsWith: 'LEC fixture — ' } },
    });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Ours'], [T2, 'Theirs']] as const) {
        await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name, slug: id } });
    }
    await prisma.user.upsert({
        where: { id: 'user-1' }, update: {},
        create: { id: 'user-1', email: 'closer@lec.test', name: 'Closer' },
    });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the requirement list is honest about the brief', () => {
    it('names CC6.1 for SOC 2, and says why it is not CC6.2', () => {
        // The brief names CC6.2 and CC6.3; this catalogue has neither. A
        // suggestion keyed on them would return nothing for every tenant for
        // ever while looking like a working feature.
        const soc2 = LEGACY_EVIDENCE_REQUIREMENTS.filter((r) => r.frameworkKey === 'soc2');
        expect(soc2.map((r) => r.code)).toEqual(['CC6.1']);
        expect(soc2[0].note).toMatch(/CC6\.2/);
    });

    it("the real SOC 2 catalogue genuinely lacks CC6.2 — asserted, not assumed", async () => {
        // The premise of the substitution. If a later catalogue change ADDS
        // CC6.2, this fails and whoever reads it should revisit the list above
        // rather than leave the product understating its own coverage.
        const found = await prisma.frameworkRequirement.findFirst({
            where: { code: { in: ['CC6.2', 'CC6.3'] }, framework: { key: 'soc2' } },
            select: { code: true },
        });
        expect(found).toBeNull();
    });

    it('names the ISO and NIS2 codes the brief asks for', () => {
        const codes = LEGACY_EVIDENCE_REQUIREMENTS.map((r) => r.code);
        expect(codes).toContain('A.5.16');
        expect(codes).toContain('A.5.18');
        expect(codes).toContain('Art. 21(2)(i)');
    });

    it('every entry carries a substantive note', () => {
        for (const r of LEGACY_EVIDENCE_REQUIREMENTS) {
            expect(r.note.length).toBeGreaterThan(30);
        }
    });
});

describe('the suggestion is a question about the tenant', () => {
    beforeEach(async () => {
        await clearOwnRows();
        // The REAL framework keys, because the lookup keys on them. Using
        // fixture-specific keys made every assertion below fail while the
        // production query was correct — the test was not exercising it at all.
        //
        // Upsert, not create: `Framework.key` is globally unique and the seeded
        // catalogue may already hold these.
        const soc2 = await prisma.framework.upsert({
            where: { key: 'soc2' },
            update: {},
            create: { key: 'soc2', name: 'SOC 2', version: '2017' },
        });
        const iso = await prisma.framework.upsert({
            where: { key: 'iso27001' },
            update: {},
            create: { key: 'iso27001', name: 'ISO/IEC 27001', version: '2022' },
        });
        // Titled so teardown can find exactly the rows this suite added.
        soc2ReqId = (await prisma.frameworkRequirement.create({
            data: { frameworkId: soc2.id, code: 'CC6.1', title: 'LEC fixture — Logical access' },
        })).id;
        isoReqId = (await prisma.frameworkRequirement.create({
            data: { frameworkId: iso.id, code: 'A.5.18', title: 'LEC fixture — Access rights' },
        })).id;
        ourControlId = (await prisma.control.create({
            data: { tenantId: T1, name: 'Access reviews', code: 'AC-1' },
        })).id;
        otherControlId = (await prisma.control.create({
            data: { tenantId: T2, name: 'Their access reviews', code: 'AC-1' },
        })).id;
    });

    it('returns nothing when the tenant has mapped none of them', async () => {
        // A real answer, not a failure: a tenant running none of the three
        // frameworks has nothing for this artefact to attach to, and inventing
        // a link would put a compliance claim on a control nobody mapped.
        expect(await suggestLegacyEvidenceControls(ctx())).toEqual([]);
    });

    it('returns the control once per requirement it satisfies', async () => {
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: T1, controlId: ourControlId, requirementId: soc2ReqId },
                { tenantId: T1, controlId: ourControlId, requirementId: isoReqId },
            ],
        });
        const s = await suggestLegacyEvidenceControls(ctx());
        expect(s).toHaveLength(2);
        expect(s.map((x) => x.requirementCode).sort()).toEqual(['A.5.18', 'CC6.1']);
        expect(new Set(s.map((x) => x.controlId))).toEqual(new Set([ourControlId]));
        expect(s[0].controlName).toBe('Access reviews');
    });

    it('does NOT return another tenant’s control, even on the same requirement', async () => {
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: T2, controlId: otherControlId, requirementId: soc2ReqId },
            ],
        });
        // Ours sees nothing...
        expect(await suggestLegacyEvidenceControls(ctx(T1))).toEqual([]);
        // ...and theirs sees it, which is the denominator proving the empty
        // result above is isolation rather than an empty table.
        const theirs = await suggestLegacyEvidenceControls(ctx(T2));
        expect(theirs.map((x) => x.controlId)).toEqual([otherControlId]);
    });

    it('is ordered stably, so two calls agree', async () => {
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: T1, controlId: ourControlId, requirementId: isoReqId },
                { tenantId: T1, controlId: ourControlId, requirementId: soc2ReqId },
            ],
        });
        const a = await suggestLegacyEvidenceControls(ctx());
        const b = await suggestLegacyEvidenceControls(ctx());
        expect(a).toEqual(b);
        // iso sorts before soc2 on framework key, which is the declared order.
        expect(a[0].frameworkKey).toBe('iso27001');
    });

    it('a READER may see it — the creator choosing where to file needs this read', async () => {
        await prisma.controlRequirementLink.create({
            data: { tenantId: T1, controlId: ourControlId, requirementId: soc2ReqId },
        });
        const s = await suggestLegacyEvidenceControls(ctx(T1, 'READER'));
        expect(s).toHaveLength(1);
    });
});
