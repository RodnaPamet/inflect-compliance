/**
 * A custom role's name is unique among LIVE roles only (#4467; owner decision,
 * 2026-10-29) — against a real database, across two tenants.
 *
 * Deleting a custom role is a soft delete (`isActive` false), and the page
 * stops listing it. The name used to stay taken for good: the duplicate checks
 * in `createCustomRole` / `updateCustomRole` matched deleted rows, and the
 * table carried a full `@@unique([tenantId, name])`. Migration
 * 20261029190000_custom_role_name_unique_among_live replaced that index with a
 * partial one (`WHERE "isActive"`), and the checks now ask the same question.
 *
 * This file shows, on real rows:
 *
 *   - the index the migration left is the partial one;
 *   - delete a role, and a new one may take its name — through the usecases,
 *     and as many times as roles are deleted;
 *   - a LIVE duplicate is still refused: by the usecase on create and on
 *     rename, and by the database itself with no usecase in front, including
 *     a deleted row brought back to life under a name a live role holds;
 *   - the name is per tenant.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';

import {
    createCustomRole,
    deleteCustomRole,
    updateCustomRole,
} from '@/app-layer/usecases/custom-roles';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const INDEX = 'TenantCustomRole_tenantId_name_key';
const READER_PERMISSIONS = getPermissionsForRole('READER');

describeFn('a custom role name is unique among live roles only (real DB, two tenants)', () => {
    let prisma: PrismaClient;
    const stamp = Date.now();

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    async function tenant(suffix: string) {
        const slug = `role-name-${suffix}-${stamp}`;
        const result = await createTenantWithOwner({
            name: `Role name ${suffix}`,
            slug,
            ownerEmail: `role-name-owner-${suffix}-${stamp}@example.com`,
            requestId: `req-${suffix}`,
        });
        const ownerCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });
        return { tenantId: result.tenant.id, ownerCtx };
    }

    const create = (ctx: ReturnType<typeof makeRequestContext>, name: string) =>
        createCustomRole(ctx, { name, baseRole: 'READER', permissionsJson: READER_PERMISSIONS });

    /** A raw SQL statement's failure, as text — `null` when it succeeded. */
    async function sqlError(run: () => Promise<unknown>): Promise<string | null> {
        try {
            await run();
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }

    it('the migration left a PARTIAL unique index over live roles, under the old name', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE tablename = 'TenantCustomRole' AND indexname = $1`,
            INDEX,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].indexdef).toMatch(/^CREATE UNIQUE INDEX .+ \("tenantId", name\) WHERE "isActive"$/);
    });

    it('a deleted role frees its name: delete, re-create with the same name, and again', async () => {
        const a = await tenant('reuse');

        const first = await create(a.ownerCtx, 'Compliance Lead');
        await deleteCustomRole(a.ownerCtx, first.id);

        // The finding: this threw "A custom role named … already exists".
        const second = await create(a.ownerCtx, 'Compliance Lead');
        expect(second.id).not.toBe(first.id);
        expect(second.isActive).toBe(true);

        // Two deleted rows may share the name too: delete the second, re-create.
        await deleteCustomRole(a.ownerCtx, second.id);
        const third = await create(a.ownerCtx, 'Compliance Lead');

        const rows = await prisma.tenantCustomRole.findMany({
            where: { tenantId: a.tenantId, name: 'Compliance Lead' },
            select: { id: true, isActive: true },
            orderBy: { createdAt: 'asc' },
        });
        expect(rows).toEqual([
            { id: first.id, isActive: false },
            { id: second.id, isActive: false },
            { id: third.id, isActive: true },
        ]);
    });

    it('a rename may take a deleted role\'s name', async () => {
        const a = await tenant('rename-free');
        const gone = await create(a.ownerCtx, 'Evidence Reviewer');
        await deleteCustomRole(a.ownerCtx, gone.id);

        const other = await create(a.ownerCtx, 'Temporary name');
        const renamed = await updateCustomRole(a.ownerCtx, other.id, { name: 'Evidence Reviewer' });
        expect(renamed.name).toBe('Evidence Reviewer');
    });

    it('a LIVE duplicate is still refused by the usecase, on create and on rename', async () => {
        const a = await tenant('live-dup');
        await create(a.ownerCtx, 'Risk Owner');

        await expect(create(a.ownerCtx, 'Risk Owner')).rejects.toThrow(/already exists/);

        const other = await create(a.ownerCtx, 'Something else');
        await expect(
            updateCustomRole(a.ownerCtx, other.id, { name: 'Risk Owner' }),
        ).rejects.toThrow(/already exists/);

        const live = await prisma.tenantCustomRole.count({
            where: { tenantId: a.tenantId, name: 'Risk Owner', isActive: true },
        });
        expect(live).toBe(1);
    });

    it('a LIVE duplicate is refused by the database itself, with no usecase in front', async () => {
        const a = await tenant('db-dup');
        const held = await create(a.ownerCtx, 'Policy Approver');

        // A second live row with the name: the partial index refuses it.
        await expect(
            prisma.tenantCustomRole.create({
                data: {
                    tenantId: a.tenantId,
                    name: 'Policy Approver',
                    baseRole: 'READER',
                    permissionsJson: {},
                    isActive: true,
                },
            }),
        ).rejects.toMatchObject({ code: 'P2002' });

        // A deleted row with the name goes in: the index does not cover it.
        const deletedId = `cr-deleted-${stamp}`;
        expect(
            await sqlError(() =>
                prisma.$executeRawUnsafe(
                    `INSERT INTO "TenantCustomRole" (id, "tenantId", name, "baseRole", "permissionsJson", "isActive", "updatedAt")
                     VALUES ($1, $2, 'Policy Approver', 'READER'::"Role", '{}'::jsonb, false, NOW())`,
                    deletedId,
                    a.tenantId,
                ),
            ),
        ).toBeNull();

        // Bringing that deleted row back to life while a live role holds the
        // name is refused too — no write path does it today, and none can.
        expect(
            await sqlError(() =>
                prisma.$executeRawUnsafe(
                    `UPDATE "TenantCustomRole" SET "isActive" = true WHERE id = $1`,
                    deletedId,
                ),
            ),
        ).toContain(INDEX);

        // Once the live one is deleted, the same revival is admitted.
        await deleteCustomRole(a.ownerCtx, held.id);
        expect(
            await sqlError(() =>
                prisma.$executeRawUnsafe(
                    `UPDATE "TenantCustomRole" SET "isActive" = true WHERE id = $1`,
                    deletedId,
                ),
            ),
        ).toBeNull();
    });

    it('the name is per tenant: a second tenant may hold a live role with the same name', async () => {
        const a = await tenant('per-tenant-a');
        const b = await tenant('per-tenant-b');
        await create(a.ownerCtx, 'Auditor Liaison');
        const inB = await create(b.ownerCtx, 'Auditor Liaison');
        expect(inB.tenantId).toBe(b.tenantId);
    });
});
