/**
 * `IdentityAccountLink` — RLS behaviour, and the one-account-one-worker
 * constraint, against a live Postgres.
 *
 * The structural guardrail (`tests/guardrails/rls-coverage.test.ts`) certifies
 * that the policies and the FORCE flag EXIST. That is shape. This file is
 * conduct: it drives the table under two tenant contexts and asserts what a
 * tenant-B caller can actually do.
 *
 * The stakes are specific to what this table is FOR. It is the input to a
 * leaver flow that disables directory accounts. A cross-tenant read here is not
 * an information leak in the abstract — it is one tenant's offboarding job able
 * to see, and eventually act on, another tenant's accounts.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'ial-tenant-one';
const T2 = 'ial-tenant-two';

/** Run `fn` as app_user with a tenant bound, the way the app really reads. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/** Ids seeded as superuser so both exist regardless of policy. */
const seeded: Record<string, { employeeId: string; accountId: string; linkId: string }> = {};

/**
 * `resetDatabase` truncates a fixed table list that does NOT include Tenant,
 * Employee, ConnectedIdentityAccount or IdentityAccountLink — so this suite
 * must clear its own rows or it passes exactly once on a fresh database and
 * fails on every re-run. CI always starts clean, which is precisely what would
 * have hidden it.
 *
 * Ordered child-first: the FKs cascade, but deleting explicitly keeps the
 * intent readable and does not depend on cascade behaviour under test.
 */
async function clearOwnRows(): Promise<void> {
    const tenants = { tenantId: { in: [T1, T2] } };
    await prisma.identityAccountLink.deleteMany({ where: tenants });
    await prisma.connectedIdentityAccount.deleteMany({ where: tenants });
    // Accounts first, then their connections. The FK cascades, so the order is
    // not strictly required — but a cleanup that leans on cascade ordering stops
    // being a cleanup the moment someone changes the FK.
    await prisma.integrationConnection.deleteMany({ where: tenants });
    await prisma.employee.deleteMany({ where: tenants });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
    }

    for (const t of [T1, T2]) {
        const employee = await prisma.employee.create({
            data: { tenantId: t, fullName: `Worker ${t}`, workEmail: `worker@${t}.test` },
        });
        // `connectionId` is required as of phase 2 — an account exists because a
        // connection's sync observed it, and the schema now says so.
        const oktaConn = await prisma.integrationConnection.create({
            data: { tenantId: t, provider: 'okta', name: `okta-${t}`, configJson: {} },
        });
        const account = await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: t,
                provider: 'okta',
                connectionId: oktaConn.id,
                externalUserId: `ext-${t}`,
                email: `worker@${t}.test`,
                syncedAt: new Date(),
            },
        });
        const link = await prisma.identityAccountLink.create({
            data: {
                tenantId: t,
                employeeId: employee.id,
                connectedAccountId: account.id,
                matchMethod: 'EMAIL_EXACT',
                lastVerifiedAt: new Date(),
            },
        });
        seeded[t] = { employeeId: employee.id, accountId: account.id, linkId: link.id };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a tenant sees only its own links', () => {
    it('BOTH links really exist — otherwise every assertion below is vacuous', async () => {
        // The trap this closes: `toHaveLength(1)` passes just as happily when
        // the other tenant's row was never created. Read as superuser, with no
        // tenant bound, so the rows RLS is hiding are proven to be there.
        const all = await prisma.identityAccountLink.findMany({});
        expect(all).toHaveLength(2);
        expect(all.map((r) => r.tenantId).sort()).toEqual([T1, T2]);
    });

    it('tenant one reads exactly one link, its own', async () => {
        const rows = await asTenant(T1, (tx) => tx.identityAccountLink.findMany({}));
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(seeded[T1].linkId);
    });

    it('tenant two reads exactly one link, its own', async () => {
        const rows = await asTenant(T2, (tx) => tx.identityAccountLink.findMany({}));
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(seeded[T2].linkId);
    });

    it("asking for the OTHER tenant's link by id returns nothing", async () => {
        // The id is a real row and the caller names it exactly. RLS, not a
        // where-clause, is what makes this empty.
        const row = await asTenant(T1, (tx) =>
            tx.identityAccountLink.findFirst({ where: { id: seeded[T2].linkId } }),
        );
        expect(row).toBeNull();
    });
});

describe("a tenant cannot write another tenant's link", () => {
    it('INSERT with a foreign tenantId is refused', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.identityAccountLink.create({
                    data: {
                        tenantId: T2,
                        employeeId: seeded[T2].employeeId,
                        connectedAccountId: seeded[T2].accountId,
                        matchMethod: 'MANUAL',
                        lastVerifiedAt: new Date(),
                    },
                }),
            ),
        ).rejects.toThrow();
    });

    it("UPDATE of the other tenant's row changes nothing", async () => {
        // updateMany rather than update: it reports a count instead of
        // throwing, which is what proves the row was invisible rather than
        // merely un-writable.
        const res = await asTenant(T1, (tx) =>
            tx.identityAccountLink.updateMany({
                where: { id: seeded[T2].linkId },
                data: { matchMethod: 'MANUAL' },
            }),
        );
        expect(res.count).toBe(0);

        const after = await prisma.identityAccountLink.findUnique({ where: { id: seeded[T2].linkId } });
        expect(after?.matchMethod).toBe('EMAIL_EXACT');
    });

    it("DELETE of the other tenant's row removes nothing", async () => {
        const res = await asTenant(T1, (tx) =>
            tx.identityAccountLink.deleteMany({ where: { id: seeded[T2].linkId } }),
        );
        expect(res.count).toBe(0);
        expect(await prisma.identityAccountLink.findUnique({ where: { id: seeded[T2].linkId } })).not.toBeNull();
    });

    it('cannot reassign its OWN row to another tenant', async () => {
        // The WITH CHECK half. Without it a tenant could hand a link across
        // the boundary rather than read across it.
        await expect(
            asTenant(T1, (tx) =>
                tx.identityAccountLink.update({
                    where: { id: seeded[T1].linkId },
                    data: { tenantId: T2 },
                }),
            ),
        ).rejects.toThrow();
    });
});

describe('one account belongs to at most one worker', () => {
    it('a second link for the same account is refused by the database', async () => {
        // Two workers claiming one account makes "whose account is this?"
        // unanswerable at exactly the moment the leaver flow must answer it.
        // Enforced in the schema so no code path can produce the state.
        const other = await prisma.employee.create({
            data: { tenantId: T1, fullName: 'Second Worker', workEmail: 'second@ial-tenant-one.test' },
        });
        await expect(
            prisma.identityAccountLink.create({
                data: {
                    tenantId: T1,
                    employeeId: other.id,
                    connectedAccountId: seeded[T1].accountId,
                    matchMethod: 'MANUAL',
                    lastVerifiedAt: new Date(),
                },
            }),
        ).rejects.toThrow();
    });

    it('but one worker may hold SEVERAL accounts', async () => {
        // Entra + Okta + on-prem AD for one person; disabling all of them is
        // the point. A unique on employeeId would have broken this.
        // A different provider means a different connection, which is exactly the
        // shape phase 2 made explicit: the second account is not "the same person
        // again", it is another directory's record of them.
        const entraConn = await prisma.integrationConnection.create({
            data: { tenantId: T1, provider: 'entra-id', name: `entra-${T1}`, configJson: {} },
        });
        const second = await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: T1,
                provider: 'entra-id',
                connectionId: entraConn.id,
                externalUserId: 'ext-one-entra',
                email: `worker@${T1}.test`,
                syncedAt: new Date(),
            },
        });
        const link = await prisma.identityAccountLink.create({
            data: {
                tenantId: T1,
                employeeId: seeded[T1].employeeId,
                connectedAccountId: second.id,
                matchMethod: 'EMAIL_EXACT',
                lastVerifiedAt: new Date(),
            },
        });
        expect(link.id).toBeTruthy();

        const all = await prisma.identityAccountLink.findMany({
            where: { tenantId: T1, employeeId: seeded[T1].employeeId },
        });
        expect(all.length).toBeGreaterThanOrEqual(2);
    });
});

describe('a link dies with either side it describes', () => {
    it('deleting the account removes the link', async () => {
        // An orphaned link would leave the leaver path holding a pairing that
        // points at nothing.
        const employee = await prisma.employee.create({
            data: { tenantId: T2, fullName: 'Cascade Worker', workEmail: 'cascade@ial-tenant-two.test' },
        });
        const cascadeConn = await prisma.integrationConnection.create({
            data: { tenantId: T2, provider: 'okta', name: 'okta-cascade', configJson: {} },
        });
        const account = await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: T2,
                provider: 'okta',
                connectionId: cascadeConn.id,
                externalUserId: 'ext-cascade',
                email: 'cascade@ial-tenant-two.test',
                syncedAt: new Date(),
            },
        });
        const link = await prisma.identityAccountLink.create({
            data: {
                tenantId: T2,
                employeeId: employee.id,
                connectedAccountId: account.id,
                matchMethod: 'EMAIL_EXACT',
                lastVerifiedAt: new Date(),
            },
        });

        await prisma.connectedIdentityAccount.delete({ where: { id: account.id } });
        expect(await prisma.identityAccountLink.findUnique({ where: { id: link.id } })).toBeNull();
    });
});
