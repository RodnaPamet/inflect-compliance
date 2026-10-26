/**
 * Epic O-2 — auto-provisioning lifecycle integration test.
 *
 * Hits the real DB to prove the contract that the unit test mocks
 * can't fully verify:
 *
 *   1. createMany(skipDuplicates) actually skips on the (tenantId,
 *      userId) unique constraint, not on some other constraint.
 *   2. The provisionedByOrgId column actually persists and is
 *      queryable, with FKs intact.
 *   3. The full ORG_ADMIN add → provision → tenant add → re-provision
 *      → ORG_ADMIN remove → deprovision lifecycle leaves the DB in
 *      the expected state at every step.
 *   4. A manually-created TenantMembership (provisionedByOrgId IS
 *      NULL, role=ADMIN) survives the deprovision sweep — the
 *      load-bearing safety property of the whole engine.
 *
 * Gated by DB_AVAILABLE — skips locally without a live Postgres + the
 * migrations applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import {
    provisionOrgAdminToTenants,
    provisionAllOrgAdminsToTenant,
    deprovisionOrgAdmin,
} from '@/app-layer/usecases/org-provisioning';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic O-2 — org-provisioning lifecycle (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `o2-prov-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    const otherOrgSlug = `${uniq}-other-org`;
    let orgId = '';
    let otherOrgId = '';
    const tenantSlugs = [`${uniq}-t1`, `${uniq}-t2`, `${uniq}-t3`];
    const tenantIds: string[] = [];
    let cisoUserId = '';
    let manualAdminUserId = '';
    let secondCisoUserId = '';

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const org = await prisma.organization.create({
            data: { name: `${uniq} corp`, slug: orgSlug },
        });
        orgId = org.id;

        const otherOrg = await prisma.organization.create({
            data: { name: `${uniq} other corp`, slug: otherOrgSlug },
        });
        otherOrgId = otherOrg.id;

        for (const slug of tenantSlugs) {
            const t = await prisma.tenant.create({
                data: {
                    name: `${uniq} ${slug}`,
                    slug,
                    organizationId: orgId,
                },
            });
            tenantIds.push(t.id);
        }

        const ciso = await prisma.user.create({
            data: { email: `${uniq}-ciso@example.com`, name: 'CISO Test' },
        });
        cisoUserId = ciso.id;

        const manualAdmin = await prisma.user.create({
            data: { email: `${uniq}-manual@example.com`, name: 'Manual Admin' },
        });
        manualAdminUserId = manualAdmin.id;

        const secondCiso = await prisma.user.create({
            data: { email: `${uniq}-ciso2@example.com`, name: 'Second CISO' },
        });
        secondCisoUserId = secondCiso.id;

        // Pre-stage: the manual admin already has a non-ADMIN
        // membership in tenant-1 from before the org existed. The
        // provisioning sweep must NOT overwrite this with ADMIN.
        await prisma.tenantMembership.create({
            data: {
                tenantId: tenantIds[0],
                userId: manualAdmin.id,
                role: 'ADMIN',
                // provisionedByOrgId intentionally left NULL.
            },
        });

        // OrgMembership rows for both CISOs (ORG_ADMIN) — provisioning
        // service expects these to already exist when called.
        await prisma.orgMembership.create({
            data: {
                organizationId: org.id,
                userId: ciso.id,
                role: 'ORG_ADMIN',
            },
        });
        await prisma.orgMembership.create({
            data: {
                organizationId: org.id,
                userId: secondCiso.id,
                role: 'ORG_ADMIN',
            },
        });

        // Cross-org rendezvous: the first CISO is also ORG_ADMIN of a
        // DIFFERENT org. We won't link any tenants to that org; we just
        // want to verify deprovision against `orgId` doesn't touch
        // anything tagged with `otherOrgId` if such a row existed.
        await prisma.orgMembership.create({
            data: {
                organizationId: otherOrg.id,
                userId: ciso.id,
                role: 'ORG_ADMIN',
            },
        });
    });

    afterAll(async () => {
        await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
        await prisma.orgMembership.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } }).catch(() => {});
        await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => {});
        await prisma.user.deleteMany({
            where: { id: { in: [cisoUserId, secondCisoUserId, manualAdminUserId] } },
        });
        await prisma.$disconnect();
    });

    // ── 1. add ORG_ADMIN → ADMIN in all org tenants ───────────────

    it('provisionOrgAdminToTenants creates ADMIN memberships in every org tenant', async () => {
        const r = await provisionOrgAdminToTenants(orgId, cisoUserId);
        expect(r.totalConsidered).toBe(tenantIds.length);
        expect(r.created).toBe(tenantIds.length);
        expect(r.skipped).toBe(0);

        for (const tid of tenantIds) {
            const m = await prisma.tenantMembership.findUnique({
                where: { tenantId_userId: { tenantId: tid, userId: cisoUserId } },
            });
            expect(m).not.toBeNull();
            expect(m!.role).toBe('ADMIN');
            expect(m!.provisionedByOrgId).toBe(orgId);
        }
    });

    // ── 2. idempotency: re-running fans no new rows ─────────────────

    it('repeating the provision is a no-op (skipped == totalConsidered)', async () => {
        const r = await provisionOrgAdminToTenants(orgId, cisoUserId);
        expect(r.created).toBe(0);
        expect(r.skipped).toBe(tenantIds.length);
        expect(r.totalConsidered).toBe(tenantIds.length);

        // The pre-existing manual ADMIN row in tenant-1 must still be
        // ADMIN, not ADMIN — the unique constraint protected it.
        const manual = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: tenantIds[0],
                    userId: manualAdminUserId,
                },
            },
        });
        expect(manual!.role).toBe('ADMIN');
        expect(manual!.provisionedByOrgId).toBeNull();
    });

    // ── 3. add tenant → all existing ORG_ADMINs provisioned ─────────

    it('provisionAllOrgAdminsToTenant fans every ORG_ADMIN into a freshly-linked tenant', async () => {
        const newTenant = await prisma.tenant.create({
            data: {
                name: `${uniq} late-add`,
                slug: `${uniq}-late`,
                organizationId: orgId,
            },
        });
        try {
            const r = await provisionAllOrgAdminsToTenant(orgId, newTenant.id);
            // 2 ORG_ADMINs (ciso + secondCiso) — both get ADMIN memberships.
            expect(r.totalConsidered).toBe(2);
            expect(r.created).toBe(2);
            expect(r.skipped).toBe(0);

            const cisoMem = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: newTenant.id, userId: cisoUserId },
                },
            });
            expect(cisoMem!.role).toBe('ADMIN');
            expect(cisoMem!.provisionedByOrgId).toBe(orgId);

            const secondCisoMem = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: {
                        tenantId: newTenant.id,
                        userId: secondCisoUserId,
                    },
                },
            });
            expect(secondCisoMem!.role).toBe('ADMIN');
            expect(secondCisoMem!.provisionedByOrgId).toBe(orgId);
        } finally {
            await prisma.tenantMembership.deleteMany({ where: { tenantId: newTenant.id } }).catch(() => {});
            await prisma.tenant.delete({ where: { id: newTenant.id } });
        }
    });

    // ── 4. deprovision: only auto-provisioned rows are removed ──────

    it('deprovisionOrgAdmin removes AUTO-PROVISIONED rows only — manual memberships survive', async () => {
        // Pre-condition: ciso has ADMIN (provisioned) in all 3 tenants.
        // manualAdmin has ADMIN (manual) in tenant-1.
        const beforeDeprovision = await prisma.tenantMembership.findMany({
            where: { tenantId: { in: tenantIds } },
            select: {
                tenantId: true,
                userId: true,
                role: true,
                provisionedByOrgId: true,
            },
            orderBy: [{ tenantId: 'asc' }, { userId: 'asc' }],
        });
        expect(beforeDeprovision.length).toBeGreaterThanOrEqual(4);

        const r = await deprovisionOrgAdmin(orgId, cisoUserId);
        expect(r.deleted).toBe(tenantIds.length);
        expect(r.tenantIds).toEqual(expect.arrayContaining(tenantIds));

        // ciso's auto-provisioned rows are gone in all org tenants.
        for (const tid of tenantIds) {
            const m = await prisma.tenantMembership.findUnique({
                where: { tenantId_userId: { tenantId: tid, userId: cisoUserId } },
            });
            expect(m).toBeNull();
        }

        // manualAdmin's ADMIN membership is untouched.
        const manual = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: tenantIds[0],
                    userId: manualAdminUserId,
                },
            },
        });
        expect(manual).not.toBeNull();
        expect(manual!.role).toBe('ADMIN');
        expect(manual!.provisionedByOrgId).toBeNull();

        // secondCiso's auto-provisioned rows survive — different user.
        const secondMem = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: { tenantId: tenantIds[0], userId: secondCisoUserId },
            },
        });
        // secondCiso wasn't yet provisioned by the test sequence — only the
        // first CISO went through provisionOrgAdminToTenants. Confirm the
        // schema state: no row for secondCiso in tenant-1 (idempotent
        // baseline). The "second CISO survives deprovision of first CISO"
        // property is exercised by the next test, which provisions both
        // and deprovisions one.
        expect(secondMem).toBeNull();
    });

    it('deprovisioning one ORG_ADMIN does not touch another ORG_ADMIN', async () => {
        // Re-provision both CISOs.
        await provisionOrgAdminToTenants(orgId, cisoUserId);
        await provisionOrgAdminToTenants(orgId, secondCisoUserId);

        const r = await deprovisionOrgAdmin(orgId, cisoUserId);
        expect(r.deleted).toBe(tenantIds.length);

        // First CISO is gone everywhere.
        for (const tid of tenantIds) {
            const m = await prisma.tenantMembership.findUnique({
                where: { tenantId_userId: { tenantId: tid, userId: cisoUserId } },
            });
            expect(m).toBeNull();
        }

        // Second CISO still has ADMIN everywhere.
        for (const tid of tenantIds) {
            const m = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: tid, userId: secondCisoUserId },
                },
            });
            expect(m).not.toBeNull();
            expect(m!.role).toBe('ADMIN');
            expect(m!.provisionedByOrgId).toBe(orgId);
        }
    });

    // ── 5. defence-in-depth: ADMIN-only filter on delete ──────────

    it('deprovisionOrgAdmin refuses to delete a non-ADMIN row even if mistagged', async () => {
        // Construct an anomalous row: provisionedByOrgId set, but role
        // is EDITOR (the column is meant for ADMIN rows only). The
        // service's defence-in-depth filter must skip it.
        const anomalous = await prisma.tenantMembership.create({
            data: {
                tenantId: tenantIds[1],
                userId: manualAdminUserId,
                role: 'EDITOR',
                provisionedByOrgId: orgId,
            },
        });

        try {
            const r = await deprovisionOrgAdmin(orgId, manualAdminUserId);
            // The pre-existing manual ADMIN in tenant-1 (no provisionedByOrgId)
            // is unaffected; the anomalous EDITOR row in tenant-2 is too —
            // both predicates (provisionedByOrgId === orgId AND role ===
            // ADMIN) must hold.
            expect(r.deleted).toBe(0);
            expect(r.tenantIds).toEqual([]);

            const stillThere = await prisma.tenantMembership.findUnique({
                where: { id: anomalous.id },
            });
            expect(stillThere).not.toBeNull();
            expect(stillThere!.role).toBe('EDITOR');
        } finally {
            await prisma.tenantMembership.delete({ where: { id: anomalous.id } }).catch(() => {});
        }
    });
});
