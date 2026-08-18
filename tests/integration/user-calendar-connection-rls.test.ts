/**
 * `UserCalendarConnection` is isolated by the DATABASE, not just by a `where`.
 *
 * ═══ WHY THIS TEST IS SHAPED THE WAY IT IS ═══
 *
 * `docs/calendar-surface-do-not-touch.md:41-47` records, by experiment, that
 * deleting the application-layer `tenantId` filter from a calendar loader
 * leaves the existing isolation test GREEN — because RLS catches what the
 * application stopped catching. A two-tenant test written through the usecase
 * therefore proves that *one of the two layers* works, and cannot say which.
 *
 * The row this table holds is an encrypted OAuth refresh token for a real
 * person's personal calendar. "One of the two layers works" is not a good
 * enough answer about it.
 *
 * So the assertions below go to the DATABASE DIRECTLY under the `app_user`
 * role with a tenant context bound, bypassing every application filter. What
 * survives is RLS alone. A separate case then removes the tenant predicate from
 * the query itself, to show RLS still holds when the application layer offers
 * nothing.
 *
 * ═══ TWO MUTATIONS THIS SUITE DOES NOT DETECT, AND WHY THAT IS CORRECT ═══
 *
 * Falsifying against the live database found two policy mutations that leave
 * every test green. Neither is a gap in the suite; both are cases where the
 * protection genuinely comes from somewhere other than the dropped object, and
 * writing an assertion against them would MISATTRIBUTE it.
 *
 * 1. DROPPING `tenant_isolation_insert` changes nothing. `tenant_isolation` is
 *    `FOR ALL` (`polcmd = '*'`) with a `USING` clause and no `WITH CHECK`, and
 *    Postgres uses `USING` as the `WITH CHECK` for INSERT on a FOR ALL policy.
 *    Verified empirically: with the dedicated policy dropped, a cross-tenant
 *    INSERT as `app_user` still fails with "new row violates row-level security
 *    policy". The dedicated policy is belt-and-braces matching the repo's
 *    canonical three-policy shape, which `rls-coverage.test.ts` requires — it
 *    is not what stops the write.
 *
 * 2. `NO FORCE ROW LEVEL SECURITY` changes nothing HERE. FORCE only alters
 *    behaviour for the table OWNER, and every query below runs after
 *    `SET LOCAL ROLE app_user`. FORCE still matters — it is what would make
 *    policies apply if the application ever connected as the owner — but this
 *    suite structurally cannot exercise that path, and `superuser_bypass`
 *    deliberately grants the owner access regardless.
 *
 * Both are recorded rather than papered over, because a test that appeared to
 * cover them would be worse than one that openly does not.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'ucc-tenant-one';
const T2 = 'ucc-tenant-two';
const U1 = 'ucc-user-one';
const U2 = 'ucc-user-two';

/** Run `fn` as app_user with a tenant bound, the way the app really reads. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
    }
    for (const [id, email] of [[U1, 'one@example.test'], [U2, 'two@example.test']] as const) {
        await prisma.user.create({ data: { id, email, name: email } });
    }
    // Seeded as superuser so both rows exist regardless of policy.
    await prisma.userCalendarConnection.createMany({
        data: [
            { tenantId: T1, userId: U1, provider: 'google-calendar', tokenEncrypted: 'ciphertext-one', scopesGranted: ['calendar.events'] },
            { tenantId: T2, userId: U2, provider: 'google-calendar', tokenEncrypted: 'ciphertext-two', scopesGranted: ['calendar.events'] },
        ],
    });
});

afterAll(async () => {
    await prisma.$disconnect();
});

describe('RLS alone isolates the connection rows', () => {
    it('the seed really created both rows — the test is not vacuous', async () => {
        // As superuser, bypassing policy. If this were 0 every assertion below
        // would pass while proving nothing.
        expect(await prisma.userCalendarConnection.count()).toBe(2);
    });

    it('tenant one sees only its own row, with NO tenantId in the query', async () => {
        // The query carries no application filter at all. Everything that
        // survives here is the database policy.
        const rows = await asTenant(T1, (tx) => tx.userCalendarConnection.findMany({}));
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(T1);
        expect(rows[0].tokenEncrypted).toBe('ciphertext-one');
    });

    it('tenant two likewise, and never sees tenant one’s token', async () => {
        const rows = await asTenant(T2, (tx) => tx.userCalendarConnection.findMany({}));
        expect(rows.map((r) => r.tokenEncrypted)).toEqual(['ciphertext-two']);
    });

    it('asking explicitly for the other tenant’s row returns nothing', async () => {
        // Not "is filtered out" — genuinely unreachable. This is the assertion
        // an application-layer `where` could never make.
        const rows = await asTenant(T1, (tx) =>
            tx.userCalendarConnection.findMany({ where: { tenantId: T2 } }),
        );
        expect(rows).toEqual([]);
    });

    it('an unbound tenant context returns ZERO rows, not all rows', async () => {
        // The fail-closed direction. A policy that read a missing setting as
        // "no restriction" would return both.
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            return tx.userCalendarConnection.findMany({});
        });
        expect(rows).toEqual([]);
    });
});

describe('writes are constrained too, not only reads', () => {
    it('cannot INSERT a row into another tenant', async () => {
        // Enforced by `tenant_isolation`'s USING clause, which Postgres applies
        // as the WITH CHECK for INSERT because that policy is FOR ALL — NOT by
        // `tenant_isolation_insert`, which is redundant here (see the docblock;
        // dropping it leaves this green). Without the check a compromised or
        // buggy caller could plant a connection into a tenant it cannot read —
        // invisible to that tenant and to us.
        await expect(
            asTenant(T1, (tx) =>
                tx.userCalendarConnection.create({
                    data: { tenantId: T2, userId: U2, provider: 'outlook-calendar', tokenEncrypted: 'x', scopesGranted: [] },
                }),
            ),
        ).rejects.toThrow();
    });

    it('cannot UPDATE another tenant’s token', async () => {
        const res = await asTenant(T1, (tx) =>
            tx.userCalendarConnection.updateMany({
                where: { tenantId: T2 },
                data: { tokenEncrypted: 'overwritten' },
            }),
        );
        expect(res.count).toBe(0);
        // And prove it really is untouched, not merely reported as 0.
        const victim = await prisma.userCalendarConnection.findFirst({ where: { tenantId: T2 } });
        expect(victim?.tokenEncrypted).toBe('ciphertext-two');
    });

    it('cannot DELETE another tenant’s connection', async () => {
        const res = await asTenant(T1, (tx) =>
            tx.userCalendarConnection.deleteMany({ where: { tenantId: T2 } }),
        );
        expect(res.count).toBe(0);
        expect(await prisma.userCalendarConnection.count()).toBe(2);
    });

    it('CAN write within its own tenant — isolation, not paralysis', async () => {
        // The other half of the pair. A policy that refused everything would
        // pass every test above.
        const created = await asTenant(T1, (tx) =>
            tx.userCalendarConnection.create({
                data: { tenantId: T1, userId: U1, provider: 'outlook-calendar', tokenEncrypted: 'ciphertext-three', scopesGranted: [] },
            }),
        );
        expect(created.tenantId).toBe(T1);
        await prisma.userCalendarConnection.delete({ where: { id: created.id } });
    });
});

describe('the unique constraint is per (tenant, user, provider)', () => {
    it('the SAME user in a DIFFERENT tenant is a separate connection', async () => {
        // The reason Account cannot be reused: it is per-user-global, but one
        // person holds memberships in several tenants and must be able to
        // connect for each independently — or disconnecting from one silently
        // disconnects them from all.
        await prisma.tenantMembership.createMany({
            data: [
                { tenantId: T1, userId: U1, role: 'ADMIN', status: 'ACTIVE' },
                { tenantId: T2, userId: U1, role: 'READER', status: 'ACTIVE' },
            ],
            skipDuplicates: true,
        });
        const second = await prisma.userCalendarConnection.create({
            data: { tenantId: T2, userId: U1, provider: 'google-calendar', tokenEncrypted: 'ciphertext-four', scopesGranted: [] },
        });
        expect(second.id).toBeTruthy();
        await prisma.userCalendarConnection.delete({ where: { id: second.id } });
    });

    it('a duplicate (tenant, user, provider) is refused', async () => {
        await expect(
            prisma.userCalendarConnection.create({
                data: { tenantId: T1, userId: U1, provider: 'google-calendar', tokenEncrypted: 'dupe', scopesGranted: [] },
            }),
        ).rejects.toThrow();
    });
});

describe('deleting the user takes the token with it', () => {
    it('ON DELETE CASCADE — a lingering refresh token for a deleted user is unrevokable', async () => {
        const u = await prisma.user.create({ data: { id: 'ucc-user-temp', email: 'temp@example.test', name: 'temp' } });
        await prisma.userCalendarConnection.create({
            data: { tenantId: T1, userId: u.id, provider: 'google-calendar', tokenEncrypted: 'ciphertext-temp', scopesGranted: [] },
        });
        await prisma.user.delete({ where: { id: u.id } });
        expect(await prisma.userCalendarConnection.count({ where: { userId: u.id } })).toBe(0);
    });
});
