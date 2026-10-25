/**
 * GAP O4-2 — `listOrgMembers` usecase integration test.
 *
 * Seeds an org with 1 ORG_ADMIN + 2 ORG_READER + 1 unrelated user
 * (no membership). Verifies:
 *
 *   - Returns exactly the org's members (the unrelated user is
 *     excluded — scope is correct).
 *   - Sorts ORG_ADMIN before ORG_READER, alphabetical email within
 *     each bucket. The page renders the most-actionable rows first.
 *   - Each row carries the user identity (id, email, name) the UI
 *     needs to render the table.
 *   - `joinedAt` is the OrgMembership.createdAt as ISO.
 *   - Empty org → empty array (the UI's empty-state is visible).
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import { listOrgMembers } from '@/app-layer/usecases/org-members';
import type { OrgContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic O-4 — listOrgMembers usecase (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `members-list-${Date.now()}`;
    let orgId = '';
    let adminUserId = '';
    let readerAUserId = '';
    let readerBUserId = '';
    let unrelatedUserId = '';
    let unrelatedOrgId = '';

    function ctxFor(): OrgContext {
        return {
            requestId: 'req-test',
            userId: adminUserId,
            organizationId: orgId,
            orgSlug: `${uniq}-org`,
            orgRole: 'ORG_ADMIN',
            permissions: {
                canViewPortfolio: true,
                canDrillDown: true,
                canExportReports: true,
                canManageTenants: true,
                canManageMembers: true,
            canConfigureDashboard: true,
            canSetThreatLevel: true,
            canSetMaturity: true,
            },
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const org = await prisma.organization.create({
            data: { name: `${uniq} corp`, slug: `${uniq}-org` },
        });
        orgId = org.id;

        // Seeds in NON-alphabetical order on purpose so the sort
        // assertion below is meaningful.
        const admin = await prisma.user.create({
            data: { email: `${uniq}-zadmin@example.com`, name: 'Z Admin' },
        });
        adminUserId = admin.id;
        const readerB = await prisma.user.create({
            data: { email: `${uniq}-reader-b@example.com`, name: null },
        });
        readerBUserId = readerB.id;
        const readerA = await prisma.user.create({
            data: { email: `${uniq}-reader-a@example.com`, name: 'A Reader' },
        });
        readerAUserId = readerA.id;
        const unrelated = await prisma.user.create({
            data: { email: `${uniq}-other@example.com`, name: null },
        });
        unrelatedUserId = unrelated.id;

        await prisma.orgMembership.createMany({
            data: [
                { organizationId: orgId, userId: admin.id, role: 'ORG_ADMIN' },
                { organizationId: orgId, userId: readerB.id, role: 'ORG_READER' },
                { organizationId: orgId, userId: readerA.id, role: 'ORG_READER' },
            ],
        });

        // Second org with an admin → must NOT leak into our list.
        const otherOrg = await prisma.organization.create({
            data: { name: `${uniq} other`, slug: `${uniq}-other-org` },
        });
        unrelatedOrgId = otherOrg.id;
        await prisma.orgMembership.create({
            data: {
                organizationId: otherOrg.id,
                userId: unrelated.id,
                role: 'ORG_ADMIN',
            },
        });
    });

    afterAll(async () => {
        await prisma.orgMembership.deleteMany({
            where: { organizationId: { in: [orgId, unrelatedOrgId] } },
        }).catch(() => {});
        await prisma.organization.deleteMany({
            where: { id: { in: [orgId, unrelatedOrgId] } },
        }).catch(() => {});
        await prisma.user.deleteMany({
            where: {
                id: {
                    in: [adminUserId, readerAUserId, readerBUserId, unrelatedUserId].filter(Boolean),
                },
            },
        });
        await prisma.$disconnect();
    });

    it('returns only the org\'s members (cross-org isolation)', async () => {
        const rows = await listOrgMembers(ctxFor());
        expect(rows).toHaveLength(3);
        const ids = rows.map((r) => r.userId).sort();
        expect(ids).toEqual([adminUserId, readerAUserId, readerBUserId].sort());
        expect(rows.find((r) => r.userId === unrelatedUserId)).toBeUndefined();
    });

    it('sorts ORG_ADMIN first, then alphabetical email within each role', async () => {
        const rows = await listOrgMembers(ctxFor());
        // Admin (Z) first because of role priority, even though their
        // email sorts after the readers'.
        expect(rows[0].role).toBe('ORG_ADMIN');
        expect(rows[0].userId).toBe(adminUserId);
        // Then readers, alphabetical by email.
        expect(rows[1].role).toBe('ORG_READER');
        expect(rows[1].userId).toBe(readerAUserId);
        expect(rows[2].role).toBe('ORG_READER');
        expect(rows[2].userId).toBe(readerBUserId);
    });

    it('each row carries the user identity needed by the UI', async () => {
        const rows = await listOrgMembers(ctxFor());
        for (const row of rows) {
            expect(typeof row.user.id).toBe('string');
            expect(typeof row.user.email).toBe('string');
            expect(row.user.email.includes('@')).toBe(true);
            // `name` is nullable — verify the type, not the value.
            expect(['string', 'object']).toContain(typeof row.user.name);
            expect(typeof row.joinedAt).toBe('string');
            expect(new Date(row.joinedAt).toString()).not.toBe('Invalid Date');
        }
    });

    it('returns [] for an org with zero members (no error)', async () => {
        const emptyOrg = await prisma.organization.create({
            data: { name: `${uniq} empty corp`, slug: `${uniq}-empty-org` },
        });
        try {
            const ctx: OrgContext = {
                ...ctxFor(),
                organizationId: emptyOrg.id,
                orgSlug: emptyOrg.slug,
            };
            const rows = await listOrgMembers(ctx);
            expect(rows).toEqual([]);
        } finally {
            await prisma.organization.delete({ where: { id: emptyOrg.id } });
        }
    });
});
