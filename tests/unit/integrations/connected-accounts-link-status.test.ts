/**
 * The synced-identity roster says whether each account has an HR record.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. An account with no matching Employee is
 * not "not yet linked" — it is an account NO LEAVER PASS WILL EVER ACT ON. The
 * pass reads workers the HR feed marks TERMINATED, and a person the feed does
 * not carry can never be marked anything. So the account sits permanently
 * outside offboarding, and until this change nothing in the product said so.
 *
 * The reconciler has computed the reason since #2037 and persisted it since
 * #2169. Nothing read it. This is the read.
 */
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

const findManyAccounts = jest.fn();
const findManyExecutions = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            connectedIdentityAccount: { findMany: (...a: unknown[]) => findManyAccounts(...a) },
            integrationExecution: { findMany: (...a: unknown[]) => findManyExecutions(...a) },
        }),
    ),
}));

import { listConnectedAccounts } from '@/app-layer/usecases/integrations';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1' });

const account = (id: string, link: { id: string } | null) => ({
    id,
    provider: 'entra-id',
    email: `${id}@corp.example`,
    displayName: id,
    status: 'ACTIVE',
    isAdmin: false,
    mfaEnrolled: true,
    lastActiveAt: null,
    syncedAt: new Date(),
    isProtected: false,
    protectionReason: null,
    identityLink: link,
});

/** A sync execution carrying the reconcile's own verdict. */
const syncRow = (unresolved: Array<{ connectedAccountId: string; reason: string }>) => ({
    automationKey: 'entra-id.sync',
    executedAt: new Date('2026-08-30T03:00:00Z'),
    resultJson: { upserted: 10, linkReconcile: { unmatched: unresolved.length, unresolved } },
});

beforeEach(() => {
    jest.clearAllMocks();
    findManyExecutions.mockResolvedValue([]);
});

describe('link status is read LIVE, from the relation', () => {
    it('reports linked and unlinked accounts distinguishably', async () => {
        findManyAccounts.mockResolvedValue([account('a', { id: 'l1' }), account('b', null)]);

        const rows = await listConnectedAccounts(ctx);

        expect(rows.map((r) => [r.id, r.linked])).toEqual([['a', true], ['b', false]]);
    });

    it('strips the relation object rather than leaking it onto the wire', async () => {
        // The docblock on this usecase says adding FIELDS is safe and changing
        // the SHAPE is not, because the access-review page consumes this
        // response through an `Array.isArray` check that fails open. A nested
        // relation object on every row is closer to the second.
        findManyAccounts.mockResolvedValue([account('a', { id: 'l1' })]);

        const rows = await listConnectedAccounts(ctx);

        expect(rows[0]).not.toHaveProperty('identityLink');
        expect(rows[0]).toHaveProperty('linked', true);
    });

    it('does not fan out a query per account', async () => {
        // `connectedAccountId` is @unique on the link side, so the relation is
        // one row or none and rides the same findMany. A per-account lookup
        // would trip the repo's N+1 guardrail — and this list is capped at the
        // roster page size, so it would be that many round trips.
        findManyAccounts.mockResolvedValue([account('a', null), account('b', null), account('c', null)]);

        await listConnectedAccounts(ctx);

        expect(findManyAccounts).toHaveBeenCalledTimes(1);
        expect(findManyExecutions).toHaveBeenCalledTimes(1);
    });
});

describe('the reason comes from the last reconcile, and only when still unlinked', () => {
    it('names why an unlinked account could not be matched', async () => {
        findManyAccounts.mockResolvedValue([account('b', null)]);
        findManyExecutions.mockResolvedValue([
            syncRow([{ connectedAccountId: 'b', reason: 'NO_EMPLOYEE' }]),
        ]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.unlinkedReason).toBe('NO_EMPLOYEE');
    });

    it('carries NO reason for an account that has since linked', async () => {
        // The reason is a snapshot; `linked` is live. An account that linked
        // after the last sync must not still be explaining why it did not.
        findManyAccounts.mockResolvedValue([account('a', { id: 'l1' })]);
        findManyExecutions.mockResolvedValue([
            syncRow([{ connectedAccountId: 'a', reason: 'NO_EMPLOYEE' }]),
        ]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.linked).toBe(true);
        expect(row.unlinkedReason).toBeNull();
    });

    it('reports null rather than guessing when the reconcile did not name it', async () => {
        // The sample is capped at MAX_UNRESOLVED_REPORTED. An account past the
        // cap is unlinked with no recorded reason, and the caller renders that
        // as unknown — never as fine.
        findManyAccounts.mockResolvedValue([account('z', null)]);
        findManyExecutions.mockResolvedValue([syncRow([])]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.linked).toBe(false);
        expect(row.unlinkedReason).toBeNull();
    });

    it('uses only the MOST RECENT sync per provider', async () => {
        // An older run would resurrect a reason for an account that has since
        // been explained differently — or linked and unlinked again.
        findManyAccounts.mockResolvedValue([account('b', null)]);
        findManyExecutions.mockResolvedValue([
            syncRow([{ connectedAccountId: 'b', reason: 'AMBIGUOUS_EMPLOYEE' }]),
            syncRow([{ connectedAccountId: 'b', reason: 'NO_EMPLOYEE' }]),
        ]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.unlinkedReason).toBe('AMBIGUOUS_EMPLOYEE');
    });

    it('survives a resultJson that is not the shape it expects', async () => {
        // A Json column can hold a scalar, an array, or a row written before
        // linkReconcile existed. None of those may throw a roster page.
        findManyAccounts.mockResolvedValue([account('b', null)]);
        findManyExecutions.mockResolvedValue([
            { automationKey: 'entra-id.sync', executedAt: new Date(), resultJson: ['not', 'an', 'object'] },
            { automationKey: 'okta.sync', executedAt: new Date(), resultJson: null },
        ]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.linked).toBe(false);
        expect(row.unlinkedReason).toBeNull();
    });
});
