/**
 * The roster's server-side search and provider facet (#2418).
 *
 * WHY THIS IS NOT A UI DETAIL. The roster route caps its response at
 * IDENTITY_ROSTER_PAGE_SIZE with no cursor, and a directory sync stores up to
 * 5000 accounts per connection — so before these parameters existed, an
 * account sorting past row 500 could not be reached from the admin page at
 * all. That page is where an operator marks an account never-offboard, so
 * "unreachable" and "unprotectable" were the same sentence.
 *
 * Filtering has to happen in SQL for the same reason: a filter applied to the
 * page already delivered can only hide rows, never reveal the ones the cap cut
 * off. Every assertion below therefore reads the `where` handed to Prisma,
 * not the rows handed back.
 *
 * The other half of the contract is the DEFAULT. The access-reviews directory
 * gate reads this same route with no parameters and treats a short page as
 * "this is the whole roster"; under a filter a short page means only "the
 * matches fit". So a call with no options must still produce exactly the
 * tenant-scoped `where` it always produced.
 */
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

const findManyAccounts = jest.fn();
const findManyExecutions = jest.fn();
const findManyWrites = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            connectedIdentityAccount: { findMany: (...a: unknown[]) => findManyAccounts(...a) },
            integrationExecution: { findMany: (...a: unknown[]) => findManyExecutions(...a) },
            // #2480 — the roster now reads what WE last did, beside what the
            // directory last said. Defaults to no writes so every existing
            // assertion here still describes a roster with nothing applied.
            identityWriteJournal: { findMany: (...a: unknown[]) => findManyWrites(...a) },
        }),
    ),
}));

import { listConnectedAccounts } from '@/app-layer/usecases/integrations';
import {
    IDENTITY_ROSTER_PAGE_SIZE,
    IDENTITY_ROSTER_SEARCH_MAX_LENGTH,
} from '@/lib/identity-roster';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1' });

type Where = {
    tenantId?: string;
    provider?: string;
    OR?: Array<Record<string, { contains?: string; mode?: string }>>;
};

/** The `where` object handed to `connectedIdentityAccount.findMany`. */
function whereArg(): Where {
    expect(findManyAccounts).toHaveBeenCalledTimes(1);
    const [args] = findManyAccounts.mock.calls[0] as [{ where: Where }];
    return args.where;
}

beforeEach(() => {
    jest.clearAllMocks();
    findManyAccounts.mockResolvedValue([]);
    findManyExecutions.mockResolvedValue([]);
    findManyWrites.mockResolvedValue([]);
});

describe('the unfiltered read is unchanged', () => {
    it('sends tenant scope and nothing else when called with no options', async () => {
        // The access-reviews directory gate depends on this exact call. If a
        // default filter ever appears here, that gate starts inferring
        // "unsynced" from a filtered count.
        await listConnectedAccounts(ctx);

        expect(whereArg()).toEqual({ tenantId: 't1' });
    });

    it('still takes the shared cap, so the gate compares against the right number', async () => {
        await listConnectedAccounts(ctx);

        const [args] = findManyAccounts.mock.calls[0] as [{ take: number }];
        expect(args.take).toBe(IDENTITY_ROSTER_PAGE_SIZE);
    });
});

describe('a search term is applied in SQL, across the three identifiers', () => {
    it('matches email, display name and external user id, case-insensitively', async () => {
        await listConnectedAccounts(ctx, { q: 'ada' });

        const where = whereArg();
        // AND-ed with the tenant scope, not instead of it.
        expect(where.tenantId).toBe('t1');
        expect(where.OR).toEqual([
            { email: { contains: 'ada', mode: 'insensitive' } },
            { displayName: { contains: 'ada', mode: 'insensitive' } },
            // Never rendered, deliberately searched: it is the id an operator
            // copies out of the provider's own console.
            { externalUserId: { contains: 'ada', mode: 'insensitive' } },
        ]);
    });

    it('is still capped, so a search matching everything narrows rather than dumps', async () => {
        await listConnectedAccounts(ctx, { q: '@' });

        const [args] = findManyAccounts.mock.calls[0] as [{ take: number }];
        expect(args.take).toBe(IDENTITY_ROSTER_PAGE_SIZE);
    });

    it('trims the term, so a trailing space is not part of the match', async () => {
        await listConnectedAccounts(ctx, { q: '  ada@acme.test  ' });

        expect(whereArg().OR?.[0]).toEqual({
            email: { contains: 'ada@acme.test', mode: 'insensitive' },
        });
    });

    it('treats an all-whitespace term as NO term rather than a match on spaces', async () => {
        // Otherwise the roster silently collapses to the rows whose email
        // happens to contain a space — an empty page that looks like an empty
        // directory, which is the exact failure this feature exists to stop.
        await listConnectedAccounts(ctx, { q: '   ' });

        expect(whereArg()).toEqual({ tenantId: 't1' });
    });

    it('treats an empty term as NO term', async () => {
        await listConnectedAccounts(ctx, { q: '' });

        expect(whereArg()).toEqual({ tenantId: 't1' });
    });

    it('clamps an over-long term instead of rejecting it', async () => {
        const long = 'z'.repeat(IDENTITY_ROSTER_SEARCH_MAX_LENGTH + 50);

        await listConnectedAccounts(ctx, { q: long });

        const first = whereArg().OR?.[0].email?.contains;
        expect(first).toHaveLength(IDENTITY_ROSTER_SEARCH_MAX_LENGTH);
    });
});

describe('the provider facet', () => {
    it('narrows by provider without dropping the tenant scope', async () => {
        await listConnectedAccounts(ctx, { provider: 'entra-id' });

        expect(whereArg()).toEqual({ tenantId: 't1', provider: 'entra-id' });
    });

    it('composes with the search term as AND, not as an alternative', async () => {
        await listConnectedAccounts(ctx, { provider: 'okta', q: 'ada' });

        const where = whereArg();
        expect(where.tenantId).toBe('t1');
        expect(where.provider).toBe('okta');
        expect(where.OR).toHaveLength(3);
    });
});
