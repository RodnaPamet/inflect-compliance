/**
 * #2651 — the erasure rollback, against a REAL `ON DELETE RESTRICT` refusal.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT WAS ALREADY PROVEN, AND WHY IT WAS NOT ENOUGH
 * ═══════════════════════════════════════════════════════════════════
 *
 * #2647 mutation-proved this against the in-memory fake: make the
 * refusal stop rethrowing and 2 of 30 tests go red. That double
 * genuinely discriminates — it is not one that cannot express the
 * failing input — so most of the value was real.
 *
 * What it could not prove is the link the safety property actually
 * rests on: that **Prisma's `$transaction` against THIS schema really
 * rolls the `updateMany` back when the subsequent `delete` throws.**
 * The fake's `$transaction` promotes staged writes on resolve, so it
 * answers a question about the fake.
 *
 * That assumption is reasonable — it is what transactions are for —
 * but it is the one whose failure is UNRECOVERABLE. `AuditLog`'s
 * narrowed trigger permits `userId` value → NULL and nothing else, so
 * if a pseudonymization committed while its subject survived, no
 * statement could put the attribution back. There is no repair path,
 * which is precisely the wrong place to trust a framework guarantee to
 * hold in the shape you assumed.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY A REAL DATABASE CHANGES THE ANSWER HERE
 * ═══════════════════════════════════════════════════════════════════
 *
 * Two mechanisms exist only against real Postgres:
 *
 *   1. **The trigger.** `audit_log_immutable_guard()` grades one row at
 *      a time against a shape. A rollback is not a second UPDATE — it
 *      is a storage-level undo — so it must not need the trigger's
 *      permission. Asserting the row is BACK is how that stops being a
 *      belief about Postgres internals.
 *
 *   2. **The FK topology.** 38 foreign keys to `User` can refuse a
 *      delete (37 RESTRICT + 1 NO ACTION), and most do not appear in
 *      `schema.prisma` at all: Prisma omits `onDelete: Restrict`
 *      because it is the DEFAULT for a required relation. Grepping the
 *      schema finds ONE. The database is the only honest source, and a
 *      fake built from the schema text would model the wrong topology.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE POSITIVE CONTROL IS NOT OPTIONAL
 * ═══════════════════════════════════════════════════════════════════
 *
 * "AuditLog.userId is unchanged after a refused erasure" is satisfied
 * just as well by an erasure that never ran, by a wrong subject id, or
 * by a connection that cannot see the row. So the same seeded shape is
 * erased twice: once WITH the blocking reference (must refuse, must
 * leave attribution intact) and once WITHOUT it (must succeed, must
 * null the attribution).
 *
 * Only the pair discriminates. The second half is what proves the first
 * half's "unchanged" is a rollback rather than a no-op.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT MUTATION-PROVING THIS FOUND, AND IT REFINES THE ISSUE
 * ═══════════════════════════════════════════════════════════════════
 *
 * Three mutations, each reddening a DIFFERENT assertion here:
 *
 *   1. swallow the RESTRICT refusal instead of rethrowing
 *        -> "refuses the erasure" goes red
 *   2. make the pseudonymization a no-op
 *        -> the POSITIVE CONTROL goes red
 *   3. run the pseudonymization on the OUTER client instead of `tx`
 *        -> "leaves the audit attribution INTACT" goes red
 *
 * Mutation 1 is the one #2647 ran against the fake, and against REAL
 * Postgres it behaves differently in a way worth writing down:
 * swallowing the refusal did **not** lose the attribution. The failed
 * `DELETE` aborts the transaction at the database, so the
 * pseudonymization is undone whether or not the application rethrows.
 *
 * So the rethrow is not what makes the rollback happen — transaction
 * semantics are. The rethrow is what makes the CALLER learn. Both are
 * load-bearing and they are load-bearing for different reasons, which
 * mutation 1 alone would have hidden: it reddens a test either way and
 * looks like it proved the rollback.
 *
 * Only mutation 3 puts the pseudonymization outside the transaction's
 * protection, and it is the only one that reaches the unrecoverable
 * state this issue exists to rule out. A future edit that moves that
 * `updateMany` off `tx` for any reason is the thing to fear, and it is
 * now the thing this file catches.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const SUFFIX = randomUUID().slice(0, 8);
const TENANT = `t-erase-${SUFFIX}`;
/** Blocked by a real RESTRICT referent. */
const USER_BLOCKED = `u-erase-blocked-${SUFFIX}`;
/** The control: identical shape, no referent. */
const USER_FREE = `u-erase-free-${SUFFIX}`;
const AUDIT_BLOCKED = `a-erase-blocked-${SUFFIX}`;
const AUDIT_FREE = `a-erase-free-${SUFFIX}`;

async function mkUser(id: string) {
    const email = `${id}@example.test`;
    await globalPrisma.user.create({
        data: { id, email, emailHash: hashForLookup(email) },
    });
}

/**
 * Seed one audit row attributed to `userId`.
 *
 * Raw INSERT, matching tests/integration/audit-immutability.test.ts: the
 * hash chain is not what is under test here, and going through
 * `appendAuditEntry` would take a per-tenant advisory lock for no gain.
 */
async function mkAuditRow(id: string, userId: string) {
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id","tenantId","userId","entity","entityId","action","details","createdAt")
         VALUES ($1,$2,$3,'Control','ctrl-1','CONTROL_CREATED','erasure rollback fixture', now())`,
        id, TENANT, userId,
    );
}

async function attributionOf(auditId: string): Promise<string | null> {
    const rows = await globalPrisma.$queryRawUnsafe<Array<{ userId: string | null }>>(
        `SELECT "userId" FROM "AuditLog" WHERE "id" = $1`,
        auditId,
    );
    return rows[0]?.userId ?? null;
}

describeFn('#2651 — DSAR erasure rolls back against a real RESTRICT refusal', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        await globalPrisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        await mkUser(USER_BLOCKED);
        await mkUser(USER_FREE);
        await mkAuditRow(AUDIT_BLOCKED, USER_BLOCKED);
        await mkAuditRow(AUDIT_FREE, USER_FREE);

        // THE BLOCKER, and it is a real constraint rather than a stub.
        // "TenantMembership".userId is ON DELETE RESTRICT in Postgres —
        // verified against pg_constraint, not read off the schema, because
        // Prisma does not spell RESTRICT for a required relation.
        //
        // ADMIN, never OWNER: an OWNER row would arm the last-OWNER guard
        // during cleanup, which is a different refusal and would make a
        // green here mean something else.
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: USER_BLOCKED, role: 'ADMIN', status: 'ACTIVE' },
        });
    });

    afterAll(async () => {
        // Guarded: these are module consts so they cannot be undefined, but
        // Prisma DROPS an undefined filter rather than rejecting it, which
        // turns a cleanup into a whole-table deleteMany that never throws.
        // The guard states the invariant rather than relying on it.
        if (TENANT) {
            // Via the helper, NOT a raw DELETE. The immutability trigger
            // forbids DELETE on "AuditLog" outright — a raw teardown fails with
            // IMMUTABLE_AUDIT_LOG, which is the guard working. The helper
            // disables the triggers for exactly this statement.
            await deleteAuditRowsForTenants(globalPrisma, TENANT);
            await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
            await globalPrisma.tenant.deleteMany({ where: { id: TENANT } });
            await globalPrisma.user.deleteMany({ where: { id: { in: [USER_BLOCKED, USER_FREE] } } });
        }
        await globalPrisma.$disconnect();
    });

    it('seeds attribution that is actually visible (denominator)', async () => {
        // Without this the two assertions below could both hold against rows
        // that were never written, or were written somewhere this connection
        // cannot see.
        await expect(attributionOf(AUDIT_BLOCKED)).resolves.toBe(USER_BLOCKED);
        await expect(attributionOf(AUDIT_FREE)).resolves.toBe(USER_FREE);
    });

    it('refuses the erasure when a real RESTRICT reference exists', async () => {
        await expect(eraseUser(USER_BLOCKED)).rejects.toThrow(/refused by a reference/i);
    });

    it('leaves the audit attribution INTACT after the refusal — the rollback', async () => {
        // The load-bearing assertion of this whole file. The pseudonymization
        // ran inside the transaction and was undone by it; had it committed,
        // no statement could put this value back, because the trigger permits
        // value → NULL and nothing else.
        await expect(attributionOf(AUDIT_BLOCKED)).resolves.toBe(USER_BLOCKED);
    });

    it('leaves the subject in place after the refusal', async () => {
        const user = await globalPrisma.user.findUnique({ where: { id: USER_BLOCKED } });
        expect(user).not.toBeNull();
    });

    it('POSITIVE CONTROL — with no blocking reference, the same erasure succeeds and DOES null the attribution', async () => {
        // This is what makes "unchanged" above mean rolled-back rather than
        // never-ran. Same code path, same connection, same seeded shape; the
        // only difference is the referent.
        const receipt = await eraseUser(USER_FREE);

        expect(receipt.userDeleted).toBe(true);
        expect(receipt.auditRowsPseudonymized).toBeGreaterThanOrEqual(1);
        await expect(attributionOf(AUDIT_FREE)).resolves.toBeNull();

        const gone = await globalPrisma.user.findUnique({ where: { id: USER_FREE } });
        expect(gone).toBeNull();
    });
});
