/**
 * The roster says what WE last did, beside what the DIRECTORY last said (#2480).
 *
 * THE DEFECT THIS REPLACES. On 2026-09-12 the leaver pass disabled a real Entra
 * account at 05:00. Four hours later `/admin/integrations/identity-accounts`
 * still rendered that row `ACTIVE`, with `SYNCED` showing the same day — because
 * the sync runs at 03:00 and the pass at 05:00, so a disable always lands two
 * hours AFTER the observation that could have seen it. The row stayed wrong
 * until the next 03:00, roughly 22 hours, and the page's own subtitle invites an
 * access review from this data. For that window the review concluded the exact
 * opposite of the truth, from the screen built for the purpose.
 *
 * WHAT IS NOT THE FIX. Making the disable path write `SUSPENDED` into
 * `ConnectedIdentityAccount`. The mirror records what the directory SAID at last
 * observation; writing our intent into it would have it assert an observation it
 * never made, and if Azure AD Connect or an administrator reverted the change it
 * would then be confidently wrong in the other direction. The staleness is
 * correct. The bug was that the page had the journal row one join away and never
 * asked.
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
            identityWriteJournal: { findMany: (...a: unknown[]) => findManyWrites(...a) },
        }),
    ),
}));

import { listConnectedAccounts } from '@/app-layer/usecases/integrations';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1' });

const OBSERVED = new Date('2026-09-12T03:00:00Z');
const DISABLED_AT = new Date('2026-09-12T05:00:01Z');

const account = (over: Record<string, unknown> = {}) => ({
    id: 'acc-1',
    provider: 'entra-id',
    email: 'user1@corp.example',
    displayName: 'user1',
    status: 'ACTIVE',
    isAdmin: false,
    mfaEnrolled: true,
    lastActiveAt: null,
    syncedAt: OBSERVED,
    isProtected: false,
    protectionReason: null,
    connectionId: 'conn-1',
    connection: { name: 'Corp Entra' },
    identityLink: { id: 'link-1' },
    ...over,
});

const journalRow = (over: Record<string, unknown> = {}) => ({
    linkId: 'link-1',
    action: 'DISABLE_ACCOUNT',
    outcome: 'APPLIED',
    settledAt: DISABLED_AT,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    findManyExecutions.mockResolvedValue([]);
    findManyWrites.mockResolvedValue([]);
});

describe('a settled write the sync has not re-observed', () => {
    it('is reported, so the row stops claiming the account is ACTIVE', async () => {
        findManyAccounts.mockResolvedValue([account()]);
        findManyWrites.mockResolvedValue([journalRow()]);

        const [row] = await listConnectedAccounts(ctx);

        // The mirror is UNCHANGED and still says ACTIVE — that is correct, and
        // the fix deliberately does not touch it.
        expect(row.status).toBe('ACTIVE');
        // …but the row now also carries what we did, and that it is newer.
        expect(row.lastWriteAction).toBe('DISABLE_ACCOUNT');
        expect(row.lastWriteOutcome).toBe('APPLIED');
        expect(row.lastWriteAt).toEqual(DISABLED_AT);
        expect(row.writeNewerThanSync).toBe(true);
    });

    it('goes quiet once the sync catches up, without anyone clearing it', async () => {
        // The next 03:00 lands: the mirror re-observes the account AFTER our
        // write, so `status` is authoritative again and there is nothing to
        // warn about. This is what makes the signal self-clearing rather than
        // a flag somebody has to remember to reset.
        findManyAccounts.mockResolvedValue([
            account({ status: 'SUSPENDED', syncedAt: new Date('2026-09-13T03:00:00Z') }),
        ]);
        findManyWrites.mockResolvedValue([journalRow()]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.status).toBe('SUSPENDED');
        expect(row.lastWriteAt).toEqual(DISABLED_AT);
        expect(row.writeNewerThanSync).toBe(false);
    });

    it('reports an account never observed at all as newer', async () => {
        // `syncedAt: null` is "no observation exists". A write is unambiguously
        // more recent than nothing, and the alternative — treating null as
        // "assume the mirror is current" — is the failure direction that hid
        // the original defect.
        findManyAccounts.mockResolvedValue([account({ syncedAt: null })]);
        findManyWrites.mockResolvedValue([journalRow()]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.writeNewerThanSync).toBe(true);
    });
});

describe('what the join refuses to claim', () => {
    it('reads only SETTLED writes', async () => {
        findManyAccounts.mockResolvedValue([account()]);
        findManyWrites.mockResolvedValue([]);

        await listConnectedAccounts(ctx);

        // An unsettled row is a write still in flight or stranded
        // INDETERMINATE-and-unreconciled. Neither is a completed action to
        // render beside a status, so the filter is in the QUERY rather than
        // applied afterwards — a page-sized cap that admitted unsettled rows
        // could push the settled one out.
        const where = findManyWrites.mock.calls[0][0].where;
        expect(where.settledAt).toEqual({ not: null });
        expect(where.tenantId).toBe('t1');
        expect(where.linkId).toEqual({ in: ['link-1'] });
    });

    it('never selects `detail`, which is encrypted free text about a person', async () => {
        findManyAccounts.mockResolvedValue([account()]);

        await listConnectedAccounts(ctx);

        // `IdentityWriteJournal.detail` is on the Epic B encryption manifest, so
        // selecting it decrypts per row and puts free text naming a person on
        // the wire for every roster load. `priorStateJson` and `externalUserId`
        // stay off for the same class of reason — this page deliberately
        // SEARCHES externalUserId and never renders it.
        const select = findManyWrites.mock.calls[0][0].select;
        expect(select.detail).toBeUndefined();
        expect(select.priorStateJson).toBeUndefined();
        expect(select.externalUserId).toBeUndefined();
    });

    it('does not query the journal at all when no account is linked', async () => {
        findManyAccounts.mockResolvedValue([account({ identityLink: null })]);

        const [row] = await listConnectedAccounts(ctx);

        // Most tenants take this branch, and an `in: []` would be a pointless
        // round trip on every roster load.
        expect(findManyWrites).not.toHaveBeenCalled();
        expect(row.lastWriteAction).toBeNull();
        expect(row.writeNewerThanSync).toBe(false);
    });

    it('keeps the latest write per link when a link has several', async () => {
        findManyAccounts.mockResolvedValue([account()]);
        // Ordered newest-first by the query; the map takes the first per link.
        findManyWrites.mockResolvedValue([
            journalRow({ outcome: 'APPLIED', settledAt: DISABLED_AT }),
            journalRow({ outcome: 'FAILED', settledAt: new Date('2026-09-11T05:00:00Z') }),
        ]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.lastWriteOutcome).toBe('APPLIED');
        expect(row.lastWriteAt).toEqual(DISABLED_AT);
    });

    it('carries the OUTCOME, not just the action', async () => {
        // FAILED is a positive claim that the directory is UNCHANGED. Rendering
        // it as "disabled" would be a worse lie than the staleness being fixed,
        // so the outcome has to reach the caller for it to tell them apart.
        findManyAccounts.mockResolvedValue([account()]);
        findManyWrites.mockResolvedValue([journalRow({ outcome: 'FAILED' })]);

        const [row] = await listConnectedAccounts(ctx);

        expect(row.lastWriteOutcome).toBe('FAILED');
        expect(row.writeNewerThanSync).toBe(true);
    });
});

describe('the response SHAPE is unchanged', () => {
    it('adds fields to each row and nothing else', async () => {
        findManyAccounts.mockResolvedValue([account()]);
        findManyWrites.mockResolvedValue([journalRow()]);

        const [row] = await listConnectedAccounts(ctx);

        // The access-review directory gate consumes this endpoint through a
        // tolerant reader that fails OPEN. New sibling scalars cannot disturb
        // it; a nested `lastWrite: {…}` object per row would be closer to a
        // shape change, which is what the usecase docblock forbids.
        for (const [k, v] of Object.entries(row)) {
            expect(['object', 'string', 'boolean', 'number']).toContain(typeof v);
            if (v !== null && typeof v === 'object') expect(v).toBeInstanceOf(Date);
        }
        expect(row).not.toHaveProperty('lastWrite');
        // The relation objects stay stripped, as before.
        expect(row).not.toHaveProperty('identityLink');
        expect(row).not.toHaveProperty('connection');
    });
});
