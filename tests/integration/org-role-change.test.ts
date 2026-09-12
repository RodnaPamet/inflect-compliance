/**
 * Epic O-2 — atomic org member role-change integration test.
 *
 * Covers the new `changeOrgMemberRole` usecase end-to-end against a
 * real DB. The test scenario:
 *
 *   1. Create org with 2 child tenants.
 *   2. Create a creator (ORG_ADMIN) + a target user (initially ORG_READER).
 *   3. Pre-stage a MANUAL `TenantMembership` row in tenant-1 for the
 *      target user, role=READER, `provisionedByOrgId=NULL`. This row
 *      MUST survive both transitions — it represents an explicit
 *      grant the org-deprovisioning service is forbidden to touch.
 *   4. **Promote** target ORG_READER → ORG_ADMIN. Assertions:
 *      - The OrgMembership.role is now ORG_ADMIN.
 *      - tenant-1 still has the manual READER row (unchanged) AND
 *        no ADMIN row was created (skipDuplicates left the manual
 *        row in place).
 *      - tenant-2 has a fresh ADMIN row tagged
 *        `provisionedByOrgId = orgId`.
 *      - The creator's OWNER row in each tenant is untouched.
 *   5. **Demote** target ORG_ADMIN → ORG_READER. Assertions:
 *      - The OrgMembership.role is now ORG_READER.
 *      - tenant-1's manual READER row STILL survives (the load-
 *        bearing safety property — manual grants must not be
 *        deleted by deprovisioning).
 *      - tenant-2's ADMIN row is gone.
 *      - The creator's OWNER row in each tenant is untouched.
 *   6. No-op same-role transition returns `transition: 'noop'` and
 *      doesn't touch any TenantMembership row.
 *   7. Last-ORG_ADMIN guard: demoting the creator (the only remaining
 *      ORG_ADMIN now that target is back to READER) is refused with
 *      ConflictError; nothing changes.
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import { changeOrgMemberRole } from '@/app-layer/usecases/org-members';
import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import type { OrgContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic O-2 — atomic org member role change (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `o2-rolechg-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    let orgId = '';
    let creatorUserId = '';
    let targetUserId = '';
    const tenantIds: string[] = [];

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
            },
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // Org + creator (ORG_ADMIN).
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

        // 2 tenants under the org. Each makes the creator an OWNER
        // and (no other ORG_ADMINs yet) doesn't fan out anything else.
        const adminCtx = ctxFor('ORG_ADMIN', creatorUserId);
        for (let i = 1; i <= 2; i++) {
            const r = await createTenantUnderOrg(adminCtx, {
                name: `${uniq} tenant ${i}`,
                slug: `${uniq}-tenant-${i}`,
            });
            tenantIds.push(r.tenant.id);
        }

        // Target user — starts as ORG_READER (no fan-out).
        const target = await prisma.user.create({
            data: { email: `${uniq}-target@example.com`, name: 'Target' },
        });
        targetUserId = target.id;
        await prisma.orgMembership.create({
            data: {
                organizationId: org.id,
                userId: target.id,
                role: 'ORG_READER',
            },
        });

        // Pre-stage a manual TenantMembership for the target in
        // tenant-1: role=READER, provisionedByOrgId=NULL. This row
        // is the load-bearing canary that proves deprovisioning
        // doesn't delete manual grants.
        await prisma.tenantMembership.create({
            data: {
                tenantId: tenantIds[0],
                userId: target.id,
                role: 'READER',
                provisionedByOrgId: null,
            },
        });
    });

    afterAll(async () => {
        await prisma.tenantMembership.deleteMany({
            where: { tenantId: { in: tenantIds } },
        }).catch(() => {});
        await prisma.tenantOnboarding.deleteMany({
            where: { tenantId: { in: tenantIds } },
        }).catch(() => {});
        await prisma.tenant.deleteMany({
            where: { id: { in: tenantIds } },
        }).catch(() => {});
        await prisma.orgMembership.deleteMany({
            where: { organizationId: orgId },
        }).catch(() => {});
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
        await prisma.user.deleteMany({
            where: { id: { in: [creatorUserId, targetUserId].filter(Boolean) } },
        }).catch(() => {});
        await prisma.$disconnect();
    });

    // ── 4. Promotion ─────────────────────────────────────────────────

    it('promotes ORG_READER → ORG_ADMIN and fans out ADMIN rows (manual rows preserved)', async () => {
        const result = await changeOrgMemberRole(
            ctxFor('ORG_ADMIN', creatorUserId),
            { userId: targetUserId, role: 'ORG_ADMIN' },
        );

        expect(result.transition).toBe('reader_to_admin');
        expect(result.membership.role).toBe('ORG_ADMIN');
        expect(result.deprovision).toBeUndefined();
        // Two tenants under the org — both considered. tenant-1
        // already had a manual row → skipped. tenant-2 → created.
        expect(result.provision?.totalConsidered).toBe(2);
        expect(result.provision?.created).toBe(1);
        expect(result.provision?.skipped).toBe(1);

        // OrgMembership now ADMIN.
        const om = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: targetUserId,
                },
            },
        });
        expect(om?.role).toBe('ORG_ADMIN');

        // tenant-1: the manual READER row is intact, no ADMIN row
        // was created.
        const t1 = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: tenantIds[0],
                    userId: targetUserId,
                },
            },
        });
        expect(t1?.role).toBe('READER');
        expect(t1?.provisionedByOrgId).toBeNull();

        // tenant-2: ADMIN row exists and is tagged with this org.
        const t2 = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: tenantIds[1],
                    userId: targetUserId,
                },
            },
        });
        expect(t2?.role).toBe('ADMIN');
        expect(t2?.provisionedByOrgId).toBe(orgId);

        // Creator's OWNER rows are unchanged.
        for (const tid of tenantIds) {
            const owner = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: {
                        tenantId: tid,
                        userId: creatorUserId,
                    },
                },
            });
            expect(owner?.role).toBe('OWNER');
        }

        // Durable audit evidence: exactly one ORG_ADMIN_PROVISIONED
        // row in tenant-2's AuditLog (where the ADMIN membership was
        // newly created). Tenant-1's manual row pre-existed and is
        // intentionally NOT audited — the access invariant for that
        // tenant didn't change as a result of this op.
        const t2Audits = await prisma.auditLog.findMany({
            where: {
                tenantId: tenantIds[1],
                action: 'ORG_ADMIN_PROVISIONED',
                entity: 'TenantMembership',
                entityId: targetUserId,
            },
        });
        expect(t2Audits).toHaveLength(1);
        const t2Audit = t2Audits[0];
        expect(t2Audit.userId).toBe(creatorUserId); // actor
        expect(t2Audit.actorType).toBe('USER');
        const t2Details = t2Audit.detailsJson as Record<string, unknown>;
        expect(t2Details.category).toBe('access');
        expect(t2Details.sourceAction).toBe('org_member_promoted');
        expect(t2Details.previousOrgRole).toBe('ORG_READER');
        expect(t2Details.newOrgRole).toBe('ORG_ADMIN');
        expect(t2Details.organizationId).toBe(orgId);
        expect(t2Details.targetUserId).toBe(targetUserId);

        const t1Audits = await prisma.auditLog.findMany({
            where: {
                tenantId: tenantIds[0],
                action: 'ORG_ADMIN_PROVISIONED',
                entity: 'TenantMembership',
                entityId: targetUserId,
            },
        });
        expect(t1Audits).toHaveLength(0);
    });

    // ── 5. Demotion ──────────────────────────────────────────────────

    it('demotes ORG_ADMIN → ORG_READER and fans in ADMIN rows (manual rows preserved)', async () => {
        const result = await changeOrgMemberRole(
            ctxFor('ORG_ADMIN', creatorUserId),
            { userId: targetUserId, role: 'ORG_READER' },
        );

        expect(result.transition).toBe('admin_to_reader');
        expect(result.membership.role).toBe('ORG_READER');
        expect(result.provision).toBeUndefined();
        // Only tenant-2's ADMIN row was tagged by this org. tenant-1's
        // manual READER row is provisionedByOrgId=NULL and is NEVER
        // touched by deprovisioning.
        expect(result.deprovision?.deleted).toBe(1);
        expect(result.deprovision?.tenantIds).toEqual([tenantIds[1]]);

        // OrgMembership now READER.
        const om = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: targetUserId,
                },
            },
        });
        expect(om?.role).toBe('ORG_READER');

        // tenant-1: manual READER row STILL survives. This is the
        // load-bearing safety property of the deprovisioning service.
        const t1 = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: tenantIds[0],
                    userId: targetUserId,
                },
            },
        });
        expect(t1?.role).toBe('READER');
        expect(t1?.provisionedByOrgId).toBeNull();

        // tenant-2: ADMIN row gone.
        const t2 = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: tenantIds[1],
                    userId: targetUserId,
                },
            },
        });
        expect(t2).toBeNull();

        // Creator's OWNER rows still untouched.
        for (const tid of tenantIds) {
            const owner = await prisma.tenantMembership.findUnique({
                where: {
                    tenantId_userId: {
                        tenantId: tid,
                        userId: creatorUserId,
                    },
                },
            });
            expect(owner?.role).toBe('OWNER');
        }

        // Durable audit evidence: exactly one
        // ORG_ADMIN_DEPROVISIONED row in tenant-2's AuditLog (where
        // the ADMIN row was actually deleted). Tenant-1 — manual
        // grant — is intentionally NOT audited because the access
        // invariant there didn't change.
        const t2Audits = await prisma.auditLog.findMany({
            where: {
                tenantId: tenantIds[1],
                action: 'ORG_ADMIN_DEPROVISIONED',
                entity: 'TenantMembership',
                entityId: targetUserId,
            },
        });
        expect(t2Audits).toHaveLength(1);
        const t2Details = t2Audits[0].detailsJson as Record<string, unknown>;
        expect(t2Details.sourceAction).toBe('org_member_demoted');
        expect(t2Details.previousOrgRole).toBe('ORG_ADMIN');
        expect(t2Details.newOrgRole).toBe('ORG_READER');

        const t1Audits = await prisma.auditLog.findMany({
            where: {
                tenantId: tenantIds[0],
                action: 'ORG_ADMIN_DEPROVISIONED',
                entity: 'TenantMembership',
                entityId: targetUserId,
            },
        });
        expect(t1Audits).toHaveLength(0);
    });

    // ── 6. No-op transition ─────────────────────────────────────────

    it('same-role transition is a no-op (no provisioning, no deprovisioning)', async () => {
        // Snapshot of every TenantMembership row touching the target
        // before the no-op call.
        const before = await prisma.tenantMembership.findMany({
            where: { userId: targetUserId },
            orderBy: { id: 'asc' },
        });

        const result = await changeOrgMemberRole(
            ctxFor('ORG_ADMIN', creatorUserId),
            { userId: targetUserId, role: 'ORG_READER' },
        );

        expect(result.transition).toBe('noop');
        expect(result.membership.role).toBe('ORG_READER');
        expect(result.provision).toBeUndefined();
        expect(result.deprovision).toBeUndefined();

        const after = await prisma.tenantMembership.findMany({
            where: { userId: targetUserId },
            orderBy: { id: 'asc' },
        });
        expect(after).toEqual(before);
    });

    // ── 7. Last-admin guard ─────────────────────────────────────────

    it('refuses to demote the only remaining ORG_ADMIN (last-admin guard)', async () => {
        // After the demotion above, the creator is the only remaining
        // ORG_ADMIN. Demoting them would orphan the org.
        const before = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: creatorUserId,
                },
            },
        });
        expect(before?.role).toBe('ORG_ADMIN');

        await expect(
            changeOrgMemberRole(
                ctxFor('ORG_ADMIN', creatorUserId),
                { userId: creatorUserId, role: 'ORG_READER' },
            ),
        ).rejects.toMatchObject({ status: 409 });

        // Role unchanged.
        const after = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: orgId,
                    userId: creatorUserId,
                },
            },
        });
        expect(after?.role).toBe('ORG_ADMIN');
    });

    // ── 8. NotFound when membership doesn't exist ──────────────────

    it('throws NotFoundError for an unknown user', async () => {
        await expect(
            changeOrgMemberRole(
                ctxFor('ORG_ADMIN', creatorUserId),
                { userId: 'user-does-not-exist', role: 'ORG_ADMIN' },
            ),
        ).rejects.toMatchObject({ status: 404 });
    });
});
