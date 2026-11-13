/**
 * #5287 — a soft delete must belong to the caller's transaction.
 *
 * `withSoftDeleteExtension` rewrites `delete` into an `update`, and to do so it
 * dispatches to `modelOps(model)` — the client the extension was BUILT on, not
 * the interactive-transaction client the caller holds. Its own comment explains
 * why `query` cannot be reused ("bound to the original `delete` operation") and
 * then misses what the sibling method is bound to.
 *
 * Prisma has no AsyncLocalStorage transaction propagation, so that write goes
 * out on another pooled connection: it commits immediately, outside the
 * transaction, and outside RLS (the connection never ran `SET LOCAL ROLE
 * app_user`, so `superuser_bypass` matches).
 *
 * ═══ WHY THIS TEST IS TRANSACTIONAL ═══
 *
 * A test that soft-deletes and asserts `deletedAt` was set PASSES AGAINST THE
 * BUG — the row really is soft-deleted either way. The only observation that
 * separates the two worlds is a rollback: inside a transaction that throws, a
 * tx-bound write disappears and an escaped one survives. So each case below
 * throws on purpose and asserts what remains.
 */
import { randomUUID } from 'crypto';
import { prismaTestClient } from '../helpers/db';
import { prisma as appPrisma } from '@/lib/prisma';
import { DB_AVAILABLE } from './db-helper';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const prisma = prismaTestClient();

const SUITE = randomUUID().slice(0, 8);
let tenantId = '';
let ctx: ReturnType<typeof makeRequestContext>;

/** Read the row with no soft-delete filter, so a deleted row is still visible. */
async function readRisk(id: string): Promise<{ deletedAt: Date | null } | null> {
    const rows = (await prisma.$queryRawUnsafe(
        `SELECT "deletedAt" FROM "Risk" WHERE id = $1`,
        id,
    )) as Array<{ deletedAt: Date | null }>;
    return rows[0] ?? null;
}

async function makeRisk(): Promise<string> {
    const r = await prisma.risk.create({
        data: { tenantId, title: `r-${randomUUID().slice(0, 6)}`, likelihood: 2, impact: 2 },
    });
    return r.id;
}

describeFn('a soft delete belongs to the caller transaction (#5287)', () => {
    beforeAll(async () => {
        // NO resetDatabase(): this suite makes its own tenant and removes it
        // again, and the test database is SHARED — wiping it would take a
        // peer's run with it.
        const t = await prisma.tenant.create({
            data: { name: `sd-${SUITE}`, slug: `sd-${SUITE}` },
        });
        tenantId = t.id;
        ctx = makeRequestContext('ADMIN', { tenantId });
    });

    afterAll(async () => {
        await prisma.risk.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    });

    it('a ROLLED-BACK transaction leaves the row NOT soft-deleted', async () => {
        const riskId = await makeRisk();

        await expect(
            runInTenantContext(ctx, async (db) => {
                await db.risk.delete({ where: { id: riskId } });
                // Anything after the delete can fail — a failing `logEvent` is
                // the real case (`bulkDeleteRisk`), and when it does the whole
                // operation must come back.
                throw new Error('deliberate rollback');
            }),
        ).rejects.toThrow(/deliberate rollback/);

        const row = await readRisk(riskId);
        expect(row).not.toBeNull();
        expect({ deletedAt: row!.deletedAt }).toEqual({ deletedAt: null });
    });

    it('a rolled-back deleteMany leaves every row NOT soft-deleted', async () => {
        const a = await makeRisk();
        const b = await makeRisk();

        await expect(
            runInTenantContext(ctx, async (db) => {
                await db.risk.deleteMany({ where: { id: { in: [a, b] } } });
                throw new Error('deliberate rollback');
            }),
        ).rejects.toThrow(/deliberate rollback/);

        for (const id of [a, b]) {
            const row = await readRisk(id);
            // NOT `row?.deletedAt ?? 'missing'`: `??` treats null as nullish,
            // so a correctly-null deletedAt would read as 'missing' and this
            // assertion would fail against a working fix.
            expect({ id, present: row !== null }).toEqual({ id, present: true });
            expect({ id, deletedAt: row!.deletedAt }).toEqual({ id, deletedAt: null });
        }
    });

    it('still soft-deletes with NO tenant transaction in scope', async () => {
        // The case the call-site measurement demanded. 14 of the 16 soft-delete
        // call sites are transactional, but `jobs/evidence-import.ts` and
        // `services/evidence-blob-purge.ts` call in on the GLOBAL client with
        // no transaction at all. There the extension's own client IS the
        // caller's client, so dispatching to it is correct — and a fix that
        // refused when the tx-bound writer is absent would break those two
        // jobs while looking right on every test above.
        const riskId = await makeRisk();

        // THE APP's client, which carries the soft-delete extension —
        // `prismaTestClient()` does not (it wires only
        // `withPiiEncryptionExtension`), so a delete through it is a HARD
        // delete and could not exercise this path at all.
        await appPrisma.risk.delete({ where: { id: riskId } });

        const row = await readRisk(riskId);
        expect(row).not.toBeNull();
        expect(row!.deletedAt).not.toBeNull();
    });

    it('a COMMITTED transaction still soft-deletes — the positive control', async () => {
        // Without this, a fix that simply stopped soft-deleting would pass the
        // two cases above.
        const riskId = await makeRisk();

        await runInTenantContext(ctx, async (db) => {
            await db.risk.delete({ where: { id: riskId } });
        });

        const row = await readRisk(riskId);
        expect(row).not.toBeNull();
        expect(row!.deletedAt).not.toBeNull();
    });

});
