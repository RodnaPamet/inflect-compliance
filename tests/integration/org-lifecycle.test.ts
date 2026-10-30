/**
 * Epic O-2 — full organization lifecycle integration test.
 *
 * Drives the API-layer usecases end-to-end against a real DB:
 *
 *   1. Create org (creator becomes ORG_ADMIN)
 *   2. Create 3 tenants under the org (creator becomes OWNER of each)
 *   3. Add a second user as ORG_ADMIN → ADMIN rows fan into all 3
 *      tenants for that user
 *   4. Add a third user as ORG_READER → no fan-out
 *   5. Pre-stage a manual ADMIN row in tenant-1 for the ORG_READER
 *      to prove deprovision wouldn't touch it (control)
 *   6. Remove the second user (ORG_ADMIN) → ADMIN rows for THAT
 *      user are deleted in all 3 tenants; the creator's OWNER rows
 *      and the manual ADMIN row are untouched
 *   7. Last-ORG_ADMIN guard: removing the creator (only remaining
 *      ORG_ADMIN) is refused
 *
 * Calls usecases directly (not HTTP) because the DB-backed assertions
 * are the load-bearing part — HTTP routing is exercised by Playwright
 * E2E in a future O-2 follow-up.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import {
    deleteAuditRowsForTenants,
    deleteAuditRowsForUsers,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';
import type { PrismaClient } from '@prisma/client';

import {
    addOrgMember,
    removeOrgMember,
} from '@/app-layer/usecases/org-members';
import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import { provisionOrgAdminToTenants } from '@/app-layer/usecases/org-provisioning';
import type { OrgContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic O-2 — full organization lifecycle (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `o2-life-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    let orgId = '';
    let creatorUserId = '';
    let secondCisoUserId = '';
    let readerUserId = '';
    const createdTenantIds: string[] = [];

    function ctxFor(role: 'ORG_ADMIN' | 'ORG_READER', userId: string): OrgContext {
        return {
            requestId: `req-${role}-${userId}`,
            userId,
            organizationId: orgId,
            orgSlug,
            orgRole: role,
            permissions: {
                canViewPortfolio: true,
                canDrillDown: role === 'ORG_ADMIN',
                canExportReports: true,
                canManageTenants: role === 'ORG_ADMIN',
                canManageMembers: role === 'ORG_ADMIN',
                canConfigureDashboard: role === 'ORG_ADMIN',
                canSetThreatLevel: role === 'ORG_ADMIN',
                canSetMaturity: role === 'ORG_ADMIN',
                canManageAgentSwitches: role === 'ORG_ADMIN',
            },
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // Create the org + creator with ORG_ADMIN. We do this directly
        // (not via the POST /api/org route) because the route depends
        // on getSessionOrThrow which is awkward to mock here; the
        // route is unit-tested separately.
        const creator = await prisma.user.create({
            data: { email: `${uniq}-creator@example.com`, name: 'Creator' },
        });
        creatorUserId = creator.id;

        const org = await prisma.organization.create({
            data: { name: `${uniq} corp`, slug: orgSlug },
        });
        orgId = org.id;

        await prisma.orgMembership.create({
            data: {
                organizationId: org.id,
                userId: creator.id,
                role: 'ORG_ADMIN',
            },
        });

        // No tenants exist yet — provisioning is a no-op for the creator.
        const initial = await provisionOrgAdminToTenants(orgId, creatorUserId);
        expect(initial.totalConsidered).toBe(0);
    });

    afterAll(async () => {
        // MEMBERSHIPS, PAST THE LAST-OWNER GUARD (#3343). The plain
        // `tenantMembership.deleteMany` here raised P0001 from
        // `tenant_membership_last_owner_guard` — a tenant may not be left with
        // zero ACTIVE OWNERs — and the old `.catch(() => {})` discarded it, so
        // the memberships survived and the tenant delete below then failed on
        // `TenantMembership_tenantId_fkey`. Both failures were invisible.
        //
        // The replica role is the sanctioned escape hatch for this, kept inline
        // per `audit-cleanup`'s note that membership cleanup is not its business:
        // those sites "keep their own transaction; they disable a different
        // trigger".
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
                createdTenantIds,
            );
        });
        await prisma.tenantOnboarding.deleteMany({
            where: { tenantId: { in: createdTenantIds } },
        }).catch(() => {});
        // AND THEN THE AUDIT ROWS (#3343). Clearing the memberships moved this
        // teardown from one FK wall straight to the next — exactly the shape
        // `tests/helpers/db.ts` records for #3597 — so both have to go before
        // the tenant can.
        await deleteAuditRowsForTenants(prisma, createdTenantIds);
        await prisma.tenant.deleteMany({
            where: { id: { in: createdTenantIds } },
        });
        await prisma.orgMembership.deleteMany({
            where: { organizationId: orgId },
        }).catch(() => {});
        // THE ORG SIDE, AND THE USERS' OWN ROWS (#3343). Clearing memberships
        // and tenant audit rows moved the failure to the USER delete, which
        // `OrgAuditLog` and any `AuditLog` row keyed on the user still blocked —
        // the third wall in one teardown, each hidden by its own handler.
        await deleteOrgAuditRowsForOrganizations(prisma, [orgId]);
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
        await deleteAuditRowsForUsers(prisma, [creatorUserId, secondCisoUserId, readerUserId].filter(Boolean));
        await prisma.user.deleteMany({
            where: {
                id: { in: [creatorUserId, secondCisoUserId, readerUserId].filter(Boolean) },
            },
        });
        await prisma.$disconnect();
    });

    // ── 1–2. Create 3 tenants under the org ─────────────────────────

    it('creator can create tenants under the org and becomes OWNER of each', async () => {
        const ctx = ctxFor('ORG_ADMIN', creatorUserId);

        for (const i of [1, 2, 3]) {
            const result = await createTenantUnderOrg(ctx, {
                name: `${uniq} tenant ${i}`,
                slug: `${uniq}-t${i}`,
            });
            createdTenantIds.push(result.tenant.id);

            // Tenant linked to the org.
            const tenant = await prisma.tenant.findUnique({
                where: { id: result.tenant.id },
                select: { organizationId: true, encryptedDek: true },
            });
            expect(tenant!.organizationId).toBe(orgId);
            expect(tenant!.encryptedDek).not.toBeNull();

            // OWNER membership for the creator (manually granted).
            const ownerRow = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: {
                        tenantId: result.tenant.id,
                        userId: creatorUserId,
                    },
                },
            });
            expect(ownerRow!.role).toBe('OWNER');
            expect(ownerRow!.provisionedByOrgId).toBeNull();

            // No OTHER ORG_ADMINs yet, so provisionedAdmins is 0.
            expect(result.provisionedAdmins).toBe(0);
        }

        expect(createdTenantIds).toHaveLength(3);
    });

    // ── 3. Add second user as ORG_ADMIN → fan-out ───────────────────

    it('adding a second ORG_ADMIN fans ADMIN memberships into all org tenants', async () => {
        const ctx = ctxFor('ORG_ADMIN', creatorUserId);

        const result = await addOrgMember(ctx, {
            userEmail: `${uniq}-ciso2@example.com`,
            role: 'ORG_ADMIN',
        });
        secondCisoUserId = result.user.id;

        expect(result.provision).toBeDefined();
        expect(result.provision!.created).toBe(3);
        expect(result.provision!.totalConsidered).toBe(3);

        // Verify each tenant has the ADMIN row tagged with the org id.
        for (const tid of createdTenantIds) {
            const row = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: tid, userId: secondCisoUserId },
                },
            });
            expect(row!.role).toBe('ADMIN');
            expect(row!.provisionedByOrgId).toBe(orgId);
        }
    });

    // ── 4. Add ORG_READER → NO fan-out ──────────────────────────────

    it('adding an ORG_READER does NOT fan out tenant memberships', async () => {
        const ctx = ctxFor('ORG_ADMIN', creatorUserId);

        const result = await addOrgMember(ctx, {
            userEmail: `${uniq}-reader@example.com`,
            role: 'ORG_READER',
        });
        readerUserId = result.user.id;

        expect(result.provision).toBeUndefined();

        for (const tid of createdTenantIds) {
            const row = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: tid, userId: readerUserId },
                },
            });
            expect(row).toBeNull();
        }
    });

    // ── 5. Pre-stage a manual ADMIN row for the reader ──────────────

    it('manually-granted memberships for the reader stay isolated', async () => {
        // The reader gets a MANUAL ADMIN role on tenant-1 (separate
        // from any org auto-provisioning). This is the row the
        // deprovision sweep must NEVER delete.
        await prisma.tenantMembership.create({
            data: {
                tenantId: createdTenantIds[0],
                userId: readerUserId,
                role: 'ADMIN',
                // provisionedByOrgId intentionally left NULL.
            },
        });

        const row = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: createdTenantIds[0],
                    userId: readerUserId,
                },
            },
        });
        expect(row!.role).toBe('ADMIN');
        expect(row!.provisionedByOrgId).toBeNull();
    });

    // ── 6. Remove second ORG_ADMIN → fan-in (only their ADMINs) ───

    it('removing the second ORG_ADMIN tears down ADMIN rows ONLY for that user', async () => {
        const ctx = ctxFor('ORG_ADMIN', creatorUserId);

        const result = await removeOrgMember(ctx, { userId: secondCisoUserId });
        expect(result.wasOrgAdmin).toBe(true);
        expect(result.deprovision!.deleted).toBe(3);
        expect(result.deprovision!.tenantIds).toEqual(
            expect.arrayContaining(createdTenantIds),
        );

        // The second CISO's ADMIN rows are gone.
        for (const tid of createdTenantIds) {
            const row = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: tid, userId: secondCisoUserId },
                },
            });
            expect(row).toBeNull();
        }

        // Creator's OWNER rows untouched.
        for (const tid of createdTenantIds) {
            const row = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: tid, userId: creatorUserId },
                },
            });
            expect(row!.role).toBe('OWNER');
            expect(row!.provisionedByOrgId).toBeNull();
        }

        // Reader's manual ADMIN on tenant-1 untouched.
        const readerRow = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: createdTenantIds[0],
                    userId: readerUserId,
                },
            },
        });
        expect(readerRow!.role).toBe('ADMIN');
        expect(readerRow!.provisionedByOrgId).toBeNull();

        // Second CISO's OrgMembership row is also gone.
        const orgRow = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: secondCisoUserId,
                },
            },
        });
        expect(orgRow).toBeNull();
    });

    // ── 7. Last-ORG_ADMIN guard ─────────────────────────────────────

    it('refuses to remove the creator while they are the last ORG_ADMIN', async () => {
        const ctx = ctxFor('ORG_ADMIN', creatorUserId);

        await expect(
            removeOrgMember(ctx, { userId: creatorUserId }),
        ).rejects.toMatchObject({ status: 409 });

        // Creator's OrgMembership still exists.
        const stillThere = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: creatorUserId,
                },
            },
        });
        expect(stillThere).not.toBeNull();
        expect(stillThere!.role).toBe('ORG_ADMIN');

        // Their tenant OWNER memberships also still exist.
        for (const tid of createdTenantIds) {
            const row = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: { tenantId: tid, userId: creatorUserId },
                },
            });
            expect(row!.role).toBe('OWNER');
        }
    });
});
