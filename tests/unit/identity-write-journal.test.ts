/**
 * The reversibility journal: capture first, settle after, and PENDING is real.
 *
 * ═══ WHY THE ORDER IS ENFORCED BY THE API SHAPE ═══
 *
 * Disabling an account destroys the evidence of what it was — AD packs the
 * answer into one `userAccountControl` integer whose other bits are gone once
 * overwritten. `beginWrite` therefore commits the capture and RETURNS the
 * handle that settles it, so a caller cannot report an outcome without having
 * captured first. A convention saying "remember to capture" is one somebody
 * forgets on the unhappy path; this is not a convention.
 */
const db = {
    identityWriteJournal: {
        create: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import {
    beginWrite,
    findRestorableState,
    listUnsettledWrites,
} from '@/app-layer/usecases/identity-write-journal';
import { logger } from '@/lib/observability/logger';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'admin-1' });

const input = (over: Record<string, unknown> = {}) => ({
    linkId: 'link-1',
    provider: 'entra-id',
    externalUserId: 'ext-1',
    action: 'DISABLE_ACCOUNT' as const,
    mode: 'AUTOMATIC' as const,
    priorState: { accountEnabled: true },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    db.identityWriteJournal.create.mockResolvedValue({ id: 'j1' });
    db.identityWriteJournal.updateMany.mockResolvedValue({ count: 1 });
    db.identityWriteJournal.findFirst.mockResolvedValue(null);
    db.identityWriteJournal.findMany.mockResolvedValue([]);
});

describe('the capture is committed before anything can be settled', () => {
    it('writes the row PENDING and returns a handle', async () => {
        const h = await beginWrite(ctx, input());
        expect(h.journalId).toBe('j1');
        expect(db.identityWriteJournal.create.mock.calls[0][0].data).toMatchObject({
            tenantId: 't1', provider: 'entra-id', externalUserId: 'ext-1',
            action: 'DISABLE_ACCOUNT', mode: 'AUTOMATIC', outcome: 'PENDING',
        });
    });

    it('stores the prior state verbatim', async () => {
        // Opaque on purpose: the provider that captured it is the only thing
        // that can meaningfully interpret it.
        const prior = { userAccountControl: 512, memberOf: ['CN=Staff'] };
        await beginWrite(ctx, input({ priorState: prior }));
        expect(db.identityWriteJournal.create.mock.calls[0][0].data.priorStateJson).toEqual(prior);
    });

    it('records the acting user', async () => {
        await beginWrite(ctx, input());
        expect(db.identityWriteJournal.create.mock.calls[0][0].data.actorUserId).toBe('admin-1');
    });
});

describe('an empty capture is refused', () => {
    it('rejects an empty prior state', async () => {
        // `{}` cannot be told apart from "nothing to capture", and a restore
        // reading it has no way to know the answer is missing rather than
        // absent. That difference is the entire value of the row.
        await expect(beginWrite(ctx, input({ priorState: {} }))).rejects.toThrow(/empty prior state/i);
        expect(db.identityWriteJournal.create).not.toHaveBeenCalled();
    });

    it('rejects a blank target account id', async () => {
        await expect(beginWrite(ctx, input({ externalUserId: '  ' }))).rejects.toThrow(/no target account/i);
        expect(db.identityWriteJournal.create).not.toHaveBeenCalled();
    });
});

describe('settling', () => {
    it('applied() records APPLIED with a settledAt', async () => {
        const h = await beginWrite(ctx, input());
        await h.applied('disabled via Graph');
        const u = db.identityWriteJournal.updateMany.mock.calls[0][0];
        expect(u.data.outcome).toBe('APPLIED');
        expect(u.data.settledAt).toBeInstanceOf(Date);
    });

    it('failed() records FAILED and its reason', async () => {
        const h = await beginWrite(ctx, input());
        await h.failed('Graph returned 403');
        const u = db.identityWriteJournal.updateMany.mock.calls[0][0];
        expect(u.data.outcome).toBe('FAILED');
        expect(u.data.detail).toBe('Graph returned 403');
    });

    it('every settle is predicated on the row still being PENDING', async () => {
        // Append-only: a settle must not overwrite an outcome another actor
        // already recorded.
        const h = await beginWrite(ctx, input());
        await h.reverted('restored on rehire');
        expect(db.identityWriteJournal.updateMany.mock.calls[0][0].where).toMatchObject({
            id: 'j1', tenantId: 't1', outcome: 'PENDING',
        });
    });

    it('a double settle is a no-op that WARNS rather than rewriting history', async () => {
        db.identityWriteJournal.updateMany.mockResolvedValue({ count: 0 });
        const h = await beginWrite(ctx, input());
        await h.applied();
        expect(logger.warn).toHaveBeenCalled();
    });
});

describe('what a restore reads', () => {
    it('returns the most recent APPLIED write for the account', async () => {
        const when = new Date('2026-08-20T00:00:00Z');
        db.identityWriteJournal.findFirst.mockResolvedValue({
            id: 'j9', priorStateJson: { userAccountControl: 512 }, attemptedAt: when, outcome: 'APPLIED',
        });
        const r = await findRestorableState(ctx, 'active-directory', 'ext-9');
        expect(r).toEqual({
            journalId: 'j9', priorState: { userAccountControl: 512 }, attemptedAt: when, outcome: 'APPLIED',
        });
    });

    it('looks up by provider + account, NOT by link', async () => {
        // So it still answers after the link or the employee row is gone —
        // which is exactly when somebody is asking.
        await findRestorableState(ctx, 'entra-id', 'ext-1');
        const q = db.identityWriteJournal.findFirst.mock.calls[0][0];
        expect(q.where).toMatchObject({ tenantId: 't1', provider: 'entra-id', externalUserId: 'ext-1' });
        expect(q.where.linkId).toBeUndefined();
    });

    it('only considers APPLIED writes', async () => {
        // A FAILED write changed nothing, so restoring "from" it would write a
        // state the directory never left.
        await findRestorableState(ctx, 'entra-id', 'ext-1');
        expect(db.identityWriteJournal.findFirst.mock.calls[0][0].where.outcome).toEqual({
            in: ['APPLIED', 'INDETERMINATE'],
        });
    });

    it('takes the newest, not an arbitrary one', async () => {
        await findRestorableState(ctx, 'entra-id', 'ext-1');
        expect(db.identityWriteJournal.findFirst.mock.calls[0][0].orderBy).toEqual({ attemptedAt: 'desc' });
    });

    it('an account we never wrote to has nothing to restore', async () => {
        expect(await findRestorableState(ctx, 'entra-id', 'never-touched')).toBeNull();
    });
});

describe('unsettled writes are findable', () => {
    it('lists BOTH unsettled states older than a cutoff, bounded and oldest-first', async () => {
        // A crash between capture and settle leaves PENDING; a lost response
        // leaves INDETERMINATE. They mean the same thing to a human — the
        // directory may or may not have changed, go and look — so the sweep
        // must surface both or the second kind is invisible.
        const cutoff = new Date('2026-08-20T00:00:00Z');
        await listUnsettledWrites(ctx, cutoff);
        const q = db.identityWriteJournal.findMany.mock.calls[0][0];
        expect(q.where.tenantId).toBe('t1');
        expect(q.where.outcome).toEqual({ in: ['PENDING', 'INDETERMINATE'] });
        expect(q.where.attemptedAt).toEqual({ lt: cutoff });
        expect(q.orderBy).toEqual({ attemptedAt: 'asc' });
        expect(typeof q.take).toBe('number');
    });
});
