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
 *
 * ── On the first test's name ─────────────────────────────────────────
 *
 * "every one of the 35 converted relations" samples TEN named constraints, for
 * the reason its own comment gives. That is a deliberate trade and not a defect,
 * but the name reads as a population claim: searching this file for a model and
 * finding nothing does NOT mean the model is uncovered by the schema, nor that
 * it is covered by this test. The process-map pair below was added after exactly
 * that confusion — a name-based search said "absent", the schema said the
 * composite FK was present, and only the sample list settled which.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';

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

describe("a process map's children cannot belong to another tenant", () => {
    /**
     * Added for #2962's regression list, which asks whether "composite-FK
     * tenant isolation [is] intact — cross-tenant child writes still fail on
     * referential integrity, not only RLS" before the tldraw cutover deletes
     * the old canvas.
     *
     * The schema says yes. Both children carry
     * `@relation(fields: [processMapId, tenantId], references: [id, tenantId])`,
     * and `ProcessMap` carries the `@@unique([id, tenantId])` that makes
     * Postgres accept it. Nothing exercised it: the sample in the first test of
     * this file names ten constraints and neither child is among them.
     *
     * "The schema declares it" and "the database enforces it" are different
     * claims, and the second is the one the cutover rests on — after it, these
     * rows have exactly one writer.
     */
    /**
     * UNIQUE per call, not per tenant.
     *
     * Keyed on the tenant alone, the second test's `seed(T1)` collided on
     * `User_emailHash_key` — and the first test passed because it ran first,
     * which is how a non-idempotent fixture hides until something calls it
     * twice. The failure then arrives as a unique-constraint error from
     * `user.create`, which a looser `.rejects.toThrow()` in the test below
     * would have swallowed as a pass: it IS a constraint violation, just not
     * the one under test. The specific regex this file insists on is what kept
     * that honest.
     */
    let seedN = 0;
    const createdUserIds: string[] = [];
    const seed = async (tenantId: string) => {
        const email = `fk-proc-${tenantId}-${(seedN += 1)}@example.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        createdUserIds.push(user.id);
        const map = await prisma.processMap.create({
            data: { tenantId, name: `map for ${tenantId}`, createdByUserId: user.id },
        });
        return { userId: user.id, mapId: map.id };
    };

    /**
     * This block cleans up after ITSELF, before the file's `afterAll` runs.
     *
     * `resetDatabase` does not clear `ProcessMap` — the same reason
     * `process-map-concurrency.test.ts` deletes it by hand. Left behind, the
     * file's `tenant.deleteMany` fails on `ProcessMap_tenantId_fkey`, which is
     * the database being right and the fixture being wrong. The symptom is
     * worth naming because of how it presents: every test PASSES and the SUITE
     * fails, so a reader scanning for a red assertion finds none.
     *
     * Nodes and edges need no deletion — they cascade from the map, which is
     * the `onDelete: Cascade` on the very composite FK these tests are about.
     */
    afterAll(async () => {
        await prisma.processMap.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    });

    it("a ProcessNode cannot point at another tenant's map", async () => {
        const own = await seed(T1);
        const foreign = await seed(T2);

        // NEGATIVE. Written with the RAW client, which carries no tenant
        // context and runs as the owner — so RLS is not what refuses this.
        // The regex is specific for the reason this file records: a bare
        // `.rejects.toThrow()` also passes on a missing column.
        await expect(
            prisma.processNode.create({
                data: {
                    tenantId: T1,
                    processMapId: foreign.mapId,
                    nodeKey: 'n1',
                    nodeType: 'processStep',
                    label: 'smuggled',
                    posX: 0,
                    posY: 0,
                },
            }),
        ).rejects.toThrow(/foreign key|constraint/i);

        // POSITIVE COMPANION — its own map still works, so the constraint
        // refuses the TENANT and not the column.
        const ok = await prisma.processNode.create({
            data: {
                tenantId: T1,
                processMapId: own.mapId,
                nodeKey: 'n1',
                nodeType: 'processStep',
                label: 'legitimate',
                posX: 0,
                posY: 0,
            },
        });
        expect(ok.processMapId).toBe(own.mapId);
    });

    it("a ProcessEdge cannot point at another tenant's map", async () => {
        const own = await seed(T1);
        const foreign = await seed(T2);

        await expect(
            prisma.processEdge.create({
                data: {
                    tenantId: T1,
                    processMapId: foreign.mapId,
                    edgeKey: 'e1',
                    sourceKey: 'n1',
                    targetKey: 'n2',
                },
            }),
        ).rejects.toThrow(/foreign key|constraint/i);

        const ok = await prisma.processEdge.create({
            data: {
                tenantId: T1,
                processMapId: own.mapId,
                edgeKey: 'e1',
                sourceKey: 'n1',
                targetKey: 'n2',
            },
        });
        expect(ok.processMapId).toBe(own.mapId);
    });

    it('an UPDATE cannot re-point a node at another tenant\'s map', async () => {
        // Creation is not the only write — the same reasoning the AssetRiskLink
        // update case above records. A node written legitimately must not be
        // moved across the boundary afterwards, which is the shape a buggy
        // "move map" feature would take.
        const own = await seed(T1);
        const foreign = await seed(T2);

        const node = await prisma.processNode.create({
            data: {
                tenantId: T1,
                processMapId: own.mapId,
                nodeKey: 'n-move',
                nodeType: 'processStep',
                label: 'movable',
                posX: 0,
                posY: 0,
            },
        });

        await expect(
            prisma.processNode.update({
                where: { id: node.id },
                data: { processMapId: foreign.mapId },
            }),
        ).rejects.toThrow(/foreign key|constraint/i);
    });
});
