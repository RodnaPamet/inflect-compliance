/**
 * Step 5b: filing a legacy recertification's evidence against the controls it
 * evidences.
 *
 * The suggestion is a question about the TENANT: "do you have a control mapped
 * to this requirement?" There is no framework-install table — `Framework` is
 * global — so the answer is `ControlRequirementLink`, which is tenant-scoped.
 *
 * ═══ AGAINST THE CATALOGUE EVERY ENVIRONMENT ACTUALLY HOLDS (#3716) ═══
 *
 * This suite used to seed its own `soc2` / `iso27001` framework rows with the
 * codes the module asked for (`A.5.18`). The module and its test agreed with
 * each other, and neither agreed with the catalogue: the deploy-time seeder
 * writes `ISO27001` and numbers Annex A `5.18`, and NIS2 is `NIS2` /
 * `Art.21(2)(i)`. So every real tenant got no suggestion, and the suite stayed
 * green.
 *
 * The framework rows here are therefore applied from the SAME CatalogFile
 * fixtures, through the SAME loader and applier, that
 * `scripts/seed-framework-catalogs.ts` runs on every container start. The
 * tenant's controls are linked to those seeded requirement rows, found by the
 * seeded spellings — never by the spellings the module under test asks for.
 */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { REPO_ROOT } from '../helpers/repo-files';
import { loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { ISO27001_FAMILY_URN } from '@/app-layer/domain/framework-representation';
import {
    LEGACY_EVIDENCE_REQUIREMENTS,
    suggestLegacyEvidenceControls,
} from '@/app-layer/usecases/legacy-evidence-controls';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'lec-tenant';
const T2 = 'lec-other';
const ctx = (tenantId = T1, role = 'ADMIN') => makeRequestContext(role, { tenantId });

/** The deploy-time catalogue fixtures for the three frameworks the suggestion names. */
const SEEDED = [
    'prisma/fixtures/iso27001-control-templates.json',
    'prisma/fixtures/soc2-control-templates.json',
    'prisma/fixtures/nis2-control-templates.json',
];

/** A second representation of ISO 27001, shaped like the library import. Owned by this suite. */
const LIBRARY_ISO_KEY = 'LEC-ISO27001-LIBRARY';

/** The seeded requirement row for one `(framework key, code)`, as the seeder wrote it. */
async function seededRequirement(frameworkKey: string, code: string): Promise<string> {
    const r = await prisma.frameworkRequirement.findFirstOrThrow({
        where: { code, framework: { key: frameworkKey } },
        select: { id: true },
    });
    return r.id;
}

let ourControlId = '';
let otherControlId = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
    // The library-shaped representation is this suite's own; the seeded
    // catalogue is not, and stays.
    await prisma.frameworkRequirement.deleteMany({ where: { framework: { key: LIBRARY_ISO_KEY } } });
    await prisma.framework.deleteMany({ where: { key: LIBRARY_ISO_KEY } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    for (const rel of SEEDED) {
        const file = path.join(REPO_ROOT, rel);
        await applyCatalogFile(prisma, loadAndValidateCatalogFile(file), file);
    }
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Ours'], [T2, 'Theirs']] as const) {
        await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name, slug: id } });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the requirement list is honest about the brief and the catalogue', () => {
    it('names the brief\'s own CC6.2 and CC6.3 for SOC 2, the substitution retired', () => {
        // This asserted `['CC6.1']` and a note explaining why it was not CC6.2,
        // because the catalogue carried neither of the codes the brief named and
        // a suggestion keyed on them would have returned nothing for every
        // tenant for ever while looking like a working feature. #3369 completed
        // CC6, so the brief's codes resolve and the substitution is gone.
        const soc2 = LEGACY_EVIDENCE_REQUIREMENTS.filter((r) => r.legacyKeys.includes('SOC2'));
        expect(soc2.map((r) => r.requirementCode)).toEqual(['CC6.2', 'CC6.3']);
        expect(soc2.map((r) => r.requirementCode)).not.toContain('CC6.1');
    });

    it('the seeded SOC 2 catalogue genuinely carries the whole of CC6 — asserted, not assumed', async () => {
        // The premise of the suggestion, read from the SEEDED row rather than
        // from the fixture, because what a tenant can be matched against is
        // what the seeder actually wrote. An earlier version asked about
        // `key: 'soc2'`, a key nothing seeds, so it was null for the wrong
        // reason and could never fail — hence reading the real key here.
        //
        // It asserted the ABSENCE of CC6.2 and CC6.3 until #3369 completed CC6.
        const soc2 = await prisma.framework.findUniqueOrThrow({ where: { key: 'SOC2' }, select: { id: true } });
        const codes = (await prisma.frameworkRequirement.findMany({
            where: { frameworkId: soc2.id },
            select: { code: true },
        })).map((r) => r.code);
        for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
            expect(codes).toContain(`CC6.${n}`);
        }
        // Every code this module can suggest for SOC 2 resolves against that
        // row — the check the substitution existed to avoid failing.
        for (const r of LEGACY_EVIDENCE_REQUIREMENTS.filter((x) => x.legacyKeys.includes('SOC2'))) {
            expect(codes).toContain(r.requirementCode);
        }
    });

    it('every entry carries a substantive note', () => {
        for (const r of LEGACY_EVIDENCE_REQUIREMENTS) {
            expect(r.note.length).toBeGreaterThan(30);
        }
    });
});

describe('the suggestion is a question about the tenant, against the seeded catalogue', () => {
    beforeEach(async () => {
        await clearOwnRows();
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

    it('REGRESSION — resolves a control linked to the SEEDED spellings: ISO27001 5.18, SOC2 CC6.1, NIS2 Art.21(2)(i)', async () => {
        // Before the fix this returned [] for every one of these links: the
        // module asked for `iso27001` / `A.5.18` and `nis2` / `Art. 21(2)(i)`.
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('ISO27001', '5.18') },
                { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('ISO27001', '5.16') },
                { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('SOC2', 'CC6.1') },
                { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('NIS2', 'Art.21(2)(i)') },
            ],
        });
        const s = await suggestLegacyEvidenceControls(ctx());
        expect(s.map((x) => [x.frameworkKey, x.requirementCode])).toEqual([
            ['ISO27001', '5.16'],
            ['ISO27001', '5.18'],
            ['NIS2', 'Art.21(2)(i)'],
            ['SOC2', 'CC6.1'],
        ]);
        expect(new Set(s.map((x) => x.controlId))).toEqual(new Set([ourControlId]));
        expect(s[0].controlName).toBe('Access reviews');
    });

    it('does not suggest a control linked to a requirement outside the obligations', async () => {
        // The positive results above must come from the obligation list, not
        // from "any link the tenant has".
        await prisma.controlRequirementLink.create({
            data: { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('ISO27001', '5.15') },
        });
        expect(await suggestLegacyEvidenceControls(ctx())).toEqual([]);
    });

    it('matches either representation of ISO 27001, and counts one obligation once', async () => {
        // A second representation, shaped as the library import writes it: its
        // own key, the family urn, Annex A spelled `A.5.18`.
        const lib = await prisma.framework.create({
            data: { key: LIBRARY_ISO_KEY, name: 'ISO/IEC 27001 (library)', version: '2022', sourceUrn: ISO27001_FAMILY_URN },
        });
        const libReq = await prisma.frameworkRequirement.create({
            data: { frameworkId: lib.id, code: 'A.5.18', title: 'Access rights' },
        });
        await prisma.controlRequirementLink.create({
            data: { tenantId: T1, controlId: ourControlId, requirementId: libReq.id },
        });
        const viaLibrary = await suggestLegacyEvidenceControls(ctx());
        expect(viaLibrary.map((x) => [x.frameworkKey, x.requirementCode])).toEqual([[LIBRARY_ISO_KEY, 'A.5.18']]);

        // Linked to BOTH spellings of A.5.18 it is still one obligation.
        await prisma.controlRequirementLink.create({
            data: { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('ISO27001', '5.18') },
        });
        expect(await suggestLegacyEvidenceControls(ctx())).toHaveLength(1);
    });

    it('does NOT return another tenant’s control, even on the same seeded requirement', async () => {
        await prisma.controlRequirementLink.create({
            data: { tenantId: T2, controlId: otherControlId, requirementId: await seededRequirement('SOC2', 'CC6.1') },
        });
        // Ours sees nothing...
        expect(await suggestLegacyEvidenceControls(ctx(T1))).toEqual([]);
        // ...and theirs sees it, which is the denominator proving the empty
        // result above is isolation rather than an empty table.
        const theirs = await suggestLegacyEvidenceControls(ctx(T2));
        expect(theirs.map((x) => x.controlId)).toEqual([otherControlId]);
    });

    it('does not suggest a soft-deleted control', async () => {
        await prisma.controlRequirementLink.create({
            data: { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('SOC2', 'CC6.1') },
        });
        expect(await suggestLegacyEvidenceControls(ctx())).toHaveLength(1);
        await prisma.control.update({ where: { id: ourControlId }, data: { deletedAt: new Date() } });
        expect(await suggestLegacyEvidenceControls(ctx())).toEqual([]);
    });

    it('is ordered stably, so two calls agree', async () => {
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('SOC2', 'CC6.1') },
                { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('ISO27001', '5.18') },
            ],
        });
        const a = await suggestLegacyEvidenceControls(ctx());
        const b = await suggestLegacyEvidenceControls(ctx());
        expect(a).toEqual(b);
        expect(a[0].frameworkKey).toBe('ISO27001');
    });

    it('a READER may see it — the creator choosing where to file needs this read', async () => {
        await prisma.controlRequirementLink.create({
            data: { tenantId: T1, controlId: ourControlId, requirementId: await seededRequirement('SOC2', 'CC6.1') },
        });
        const s = await suggestLegacyEvidenceControls(ctx(T1, 'READER'));
        expect(s).toHaveLength(1);
    });
});
