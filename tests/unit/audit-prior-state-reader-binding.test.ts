/**
 * The prior-state reader is bound INSIDE the transaction, and only where a
 * write can happen.
 *
 * ═══ WHY THIS IS ITS OWN SUITE ═══
 *
 * `buildDiffJson` can be correct and the trail still unimproved, because the
 * diff only happens when a reader reaches the extension. That delivery is
 * plumbing, and plumbing is exactly what a unit test of the comparison cannot
 * see.
 *
 * It also pins a SECURITY decision that would otherwise be invisible: the
 * read-replica context does not get a reader. It takes no writes, and handing
 * it one would mean an audit row's `before` came from a replica that may lag
 * the write it claims to describe.
 */
// `runInTenantReadContext` always uses `prismaRead` and ignores any injected
// client, so the replica needs a working `$transaction` of its own here.
const replicaTx = {
    $executeRaw: jest.fn(async () => 0),
    employee: { findFirst: jest.fn(async () => ({ department: 'Sales' })) },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {},
    prisma: {},
    prismaRead: { $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(replicaTx) },
}));

import { runInTenantContext, runInTenantReadContext, withTenantDb } from '@/lib/db-context';
import { getAuditContext } from '@/lib/audit-context';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1', userId: 'u1' });

/**
 * A client whose `$transaction` hands the callback a delegate-bearing `tx`,
 * so the reader the binding builds has something real to close over.
 */
function fakeClient(row: Record<string, unknown> | null) {
    const findFirst = jest.fn(async () => row);
    return {
        client: {
            $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
                fn({
                    $executeRaw: jest.fn(async () => 0),
                    employee: { findFirst },
                }),
        },
        findFirst,
    };
}

describe('runInTenantContext', () => {
    it('binds a reader that the audit extension can find', async () => {
        const { client } = fakeClient({ department: 'Sales' });

        const seen = await runInTenantContext(
            ctx,
            async () => getAuditContext()?.readPriorState !== undefined,
            { customPrisma: client as never },
        );

        expect(seen).toBe(true);
    });

    it('reads through the TRANSACTION’s delegate, not a module-scope client', async () => {
        // The property the whole design rests on. A reader closing over
        // anything else would run outside this transaction as the owning role,
        // which bypasses RLS — and the row it returned would be written into
        // this tenant's audit trail as `before`.
        const { client, findFirst } = fakeClient({ department: 'Sales' });

        const prior = await runInTenantContext(
            ctx,
            async () => getAuditContext()?.readPriorState?.('Employee', { id: 'e1' }),
            { customPrisma: client as never },
        );

        expect(findFirst).toHaveBeenCalledWith({ where: { id: 'e1' } });
        expect(prior).toStrictEqual({ department: 'Sales' });
    });

    it('keeps the identifiers the outer binding carried', async () => {
        // The inner binding SHADOWS rather than merges, so a field left out
        // would silently disappear for everything inside the transaction.
        const { client } = fakeClient(null);

        const seen = await runInTenantContext(
            ctx,
            async () => ({ ...getAuditContext(), readPriorState: undefined }),
            { customPrisma: client as never },
        );

        expect(seen).toMatchObject({ tenantId: 't1', actorUserId: 'u1', source: 'api' });
    });

    it('resolves to null rather than throwing when the model has no delegate', async () => {
        // A prior-state read decorates an audit row; the write it describes has
        // to stand whether or not the read works.
        const { client } = fakeClient(null);

        const prior = await runInTenantContext(
            ctx,
            async () => getAuditContext()?.readPriorState?.('NoSuchModel', { id: 'x' }),
            { customPrisma: client as never },
        );

        expect(prior).toBeNull();
    });
});

describe('withTenantDb', () => {
    it('binds a reader too — it takes writes', async () => {
        const { client } = fakeClient(null);

        const seen = await withTenantDb(
            't1',
            async () => getAuditContext()?.readPriorState !== undefined,
            client as never,
        );

        expect(seen).toBe(true);
    });
});

describe('the read-replica context', () => {
    it('is deliberately NOT given a reader', async () => {
        // It takes no writes, and a `before` sourced from a replica could lag
        // the write it claims to describe. Asserted rather than left to the
        // absence of a line in db-context.
        // No client is injected: `runInTenantReadContext` takes no
        // `customPrisma` and always opens on `prismaRead`, which is why the
        // replica is mocked with its own `$transaction` at the top of this
        // file. Passing one here typechecked as `never` and did nothing.
        const seen = await runInTenantReadContext(
            ctx,
            async () => getAuditContext()?.readPriorState,
        );

        expect(seen).toBeUndefined();
    });
});
