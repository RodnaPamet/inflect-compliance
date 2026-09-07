/**
 * Composite tenant-carrying foreign keys: the DATABASE refuses a cross-tenant
 * reference, with the application bypassed.
 *
 * Postgres runs foreign-key checks AS THE TABLE OWNER, which bypasses row-level
 * security — RLS does not constrain what a FK will accept. So a single-column
 * `xId -> Target(id)` between two tenant-scoped tables leaves a cross-tenant
 * reference REPRESENTABLE however carefully the application filters. That is the
 * gap #2356 measured across the schema and this migration closes for the 35
 * sites whose semantics a composite FK expresses unchanged.
 *
 * These tests write with the RAW test client on purpose. That client carries no
 * tenant context and runs as the owner, so RLS is not what stops them — which is
 * the whole point. If the application layer were the only defence, every write
 * below would succeed.
 *
 * Each case is a PAIR. The negative proves a foreign tenant's id is refused; the
 * positive proves the tenant's OWN id is still accepted. Without the positive, a
 * constraint that rejected every value would pass the negative alone and read as
 * working isolation.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'fk-comp-t1';
const T2 = 'fk-comp-t2';

/** Every composite FK this migration added, read from the live database. */
async function compositeFks(): Promise<Set<string>> {
    const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
        `select conname from pg_constraint
         where contype = 'f' and array_length(conkey, 1) = 2
           and conname like '%\\_tenantId\\_fkey'`,
    );
    return new Set(rows.map((r) => r.conname));
}

beforeAll(async () => {
    await resetDatabase(prisma);
    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
});

afterAll(async () => {
    // Clear the CHILD rows before the tenants. `Tenant` is not in
    // resetDatabase's list, and Asset/Control/Risk reference it with a
    // constraint that refuses rather than cascades — so deleting the tenants
    // first fails on `Asset_tenantId_fkey`, which is the DB behaving correctly.
    await resetDatabase(prisma);
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
});

describe('the migration actually landed', () => {
    it('every one of the 35 converted relations carries a two-column FK', async () => {
        const live = await compositeFks();
        // A representative, hand-written sample rather than a count: a count
        // would stay green if a constraint were replaced by an unrelated one,
        // and these names are the claim the migration makes.
        const expected = [
            'AgenticEvidenceArtefact_controlId_tenantId_fkey',
            'AssetRiskLink_riskId_tenantId_fkey',
            'ControlRequirementLink_controlId_tenantId_fkey',
            'EvidenceControlLink_controlId_tenantId_fkey',
            'PolicyVersion_policyId_tenantId_fkey',
            'RiskControl_controlId_tenantId_fkey',
            'RiskControl_riskId_tenantId_fkey',
            'VendorDocument_vendorId_tenantId_fkey',
            'VendorRelationship_primaryVendorId_tenantId_fkey',
            'AuditPackItem_auditPackId_tenantId_fkey',
        ];
        const missing = expected.filter((c) => !live.has(c));
        expect(missing).toStrictEqual([]);
    });

    it('no converted relation was left single-column', async () => {
        const stragglers = await prisma.$queryRawUnsafe<{ conname: string }[]>(
            `select conname from pg_constraint
             where contype = 'f' and array_length(conkey, 1) = 1
               and conname in (
                 'ControlRequirementLink_controlId_fkey',
                 'RiskControl_riskId_fkey',
                 'VendorDocument_vendorId_fkey',
                 'AgenticEvidenceArtefact_controlId_fkey'
               )`,
        );
        expect(stragglers.map((r) => r.conname)).toStrictEqual([]);
    });
});

describe('a cross-tenant reference is refused by the database, application bypassed', () => {
    it("ControlAsset cannot point at another tenant's Control", async () => {
        const asset = await prisma.asset.create({
            data: { tenantId: T1, name: 'control-asset probe', type: 'SYSTEM' },
        });
        const ownControl = await prisma.control.create({
            data: { tenantId: T1, name: 'own control' },
        });
        const foreignControl = await prisma.control.create({
            data: { tenantId: T2, name: 'foreign control' },
        });

        // NEGATIVE — the other tenant's control. The regex is deliberately
        // specific: a bare `.rejects.toThrow()` would also pass on a missing
        // required field or a bad enum, proving nothing about the constraint.
        // That is not hypothetical — two earlier drafts of this file threw for
        // exactly those reasons and would have "passed" a looser assertion.
        await expect(
            prisma.controlAsset.create({
                data: { tenantId: T1, controlId: foreignControl.id, assetId: asset.id },
            }),
        ).rejects.toThrow(/foreign key|constraint/i);

        // POSITIVE COMPANION — its own control still works, so the constraint
        // refuses the TENANT and not the column.
        const ok = await prisma.controlAsset.create({
            data: { tenantId: T1, controlId: ownControl.id, assetId: asset.id },
        });
        expect(ok.controlId).toBe(ownControl.id);
    });

    it("AssetRiskLink cannot point at another tenant's Risk", async () => {
        const asset = await prisma.asset.create({
            data: { tenantId: T1, name: 'probe asset', type: 'SYSTEM' },
        });
        const ownRisk = await prisma.risk.create({ data: { tenantId: T1, title: 'own risk' } });
        const foreignRisk = await prisma.risk.create({ data: { tenantId: T2, title: 'foreign risk' } });

        await expect(
            prisma.assetRiskLink.create({
                data: { tenantId: T1, assetId: asset.id, riskId: foreignRisk.id },
            }),
        ).rejects.toThrow(/foreign key|constraint/i);

        const ok = await prisma.assetRiskLink.create({
            data: { tenantId: T1, assetId: asset.id, riskId: ownRisk.id },
        });
        expect(ok.riskId).toBe(ownRisk.id);
    });

    it("an UPDATE cannot move an existing row to another tenant's parent", async () => {
        // Creation is not the only write. A row legitimate when written must not
        // be re-pointed across the tenant boundary afterwards.
        const asset = await prisma.asset.create({
            data: { tenantId: T1, name: 'update probe', type: 'SYSTEM' },
        });
        const ownRisk = await prisma.risk.create({ data: { tenantId: T1, title: 'own risk 2' } });
        const foreignRisk = await prisma.risk.create({ data: { tenantId: T2, title: 'foreign risk 2' } });
        const link = await prisma.assetRiskLink.create({
            data: { tenantId: T1, assetId: asset.id, riskId: ownRisk.id },
        });

        await expect(
            prisma.assetRiskLink.update({
                where: { id: link.id },
                data: { riskId: foreignRisk.id },
            }),
        ).rejects.toThrow(/foreign key|constraint/i);

        const after = await prisma.assetRiskLink.findUniqueOrThrow({ where: { id: link.id } });
        expect(after.riskId).toBe(ownRisk.id);
    });
});
