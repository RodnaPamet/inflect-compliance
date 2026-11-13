/**
 * The journal's disable-path lookups read DISABLE rows only (#5141).
 *
 * `findRestorableState`, `hasUnsettledWrite` and `settleIndeterminateAsApplied`
 * keyed on (provider, account) and nothing else. The journal also holds a
 * restore's ENABLE, the joiner's CREATE / ENABLE / ISSUE_CREDENTIAL, all under
 * the same account. So:
 *
 *  - a restore read handed back the newest write of ANY kind as "the state to
 *    restore" — a restore's own capture is the account DISABLED;
 *  - an unconfirmed RESTORE was settled APPLIED by the read that shows the
 *    account still disabled, which is proof it did NOT land.
 *
 * Driven against the real table, so the filter is the database's answer and
 * not a mock's.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    findRestorableState,
    hasUnsettledWrite,
    settleIndeterminateAsApplied,
} from '@/app-layer/usecases/identity-write-journal';

const prisma: PrismaClient = prismaTestClient();

const TENANT = 'iwj-action-scope';
const PROVIDER = 'entra-id';
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT });

/**
 * Journal rows only. The tenant is upserted and left: a settle writes an
 * audit row through the app client, and the hash-chained audit trail is
 * immutable, so the tenant it names cannot be deleted afterwards.
 */
async function clear(): Promise<void> {
    await prisma.identityWriteJournal.deleteMany({ where: { tenantId: TENANT } });
}

async function journal(
    externalUserId: string,
    action: 'DISABLE_ACCOUNT' | 'ENABLE_ACCOUNT' | 'CREATE_ACCOUNT',
    outcome: 'APPLIED' | 'INDETERMINATE' | 'PENDING',
    attemptedAt: Date,
    priorStateJson: Prisma.InputJsonObject,
) {
    return prisma.identityWriteJournal.create({
        data: {
            tenantId: TENANT,
            provider: PROVIDER,
            externalUserId,
            action,
            mode: 'AUTOMATIC',
            outcome,
            attemptedAt,
            priorStateJson,
        },
    });
}

beforeAll(async () => {
    await clear();
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: 'Journal action scope', slug: TENANT },
    });
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.identityWriteJournal.deleteMany({ where: { tenantId: TENANT } });
});

describe('a restore reads the DISABLE capture, not a later write to the same account', () => {
    it('skips a newer restore (ENABLE) and returns the disable it would undo', async () => {
        const disable = await journal('acc-1', 'DISABLE_ACCOUNT', 'APPLIED', new Date('2026-11-01T05:00:00Z'), {
            accountEnabled: true,
        });
        await journal('acc-1', 'ENABLE_ACCOUNT', 'APPLIED', new Date('2026-11-02T09:00:00Z'), {
            accountEnabled: false,
        });

        const r = await findRestorableState(ctx, PROVIDER, 'acc-1');

        expect(r?.journalId).toBe(disable.id);
        expect(r?.priorState).toEqual({ accountEnabled: true });
    });

    it('finds nothing to restore for an account only ever CREATED', async () => {
        await journal('acc-2', 'CREATE_ACCOUNT', 'APPLIED', new Date('2026-11-01T05:00:00Z'), {
            accountExisted: false,
        });
        expect(await findRestorableState(ctx, PROVIDER, 'acc-2')).toBeNull();
    });
});

describe('an observed-disabled account settles only a DISABLE', () => {
    it('leaves an unconfirmed RESTORE unsettled — disabled is proof it did not land', async () => {
        const restore = await journal('acc-3', 'ENABLE_ACCOUNT', 'INDETERMINATE', new Date('2026-11-02T09:00:00Z'), {
            accountEnabled: false,
        });

        expect(await hasUnsettledWrite(ctx, PROVIDER, 'acc-3')).toBe(false);
        expect(await settleIndeterminateAsApplied(ctx, PROVIDER, 'acc-3')).toBeNull();

        const row = await prisma.identityWriteJournal.findUniqueOrThrow({ where: { id: restore.id } });
        expect(row.outcome).toBe('INDETERMINATE');
    });

    it('still settles an unconfirmed DISABLE beside it', async () => {
        const disable = await journal('acc-4', 'DISABLE_ACCOUNT', 'INDETERMINATE', new Date('2026-11-01T05:00:00Z'), {
            accountEnabled: true,
        });
        const restore = await journal('acc-4', 'ENABLE_ACCOUNT', 'PENDING', new Date('2026-11-02T09:00:00Z'), {
            accountEnabled: false,
        });

        expect(await hasUnsettledWrite(ctx, PROVIDER, 'acc-4')).toBe(true);
        expect(await settleIndeterminateAsApplied(ctx, PROVIDER, 'acc-4')).toBe(disable.id);

        const rows = await prisma.identityWriteJournal.findMany({
            where: { id: { in: [disable.id, restore.id] } },
            select: { id: true, outcome: true },
        });
        const outcome = Object.fromEntries(rows.map((r) => [r.id, r.outcome]));
        expect(outcome[disable.id]).toBe('APPLIED');
        expect(outcome[restore.id]).toBe('PENDING');
    });
});
