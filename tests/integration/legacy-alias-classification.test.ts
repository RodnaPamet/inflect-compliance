/**
 * Step 4b part 2 (the classification model): the alias row's shape invariant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS DEFENDING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three of the step's six reviewer actions — NON_PERSON, EXTERNAL, ORPHAN —
 * classify the ACCOUNT rather than link it to a person, so `employeeId` had to
 * become nullable to hold them. That gave up a database-level guarantee that
 * an alias always names somebody.
 *
 * `LegacyIdentityAlias_classification_shape` reinstates it, in BOTH directions:
 *
 *   EMPLOYEE      =>  employeeId IS NOT NULL
 *   anything else =>  employeeId IS NULL
 *
 * The second direction is the one worth testing hardest. "EMPLOYEE implies an
 * employeeId" alone would still admit an ORPHAN row carrying one — a row saying
 * both that the account belongs to that person and that nobody can say whose it
 * is. Whoever reads that has to guess, and the guess decides whether somebody
 * keeps access.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS AND NOT A UNIT TEST OF THE USECASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Because the claim is about the DATABASE. A usecase test proves the usecase
 * does not write a contradictory row; it cannot prove that nothing else can — a
 * backfill script, a repair query, a future caller, a migration. The constraint
 * is the thing that covers those, so the constraint is what gets tested, by
 * trying to violate it directly with the raw client.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'lac-tenant-one';
const T2 = 'lac-tenant-two';

let conn1 = '';
let conn2 = '';
let emp1 = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.legacyIdentityAlias.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    // Through the helper, with the immutability triggers disabled. A plain
    // tenant delete raises AuditLog_tenantId_fkey the moment a sibling suite
    // has written an audit row — see tests/guards/
    // integration-suite-audit-teardown.test.ts and #3336.
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name, slug: id },
        });
    }
});

beforeEach(async () => {
    await prisma.legacyIdentityAlias.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.employee.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [T1, T2] } } });

    conn1 = (await prisma.integrationConnection.create({
        data: { tenantId: T1, provider: 'legacy-mcp', name: 'legacy one', configJson: {} },
    })).id;
    conn2 = (await prisma.integrationConnection.create({
        data: { tenantId: T2, provider: 'legacy-mcp', name: 'legacy two', configJson: {} },
    })).id;
    emp1 = (await prisma.employee.create({
        data: {
            tenantId: T1, fullName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace',
            workEmail: 'ada@lac.test', status: 'ACTIVE',
        },
    })).id;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

const base = (over: Record<string, unknown> = {}) => ({
    tenantId: T1,
    connectionId: conn1,
    accountKey: 'alovelace',
    method: 'CONFIRMED_ALIAS' as const,
    confirmedAt: new Date(),
    signalsJson: [],
    ...over,
});

describe('the four classifications can each be stored in their valid shape', () => {
    it('EMPLOYEE, with an employee', async () => {
        const r = await prisma.legacyIdentityAlias.create({
            data: base({ classification: 'EMPLOYEE', employeeId: emp1 }),
        });
        expect(r.classification).toBe('EMPLOYEE');
        expect(r.employeeId).toBe(emp1);
    });

    it.each(['NON_PERSON', 'EXTERNAL', 'ORPHAN'] as const)(
        '%s, with no employee',
        async (classification) => {
            const r = await prisma.legacyIdentityAlias.create({
                data: base({ classification, employeeId: null, method: 'MANUAL' }),
            });
            expect(r.classification).toBe(classification);
            expect(r.employeeId).toBeNull();
        }
    );

    it('MANUAL is a storable method — the enum value the migration appended', async () => {
        const r = await prisma.legacyIdentityAlias.create({
            data: base({ classification: 'EMPLOYEE', employeeId: emp1, method: 'MANUAL' }),
        });
        expect(r.method).toBe('MANUAL');
    });
});

describe('the shape constraint refuses a row that contradicts itself', () => {
    it('EMPLOYEE without an employee is refused', async () => {
        await expect(
            prisma.legacyIdentityAlias.create({
                data: base({ classification: 'EMPLOYEE', employeeId: null }),
            })
        ).rejects.toThrow(/classification_shape/);
    });

    it.each(['NON_PERSON', 'EXTERNAL', 'ORPHAN'] as const)(
        '%s WITH an employee is refused — the direction a one-way check would miss',
        async (classification) => {
            await expect(
                prisma.legacyIdentityAlias.create({
                    data: base({ classification, employeeId: emp1 }),
                })
            ).rejects.toThrow(/classification_shape/);
        }
    );

    it('and refuses the contradiction on UPDATE, not only on INSERT', async () => {
        // A CHECK constraint covers both, but asserting it proves the constraint
        // is on the TABLE rather than something the create path happens to do.
        const r = await prisma.legacyIdentityAlias.create({
            data: base({ classification: 'EMPLOYEE', employeeId: emp1 }),
        });
        await expect(
            prisma.legacyIdentityAlias.update({
                where: { id: r.id },
                data: { classification: 'ORPHAN' },
            })
        ).rejects.toThrow(/classification_shape/);
    });
});

describe('one durable answer per account', () => {
    it('a second classification for the same account collides', async () => {
        // This is why the classifications live on the alias row rather than in a
        // sibling table: two tables would let an account be aliased to a person
        // AND marked NON_PERSON at once, and the strongest signal in the system
        // would be ambiguous.
        await prisma.legacyIdentityAlias.create({
            data: base({ classification: 'EMPLOYEE', employeeId: emp1 }),
        });
        await expect(
            prisma.legacyIdentityAlias.create({
                data: base({ classification: 'NON_PERSON', employeeId: null }),
            })
        ).rejects.toThrow();
    });

    it('but the same accountKey on a DIFFERENT connection is fine', async () => {
        await prisma.legacyIdentityAlias.create({
            data: base({ classification: 'EMPLOYEE', employeeId: emp1 }),
        });
        const other = await prisma.legacyIdentityAlias.create({
            data: base({
                tenantId: T2, connectionId: conn2,
                classification: 'ORPHAN', employeeId: null, method: 'MANUAL',
            }),
        });
        expect(other.accountKey).toBe('alovelace');
    });
});

describe('tenant isolation holds for the new columns', () => {
    const asTenant = async <T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
        prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
            return fn(tx as unknown as PrismaClient);
        });

    it('a tenant cannot read another tenant’s classification', async () => {
        await prisma.legacyIdentityAlias.create({
            data: base({
                tenantId: T2, connectionId: conn2, classification: 'EXTERNAL',
                employeeId: null, method: 'MANUAL',
            }),
        });

        const mine = await asTenant(T1, (tx) =>
            tx.legacyIdentityAlias.findMany({ where: { accountKey: 'alovelace' } })
        );
        expect(mine).toEqual([]);

        // The denominator: the row IS there, so the empty read above is
        // isolation rather than an empty table.
        const theirs = await asTenant(T2, (tx) =>
            tx.legacyIdentityAlias.findMany({ where: { accountKey: 'alovelace' } })
        );
        expect(theirs).toHaveLength(1);
        expect(theirs[0].classification).toBe('EXTERNAL');
    });
});
