/**
 * EvidenceRiskLink / EvidenceAssetLink / EvidenceTag — RLS +
 * composite-FK behavioural tests.
 *
 * Direct sibling of `evidence-control-link-rls.test.ts`: the static
 * guardrail (`tests/guardrails/rls-coverage.test.ts`) confirms the
 * canonical three policies + FORCE flag exist on each table; these tests
 * drive the SEMANTICS against a live Postgres through `withTenantDb`
 * (SET LOCAL ROLE app_user + app.tenant_id), so a future migration that
 * quietly weakens isolation breaks here even if the static surface still
 * reads as correct.
 *
 * Per table:
 *   1. INSERT under app_user with own tenantId → succeeds.
 *   2. INSERT under app_user with a foreign tenantId → blocked.
 *   3. SELECT under app_user is tenant-scoped.
 *   4. The composite FK (evidenceId, tenantId) → Evidence(id, tenantId)
 *      forbids referencing another tenant's evidence — a cross-tenant
 *      link is impossible at the DB level, not merely at the RLS level.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `evra-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

let USER_A_ID = '';
let USER_B_ID = '';
let RISK_A_ID = '';
let RISK_B_ID = '';
let ASSET_A_ID = '';
let ASSET_B_ID = '';
let EVIDENCE_A_ID = '';
let EVIDENCE_B_ID = '';

async function seed() {
    for (const [id, suffix] of [[TENANT_A_ID, 'a'], [TENANT_B_ID, 'b']] as const) {
        await globalPrisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name: `t ${SUITE_TAG}-${suffix}`, slug: `${SUITE_TAG}-${suffix}` },
        });
    }
    const ua = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-a@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-a@example.test`),
        },
    });
    USER_A_ID = ua.id;
    const ub = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-b@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-b@example.test`),
        },
    });
    USER_B_ID = ub.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_A_ID, userId: USER_A_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_B_ID, userId: USER_B_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });

    const riskA = await globalPrisma.risk.create({
        data: { tenantId: TENANT_A_ID, title: 'A: risk' },
    });
    RISK_A_ID = riskA.id;
    const riskB = await globalPrisma.risk.create({
        data: { tenantId: TENANT_B_ID, title: 'B: risk' },
    });
    RISK_B_ID = riskB.id;

    const assetA = await globalPrisma.asset.create({
        data: { tenantId: TENANT_A_ID, name: 'A: asset', type: 'SYSTEM' },
    });
    ASSET_A_ID = assetA.id;
    const assetB = await globalPrisma.asset.create({
        data: { tenantId: TENANT_B_ID, name: 'B: asset', type: 'SYSTEM' },
    });
    ASSET_B_ID = assetB.id;

    const evA = await globalPrisma.evidence.create({
        data: { tenantId: TENANT_A_ID, type: 'TEXT', title: 'A: evidence' },
    });
    EVIDENCE_A_ID = evA.id;
    const evB = await globalPrisma.evidence.create({
        data: { tenantId: TENANT_B_ID, type: 'TEXT', title: 'B: evidence' },
    });
    EVIDENCE_B_ID = evB.id;
}

async function clearLinks() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await globalPrisma.evidenceRiskLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.evidenceAssetLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.evidenceTag.deleteMany({ where: { tenantId: { in: tenantIds } } });
}

async function teardown() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await clearLinks();
    await globalPrisma.evidence.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.asset.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.risk.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
    // AuditLog is append-only (IMMUTABLE_AUDIT_LOG trigger); TenantMembership
    // carries the LAST_OWNER_GUARD — drop under replica role so the sweep
    // isn't blocked by those triggers.
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    if (USER_A_ID) await globalPrisma.user.delete({ where: { id: USER_A_ID } });
    if (USER_B_ID) await globalPrisma.user.delete({ where: { id: USER_B_ID } });
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describeFn('EvidenceRiskLink / EvidenceAssetLink / EvidenceTag — RLS + composite FK', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await clearLinks();
    });

    // ─── EvidenceRiskLink ────────────────────────────────────────────

    it('risk link: app_user INSERT with own tenantId succeeds', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const link = await tx.evidenceRiskLink.create({
                data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, riskId: RISK_A_ID },
            });
            return link.id;
        });
        const persisted = await globalPrisma.evidenceRiskLink.findUnique({ where: { id } });
        expect(persisted?.tenantId).toBe(TENANT_A_ID);
        expect(persisted?.riskId).toBe(RISK_A_ID);
    });

    it('risk link: app_user INSERT with a foreign tenantId is blocked', async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceRiskLink.create({
                    data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, riskId: RISK_B_ID },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates|foreign key/i);
    });

    it('risk link: app_user SELECT only sees own-tenant links', async () => {
        const aLink = await globalPrisma.evidenceRiskLink.create({
            data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, riskId: RISK_A_ID },
        });
        const bLink = await globalPrisma.evidenceRiskLink.create({
            data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, riskId: RISK_B_ID },
        });
        const visibleToA = await withTenantDb(TENANT_A_ID, (tx) =>
            tx.evidenceRiskLink.findMany({
                where: { id: { in: [aLink.id, bLink.id] } },
                select: { id: true },
            }),
        );
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(aLink.id)).toBe(true);
        expect(ids.has(bLink.id)).toBe(false);
    });

    it("risk link: composite FK rejects another tenant's evidence", async () => {
        // tenantId=A but evidenceId points at B's evidence — (evidenceB, A)
        // matches no Evidence(id, tenantId) row, so the FK rejects it
        // regardless of RLS.
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceRiskLink.create({
                    data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_B_ID, riskId: RISK_A_ID },
                });
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ─── EvidenceAssetLink ───────────────────────────────────────────

    it('asset link: app_user INSERT with own tenantId succeeds', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const link = await tx.evidenceAssetLink.create({
                data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, assetId: ASSET_A_ID },
            });
            return link.id;
        });
        const persisted = await globalPrisma.evidenceAssetLink.findUnique({ where: { id } });
        expect(persisted?.tenantId).toBe(TENANT_A_ID);
        expect(persisted?.assetId).toBe(ASSET_A_ID);
    });

    it('asset link: app_user INSERT with a foreign tenantId is blocked', async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceAssetLink.create({
                    data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, assetId: ASSET_B_ID },
                });
            }),
        ).rejects.toThrow(/row-level security|new row violates|foreign key/i);
    });

    it('asset link: app_user SELECT only sees own-tenant links', async () => {
        const aLink = await globalPrisma.evidenceAssetLink.create({
            data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, assetId: ASSET_A_ID },
        });
        const bLink = await globalPrisma.evidenceAssetLink.create({
            data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, assetId: ASSET_B_ID },
        });
        const visibleToA = await withTenantDb(TENANT_A_ID, (tx) =>
            tx.evidenceAssetLink.findMany({
                where: { id: { in: [aLink.id, bLink.id] } },
                select: { id: true },
            }),
        );
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(aLink.id)).toBe(true);
        expect(ids.has(bLink.id)).toBe(false);
    });

    it("asset link: composite FK rejects another tenant's evidence", async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceAssetLink.create({
                    data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_B_ID, assetId: ASSET_A_ID },
                });
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });

    // ─── EvidenceTag ─────────────────────────────────────────────────

    it('tag: app_user INSERT with own tenantId succeeds', async () => {
        const id = await withTenantDb(TENANT_A_ID, async (tx) => {
            const row = await tx.evidenceTag.create({
                data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, tag: 'soc2' },
            });
            return row.id;
        });
        const persisted = await globalPrisma.evidenceTag.findUnique({ where: { id } });
        expect(persisted?.tag).toBe('soc2');
    });

    it('tag: app_user SELECT only sees own-tenant tags', async () => {
        const aTag = await globalPrisma.evidenceTag.create({
            data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_A_ID, tag: 'shared-name' },
        });
        const bTag = await globalPrisma.evidenceTag.create({
            data: { tenantId: TENANT_B_ID, evidenceId: EVIDENCE_B_ID, tag: 'shared-name' },
        });
        // Deliberately the SAME tag string in both tenants: tags are a
        // free-text dimension, so isolation cannot rely on value uniqueness.
        const visibleToA = await withTenantDb(TENANT_A_ID, (tx) =>
            tx.evidenceTag.findMany({ where: { tag: 'shared-name' }, select: { id: true } }),
        );
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(aTag.id)).toBe(true);
        expect(ids.has(bTag.id)).toBe(false);
    });

    it("tag: composite FK rejects another tenant's evidence", async () => {
        await expect(
            withTenantDb(TENANT_A_ID, async (tx) => {
                await tx.evidenceTag.create({
                    data: { tenantId: TENANT_A_ID, evidenceId: EVIDENCE_B_ID, tag: 'x' },
                });
            }),
        ).rejects.toThrow(/foreign key|violates/i);
    });
});
