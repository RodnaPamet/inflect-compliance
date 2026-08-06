/**
 * `Control` RLS behavioural tests.
 *
 * `Control` is the third model with a NULLABLE tenantId (global-library rows
 * carry NULL). Until migration 20260806120000 it carried the split policy
 * shape that `tests/guardrails/rls-coverage.test.ts` documents as leaky for
 * exactly this case:
 *
 *   tenant_isolation        FOR ALL  USING ("tenantId" IS NULL OR own)
 *   tenant_isolation_insert FOR INSERT WITH CHECK (own)
 *
 * A FOR ALL policy with no explicit WITH CHECK reuses its USING as the
 * implicit one, and permissive policies OR together — so the strict INSERT
 * sibling could never restrict anything, it only added another way to pass.
 *
 * The static guardrail confirms the policy shape exists. These tests
 * exercise the SEMANTICS against a live Postgres, so a future migration that
 * quietly re-adds a permissive sibling breaks here even if the static
 * surface still looks correct.
 *
 * Coverage
 * --------
 *   1. INSERT under `app_user` with own tenantId          → succeeds.
 *   2. INSERT under `app_user` with another tenantId      → blocked.
 *   3. INSERT under `app_user` with NULL tenantId         → blocked
 *      (minting a global-library row is a superuser/seed operation).
 *   4. UPDATE under `app_user` of a NULL-tenant row       → blocked
 *      (the row is READABLE but must not be WRITABLE).
 *   5. UPDATE under `app_user` setting an own row's tenantId to NULL
 *      → blocked. This is the worst of the three: it would PROMOTE a
 *      private control into the shared catalogue for every tenant.
 *   6. SELECT under `app_user` still returns global rows — the read path
 *      must not regress, since the whole point of the permissive USING is
 *      that tenants can see the shared library.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = randomUUID().slice(0, 8);
const TENANT_A = `t-ctl-a-${SUITE}`;
const TENANT_B = `t-ctl-b-${SUITE}`;
/** Marks every row this suite creates, so cleanup never touches seed data. */
const MARK = `rls-ctl-${SUITE}`;

function controlRow(overrides: { tenantId?: string | null; code?: string } = {}) {
    return {
        id: `c-${randomUUID()}`,
        tenantId: overrides.tenantId === undefined ? TENANT_A : overrides.tenantId,
        code: overrides.code ?? `${MARK}-${randomUUID().slice(0, 6)}`,
        name: MARK,
    };
}

/** Raw INSERT so the write goes through RLS rather than Prisma's own scoping. */
const INSERT_SQL = `INSERT INTO "Control"("id","tenantId","code","name","updatedAt")
                    VALUES ($1, $2, $3, $4, NOW())`;

async function cleanup() {
    // Default client = postgres role = superuser_bypass, so this reaches
    // every row including the NULL-tenant ones.
    await globalPrisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "name" = $1`, MARK);
}

describeFn('Control RLS — one asymmetric policy', () => {
    beforeAll(async () => {
        // Control.tenantId is a real FK, so both tenants must exist before
        // any row can be inserted — including the rows we EXPECT to be
        // rejected, otherwise a foreign-key error would masquerade as an
        // RLS rejection and the negative tests would pass for the wrong
        // reason.
        for (const id of [TENANT_A, TENANT_B]) {
            await globalPrisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: id, slug: id },
            });
        }
    });

    afterAll(async () => {
        await cleanup();
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await globalPrisma.$disconnect();
    });

    afterEach(async () => {
        await cleanup();
    });

    it('app_user INSERT with own tenantId succeeds', async () => {
        const row = controlRow({ tenantId: TENANT_A });
        await withTenantDb(TENANT_A, async (tx) => {
            await tx.$executeRawUnsafe(INSERT_SQL, row.id, row.tenantId, row.code, row.name);
        });
        const persisted = await globalPrisma.control.findUnique({ where: { id: row.id } });
        expect(persisted?.tenantId).toBe(TENANT_A);
    });

    it('app_user INSERT carrying another tenant id is blocked', async () => {
        const row = controlRow({ tenantId: TENANT_B });
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(INSERT_SQL, row.id, row.tenantId, row.code, row.name);
            }),
        ).rejects.toThrow();

        const leaked = await globalPrisma.control.findUnique({ where: { id: row.id } });
        expect(leaked).toBeNull();
    });

    it('app_user INSERT of a GLOBAL (NULL tenant) row is blocked', async () => {
        // Global-library rows are minted by seeds/migrations under the
        // superuser bypass. Under the old split policy the FOR ALL USING
        // clause permitted this, putting a tenant-authored row into every
        // tenant's catalogue.
        const row = controlRow({ tenantId: null });
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(INSERT_SQL, row.id, row.tenantId, row.code, row.name);
            }),
        ).rejects.toThrow();

        const leaked = await globalPrisma.control.findUnique({ where: { id: row.id } });
        expect(leaked).toBeNull();
    });

    it('app_user UPDATE of a GLOBAL (NULL tenant) row is blocked', async () => {
        const row = controlRow({ tenantId: null });
        await globalPrisma.$executeRawUnsafe(INSERT_SQL, row.id, row.tenantId, row.code, row.name);

        // The row IS visible (permissive USING), so the UPDATE matches it —
        // and then WITH CHECK (own) rejects the resulting row image. That
        // raises 42501 rather than silently matching zero rows, which is the
        // louder of the two possible behaviours and the one we want: an
        // attempt to edit the shared library fails visibly.
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "Control" SET "name" = $1 WHERE "id" = $2`,
                    'hijacked',
                    row.id,
                );
            }),
        ).rejects.toThrow(/row-level security/i);

        const after = await globalPrisma.control.findUnique({ where: { id: row.id } });
        expect(after?.name).toBe(MARK);
    });

    it('app_user cannot promote an own row into the global library', async () => {
        // The worst of the three: setting tenantId to NULL would publish a
        // private control to EVERY tenant.
        const row = controlRow({ tenantId: TENANT_A });
        await globalPrisma.$executeRawUnsafe(INSERT_SQL, row.id, row.tenantId, row.code, row.name);

        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "Control" SET "tenantId" = NULL WHERE "id" = $1`,
                    row.id,
                );
            }),
        ).rejects.toThrow();

        const after = await globalPrisma.control.findUnique({ where: { id: row.id } });
        expect(after?.tenantId).toBe(TENANT_A);
    });

    it('app_user cannot reassign an own row to another tenant', async () => {
        const row = controlRow({ tenantId: TENANT_A });
        await globalPrisma.$executeRawUnsafe(INSERT_SQL, row.id, row.tenantId, row.code, row.name);

        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "Control" SET "tenantId" = $1 WHERE "id" = $2`,
                    TENANT_B,
                    row.id,
                );
            }),
        ).rejects.toThrow();

        const after = await globalPrisma.control.findUnique({ where: { id: row.id } });
        expect(after?.tenantId).toBe(TENANT_A);
    });

    it('SELECT of global rows still succeeds — the read path must not regress', async () => {
        // The permissive USING exists so tenants can see the shared library.
        // A fix that tightened USING to `own` would break the product while
        // passing every write-side assertion above.
        const globalRow = controlRow({ tenantId: null });
        const ownRow = controlRow({ tenantId: TENANT_A });
        const foreignRow = controlRow({ tenantId: TENANT_B });
        for (const r of [globalRow, ownRow, foreignRow]) {
            await globalPrisma.$executeRawUnsafe(INSERT_SQL, r.id, r.tenantId, r.code, r.name);
        }

        const visible = await withTenantDb(TENANT_A, async (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "Control" WHERE "name" = $1`,
                MARK,
            ),
        );
        const ids = new Set(visible.map((r) => r.id));

        expect(ids.has(globalRow.id)).toBe(true); // shared library — readable
        expect(ids.has(ownRow.id)).toBe(true); // own tenant — readable
        expect(ids.has(foreignRow.id)).toBe(false); // other tenant — hidden
    });
});
