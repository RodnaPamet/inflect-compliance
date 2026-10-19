/**
 * A custom role is never built on OWNER or AI_ADMIN (#3734) — against a real
 * database, across two tenants.
 *
 * A membership carrying a custom role resolves to the role's BASE, so a custom
 * role on OWNER would make every membership carrying it resolve as OWNER. The
 * usecases refuse that (`VALID_BASE_ROLES`); this file shows the database
 * backstop on real rows:
 *
 *   - the CHECK `TenantCustomRole_base_role_not_built_in_scope` refuses OWNER and
 *     AI_ADMIN on INSERT and on UPDATE, in raw SQL no usecase stands in front of,
 *     and every other base still goes in;
 *   - the migration VALIDATED it on a clean database, and with an offending row
 *     present it leaves it NOT VALID instead of failing the deploy — the row then
 *     refuses any update that keeps its base, and moving the base clears it;
 *   - `deleteCustomRole` removes such a legacy row through the product: the soft
 *     delete moves the base to READER in the same write, and clears the role off
 *     every membership — in its own tenant only.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';

import { deleteCustomRole } from '@/app-layer/usecases/custom-roles';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const CHECK = 'TenantCustomRole_base_role_not_built_in_scope';
const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261019005000_custom_role_base_role_check/migration.sql',
);

/**
 * The migration's two statements, verbatim, comments stripped: the NOT VALID
 * `ADD CONSTRAINT`, then the `DO` block that validates only on a clean table.
 */
function migrationStatements(): [string, string] {
    const sql = readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, '');
    const at = sql.indexOf('DO $$');
    const strip = (s: string) => s.trim().replace(/;\s*$/, '');
    return [strip(sql.slice(0, at)), strip(sql.slice(at))];
}

describeFn('a custom role is never built on OWNER or AI_ADMIN (real DB, two tenants)', () => {
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
        const slug = `base-role-${suffix}-${stamp}`;
        const result = await createTenantWithOwner({
            name: `Base role ${suffix}`,
            slug,
            ownerEmail: `base-role-owner-${suffix}-${stamp}@example.com`,
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

    const insertRole = (db: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] }, id: string, tenantId: string, baseRole: string) =>
        db.$executeRawUnsafe(
            `INSERT INTO "TenantCustomRole" (id, "tenantId", name, "baseRole", "permissionsJson", "updatedAt")
             VALUES ($1, $2, $1, $3::"Role", '{}'::jsonb, NOW())`,
            id,
            tenantId,
            baseRole,
        );

    const checkState = async () =>
        prisma.$queryRawUnsafe<Array<{ contype: string; convalidated: boolean }>>(
            `SELECT contype::text AS contype, convalidated FROM pg_constraint WHERE conname = $1`,
            CHECK,
        );

    /** A raw SQL statement's failure, as text — `null` when it succeeded. */
    async function sqlError(run: () => Promise<unknown>): Promise<string | null> {
        try {
            await run();
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }

    // FIRST, on purpose: later tests drop and re-add the CHECK, and this one must
    // see what the migration itself left behind.
    it('the migration added the CHECK and VALIDATED it on a clean database', async () => {
        expect(await checkState()).toEqual([{ contype: 'c', convalidated: true }]);
    });

    it('the CHECK refuses OWNER and AI_ADMIN on INSERT and UPDATE — raw SQL, no usecase in front — and admits every other base', async () => {
        const a = await tenant('sql');

        for (const base of ['OWNER', 'AI_ADMIN']) {
            const tag = base.toLowerCase();
            expect(await sqlError(() => insertRole(prisma, `cr-${tag}-ins-${stamp}`, a.tenantId, base))).toContain(CHECK);

            const clean = `cr-${tag}-upd-${stamp}`;
            await insertRole(prisma, clean, a.tenantId, 'READER');
            expect(
                await sqlError(() =>
                    prisma.$executeRawUnsafe(
                        `UPDATE "TenantCustomRole" SET "baseRole" = $2::"Role" WHERE id = $1`,
                        clean,
                        base,
                    ),
                ),
            ).toContain(CHECK);
            const row = await prisma.tenantCustomRole.findUniqueOrThrow({ where: { id: clean }, select: { baseRole: true } });
            expect(row.baseRole).toBe('READER');
        }

        for (const base of ['ADMIN', 'EDITOR', 'AUDITOR', 'READER']) {
            expect(await sqlError(() => insertRole(prisma, `cr-${base.toLowerCase()}-ok-${stamp}`, a.tenantId, base))).toBeNull();
        }
    });

    it('with an offending row present, the migration leaves the CHECK NOT VALID — the row refuses updates that keep its base, and moving the base clears it', async () => {
        const a = await tenant('legacy-sql');
        const [addConstraint, doBlock] = migrationStatements();
        const ROLLBACK = new Error('rollback: this test leaves no schema change behind');
        const seen: Record<string, unknown> = {};

        await prisma
            .$transaction(
                async (tx) => {
                    // The pre-#3734 world: no CHECK, and a custom role built on OWNER.
                    await tx.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" DROP CONSTRAINT "${CHECK}"`);
                    const id = `cr-legacy-${stamp}`;
                    await insertRole(tx, id, a.tenantId, 'OWNER');

                    // The migration, replayed verbatim: it does not fail on the row.
                    await tx.$executeRawUnsafe(addConstraint);
                    await tx.$executeRawUnsafe(doBlock);
                    seen.afterMigration = await tx.$queryRawUnsafe(
                        `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
                        CHECK,
                    );

                    // NOT VALID still checks updates: a rename that keeps the base is refused.
                    await tx.$executeRawUnsafe('SAVEPOINT rename');
                    seen.rename = await sqlError(() =>
                        tx.$executeRawUnsafe(`UPDATE "TenantCustomRole" SET name = 'renamed' WHERE id = $1`, id),
                    );
                    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rename');

                    // Moving the base into range satisfies it, and VALIDATE then succeeds.
                    seen.rebase = await sqlError(() =>
                        tx.$executeRawUnsafe(`UPDATE "TenantCustomRole" SET "baseRole" = 'READER' WHERE id = $1`, id),
                    );
                    seen.validate = await sqlError(() =>
                        tx.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" VALIDATE CONSTRAINT "${CHECK}"`),
                    );
                    throw ROLLBACK;
                },
                { timeout: 30_000 },
            )
            .catch((e) => {
                if (e !== ROLLBACK) throw e;
            });

        expect(seen).toEqual({
            afterMigration: [{ convalidated: false }],
            rename: expect.stringContaining(CHECK),
            rebase: null,
            validate: null,
        });
        expect(await checkState()).toEqual([{ contype: 'c', convalidated: true }]);
    });

    it('deleteCustomRole removes a legacy OWNER-based role: the base moves to READER in the same write, its memberships are cleared, and tenant B is untouched', async () => {
        const a = await tenant('legacy-delete');
        const b = await tenant('legacy-delete-b');
        const legacy = `cr-legacy-delete-${stamp}`;
        const bRole = `cr-b-reader-${stamp}`;
        const member = await prisma.user.create({
            data: { email: `base-role-member-${stamp}@example.com`, name: 'member' },
            select: { id: true },
        });

        try {
            // A legacy row under a NOT VALID CHECK — the state the WARNING branch leaves.
            await prisma.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" DROP CONSTRAINT "${CHECK}"`);
            await insertRole(prisma, legacy, a.tenantId, 'OWNER');
            await prisma.$executeRawUnsafe(migrationStatements()[0]);
            expect(await checkState()).toEqual([{ contype: 'c', convalidated: false }]);

            const membership = await prisma.tenantMembership.create({
                data: { tenantId: a.tenantId, userId: member.id, role: 'EDITOR', status: 'ACTIVE', customRoleId: legacy },
                select: { id: true },
            });
            await insertRole(prisma, bRole, b.tenantId, 'READER');

            await deleteCustomRole(a.ownerCtx, legacy);

            expect(
                await prisma.tenantCustomRole.findUniqueOrThrow({
                    where: { id: legacy },
                    select: { baseRole: true, isActive: true },
                }),
            ).toEqual({ baseRole: 'READER', isActive: false });
            expect(
                await prisma.tenantMembership.findUniqueOrThrow({
                    where: { id: membership.id },
                    select: { customRoleId: true },
                }),
            ).toEqual({ customRoleId: null });

            // Tenant B: neither reachable from A's context nor changed by it.
            await expect(deleteCustomRole(a.ownerCtx, bRole)).rejects.toThrow(/not found/i);
            expect(
                await prisma.tenantCustomRole.findUniqueOrThrow({
                    where: { id: bRole },
                    select: { baseRole: true, isActive: true },
                }),
            ).toEqual({ baseRole: 'READER', isActive: true });
        } finally {
            // Whatever happened above, leave the CHECK as the migration did:
            // present and VALIDATED, with no offending row left behind.
            await prisma.$executeRawUnsafe(
                `UPDATE "TenantCustomRole" SET "baseRole" = 'READER' WHERE id = $1 AND "baseRole" = 'OWNER'`,
                legacy,
            );
            await prisma.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" VALIDATE CONSTRAINT "${CHECK}"`);
        }
        expect(await checkState()).toEqual([{ contype: 'c', convalidated: true }]);
    });
});
