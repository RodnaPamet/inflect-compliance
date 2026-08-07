/**
 * `Control.annexId` uniqueness is per-tenant, not global.
 *
 * It was declared `@unique` (global) until 2026-08-06. annexId is the
 * framework's annex reference — 'A.5.1', 'A.8.2' — so EVERY tenant adopting
 * ISO 27001 uses the same values, and it IS written on tenant-owned rows.
 * The first tenant to claim 'A.5.1' therefore blocked every other tenant
 * permanently, seeding a second tenant's annex set failed P2002, and the
 * resulting 500 was a cross-tenant existence oracle.
 *
 * The shared catalogue keeps its own guarantee via a partial unique index
 * (annexId WHERE tenantId IS NULL), because a composite on a nullable
 * column cannot constrain NULLs — Postgres treats them as distinct.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = randomUUID().slice(0, 8);
const TENANT_A = `t-annex-a-${SUITE}`;
const TENANT_B = `t-annex-b-${SUITE}`;
const MARK = `annex-${SUITE}`;
/** The annex reference every ISO 27001 tenant will want. */
const SHARED_ANNEX = 'A.5.1';

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "name" = $1`, MARK);
}

describeFn('Control.annexId — tenant-scoped uniqueness', () => {
    beforeAll(async () => {
        for (const id of [TENANT_A, TENANT_B]) {
            await prisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: id, slug: id },
            });
        }
        await cleanup();
    });

    afterAll(async () => {
        await cleanup();
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await prisma.$disconnect();
    });

    it('two tenants can each hold annexId A.5.1', async () => {
        // The defect in one assertion: this threw P2002 before the fix.
        const a = await prisma.control.create({
            data: { tenantId: TENANT_A, annexId: SHARED_ANNEX, name: MARK },
        });
        const b = await prisma.control.create({
            data: { tenantId: TENANT_B, annexId: SHARED_ANNEX, name: MARK },
        });

        expect(a.annexId).toBe(SHARED_ANNEX);
        expect(b.annexId).toBe(SHARED_ANNEX);
        expect(a.tenantId).not.toBe(b.tenantId);
    });

    it('one tenant still cannot hold the same annexId twice', async () => {
        // The constraint moved scope; it did not disappear.
        await prisma.control.create({
            data: { tenantId: TENANT_A, annexId: 'A.8.2', name: MARK },
        });
        await expect(
            prisma.control.create({
                data: { tenantId: TENANT_A, annexId: 'A.8.2', name: MARK },
            }),
        ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('the shared catalogue still holds one control per annex reference', async () => {
        // Enforced by the PARTIAL index, not the composite: a composite on
        // (tenantId, annexId) cannot see NULL tenants, because Postgres
        // treats NULLs as distinct in a unique index. Without the partial
        // index this insert would succeed and the global library would
        // carry two 'A.9.9' controls.
        await prisma.control.create({
            data: { tenantId: null, annexId: 'A.9.9', name: MARK },
        });
        await expect(
            prisma.control.create({
                data: { tenantId: null, annexId: 'A.9.9', name: MARK },
            }),
        ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('a tenant may claim an annexId the shared catalogue already uses', async () => {
        // Adopting a library control into your own tenant must not collide
        // with the library row it came from.
        await prisma.control.create({
            data: { tenantId: null, annexId: 'A.7.7', name: MARK },
        });
        const owned = await prisma.control.create({
            data: { tenantId: TENANT_A, annexId: 'A.7.7', name: MARK },
        });
        expect(owned.tenantId).toBe(TENANT_A);
    });

    it('annexId stays optional — most controls have none', async () => {
        // Several rows with NULL annexId in the same tenant must not
        // collide either.
        await prisma.control.create({ data: { tenantId: TENANT_A, name: MARK } });
        await prisma.control.create({ data: { tenantId: TENANT_A, name: MARK } });
        const count = await prisma.control.count({
            where: { tenantId: TENANT_A, annexId: null, name: MARK },
        });
        expect(count).toBeGreaterThanOrEqual(2);
    });
});
