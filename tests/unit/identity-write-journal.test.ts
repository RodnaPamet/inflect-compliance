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
    // `getRestorableStateForAccount` resolves the account before it can ask the
    // journal anything. Named here rather than in a per-test factory so a test
    // that forgets to stub it fails as "undefined is not a function" at the
    // call, not as a confusing empty result three lines later.
    connectedIdentityAccount: {
        findFirst: jest.fn(),
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
    getJournalWrite,
    getRestorableStateForAccount,
    listJournalWrites,
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

    it('redacts a directory identifier out of the stored reason — #2843 finding 22', async () => {
        // A provider rejection is not machine-safe text. `sanitizePlainText`
        // is Epic C.5's markup defence and leaves a DN completely intact, so
        // before this the journal stored the identifier verbatim — and this
        // row is read back by an operator surface and carried into an auditor
        // export, which a log line at least is not.
        const h = await beginWrite(ctx, input());
        await h.failed('LDAP result 50 modifying CN=Alice Smith,OU=Staff,DC=corp');

        const u = db.identityWriteJournal.updateMany.mock.calls[0][0];
        expect(u.data.detail).not.toMatch(/Alice Smith/);
        expect(u.data.detail).not.toMatch(/DC=corp/);
        // Still a usable sentence: the provider's answer survives, the person
        // does not.
        expect(u.data.detail).toMatch(/LDAP result 50/);
        expect(u.data.detail).toMatch(/\{account\}/);
    });

    it('redacts an email and a GUID the same way', async () => {
        const h = await beginWrite(ctx, input());
        await h.reverted('reverted for alex.leaver@acme.example (id 8f14e45f-ceea-467a-9f2c-1d1e0a0d5c77)');

        const u = db.identityWriteJournal.updateMany.mock.calls[0][0];
        expect(u.data.detail).not.toMatch(/alex\.leaver@/);
        expect(u.data.detail).not.toMatch(/8f14e45f/);
    });

    it('leaves a reason with no identifier in it alone', async () => {
        // The positive control: redaction must not be doing something to every
        // string, or the assertions above would pass against a stub.
        const h = await beginWrite(ctx, input());
        await h.failed('Graph returned 403');

        expect(db.identityWriteJournal.updateMany.mock.calls[0][0].data.detail).toBe(
            'Graph returned 403',
        );
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


// ─────────────────────────────────────────────────────────────────────
// THE READ HALF — what an operator holding a journal reference gets back.
// ─────────────────────────────────────────────────────────────────────

const ROW = {
    id: 'j1',
    linkId: 'link-1',
    provider: 'entra-id',
    action: 'DISABLE_ACCOUNT',
    mode: 'AUTOMATIC',
    outcome: 'APPLIED',
    attemptedAt: new Date('2026-09-12T05:00:00.000Z'),
    settledAt: new Date('2026-09-12T05:00:02.000Z'),
    actorUserId: null,
    priorStateJson: { accountEnabled: true, userAccountControl: 512 },
    detail: 'Entra accepted the change.',
};

describe('reading one write back by its reference', () => {
    it('returns the CAPTURED PRIOR STATE — the thing a restore reads', async () => {
        // The mail tells IT to quote the reference to somebody who can "read
        // the captured state and re-apply it". For an on-prem account the
        // captured `userAccountControl` is frequently the ONLY surviving copy
        // of what the account was — its other bits are destroyed the instant
        // the disable lands. A read surface that withheld it would leave the
        // journal write-only, which is the state that made the mail's
        // instruction unfollowable in the first place.
        db.identityWriteJournal.findFirst.mockResolvedValue(ROW);

        const write = await getJournalWrite(ctx, 'j1');

        expect(write?.priorState).toEqual({ accountEnabled: true, userAccountControl: 512 });
        expect(write?.journalId).toBe('j1');
        expect(write?.outcome).toBe('APPLIED');
    });

    it('SELECTS `detail`, the manifest-encrypted field, on this read alone', async () => {
        // A deliberate decision, argued in full on the usecase. The manifest
        // governs REST, not audience; on a FAILED or INDETERMINATE row `detail`
        // IS the answer the operator came for, because the outcome alone says
        // only "we do not know whether your directory changed".
        //
        // Asserted on the QUERY as well as the return value: the middleware
        // decrypts whatever is selected, so leaving the column out of the
        // `select` is exactly how this field would silently stop arriving.
        db.identityWriteJournal.findFirst.mockResolvedValue(ROW);

        const write = await getJournalWrite(ctx, 'j1');

        expect(db.identityWriteJournal.findFirst.mock.calls[0][0].select.detail).toBe(true);
        expect(write?.detail).toBe('Entra accepted the change.');
    });

    it('never returns the raw directory identifier', async () => {
        // This subsystem does not hand `externalUserId` out of the module —
        // every surface that has ever received one eventually persisted it
        // somewhere unencrypted. `linkId` does the same job and resolves to a
        // person only through an authorised read of the roster.
        db.identityWriteJournal.findFirst.mockResolvedValue({ ...ROW, externalUserId: 'ext-1' });

        const write = await getJournalWrite(ctx, 'j1');

        expect(db.identityWriteJournal.findFirst.mock.calls[0][0].select.externalUserId)
            .toBeUndefined();
        expect(JSON.stringify(write)).not.toContain('ext-1');
        // Paired positive: the safe handle IS there, so the absence above is
        // about the identifier rather than about an empty result.
        expect(write?.linkId).toBe('link-1');
    });

    it('scopes the lookup to the tenant as well as to the id', async () => {
        // RLS is the enforcing layer. This predicate is the one that still
        // holds if the same query is ever run from a context where it is not —
        // and without it a reference pasted from another tenant's mail would be
        // a cross-tenant read rather than a miss.
        db.identityWriteJournal.findFirst.mockResolvedValue(ROW);

        await getJournalWrite(ctx, 'j1');

        expect(db.identityWriteJournal.findFirst.mock.calls[0][0].where).toEqual({
            id: 'j1',
            tenantId: 't1',
        });
    });

    it('an unknown reference is null, not a throw', async () => {
        db.identityWriteJournal.findFirst.mockResolvedValue(null);
        expect(await getJournalWrite(ctx, 'no-such-ref')).toBeNull();
    });

    it('refuses an EMPTY reference without querying at all', async () => {
        // `findFirst({ where: { id: '' } })` is a lookup that can only miss
        // today, but it is one predicate away from returning the tenant's
        // newest row. Refusing here makes the miss explicit rather than lucky.
        expect(await getJournalWrite(ctx, '   ')).toBeNull();
        expect(db.identityWriteJournal.findFirst).not.toHaveBeenCalled();
    });
});

describe('the journal index', () => {
    it('is BOUNDED and newest-first', async () => {
        await listJournalWrites(ctx);
        const q = db.identityWriteJournal.findMany.mock.calls[0][0];
        expect(q.where.tenantId).toBe('t1');
        expect(q.orderBy).toEqual({ attemptedAt: 'desc' });
        expect(typeof q.take).toBe('number');
        expect(q.take).toBeLessThanOrEqual(100);
    });

    it('CLAMPS a caller asking for more than the page ceiling', async () => {
        // The ceiling belongs to the function, not to the request: a query
        // string is not permission to read a tenant's entire write history in
        // one response.
        await listJournalWrites(ctx, { limit: 100000 });
        expect(db.identityWriteJournal.findMany.mock.calls[0][0].take).toBe(100);
    });

    it('never selects the captured state or the encrypted detail', async () => {
        // An index exists to find the row. Selecting `priorStateJson` here
        // would ship a hundred directory captures to answer "which row was
        // it?", and selecting `detail` would decrypt a hundred values nobody
        // reads — the same shape `listUnsettledWrites` refuses one function up.
        await listJournalWrites(ctx);
        const select = db.identityWriteJournal.findMany.mock.calls[0][0].select;
        expect(select.priorStateJson).toBeUndefined();
        expect(select.detail).toBeUndefined();
        expect(select.externalUserId).toBeUndefined();
        // Paired positive: the index columns ARE selected, so the absences
        // above are about those three fields and not about an empty select.
        expect(select.id).toBe(true);
        expect(select.outcome).toBe(true);
    });

    it('filters by provider only when asked', async () => {
        // A tenant may write to more than one directory, and "what have we done
        // to this person" spans all of them — so the filter is optional rather
        // than a required argument that would quietly narrow every answer.
        await listJournalWrites(ctx);
        expect(db.identityWriteJournal.findMany.mock.calls[0][0].where.provider).toBeUndefined();

        await listJournalWrites(ctx, { provider: 'entra-id' });
        expect(db.identityWriteJournal.findMany.mock.calls[1][0].where.provider).toBe('entra-id');
    });
});

/**
 * #2877 finding 26 — `findRestorableState` had no caller in `src/`.
 *
 * The capture was taken, committed and reachable only through the reference in
 * the DISABLED mail. Nothing could ask the question from the ACCOUNT, which is
 * what is left when the mail is gone or names a write nobody can identify.
 *
 * The three outcomes are asserted separately because two of them are routinely
 * collapsed into one `null`, and an operator needs them told apart: "no such
 * account" is a mistyped or foreign reference, "no capture" is the ordinary
 * state of any tenant that has only ever run DRY_RUN.
 */
describe('getRestorableStateForAccount — the restore read, keyed by account', () => {
    beforeEach(() => {
        db.connectedIdentityAccount.findFirst.mockReset();
        db.identityWriteJournal.findFirst.mockReset();
    });

    it('resolves the account, then returns the capture the journal holds for it', async () => {
        db.connectedIdentityAccount.findFirst.mockResolvedValue({
            id: 'acc-1', provider: 'active-directory', externalUserId: 'guid-9',
        });
        db.identityWriteJournal.findFirst.mockResolvedValue({
            id: 'jrn-7',
            priorStateJson: { userAccountControl: 512 },
            attemptedAt: new Date('2026-09-12T05:00:00.000Z'),
            outcome: 'APPLIED',
        });

        const r = await getRestorableStateForAccount(ctx, 'acc-1');

        expect(r).toStrictEqual({
            kind: 'found',
            accountId: 'acc-1',
            provider: 'active-directory',
            // NAMED because it was added on purpose (#2877 f26): the restore
            // has to address the directory, and only the directory understands
            // this identifier. It must not reach a response body — the route
            // beside this picks fields explicitly rather than spreading the
            // lookup, which is what keeps that true, and the suite for that
            // route asserts the absence.
            externalUserId: 'guid-9',
            journalId: 'jrn-7',
            priorState: { userAccountControl: 512 },
            attemptedAt: new Date('2026-09-12T05:00:00.000Z'),
            outcome: 'APPLIED',
        });
    });

    it('asks the journal with the DIRECTORY identifier, which the caller never supplied', async () => {
        // The point of the account-id shape: `externalUserId` is resolved
        // server-side and never travels in a URL. If this ever queried by the
        // path segment instead, the journal lookup would carry 'acc-1'.
        db.connectedIdentityAccount.findFirst.mockResolvedValue({
            id: 'acc-1', provider: 'entra-id', externalUserId: 'ext-secret-9',
        });
        db.identityWriteJournal.findFirst.mockResolvedValue(null);

        await getRestorableStateForAccount(ctx, 'acc-1');

        expect(db.identityWriteJournal.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    provider: 'entra-id',
                    externalUserId: 'ext-secret-9',
                    tenantId: 't1',
                }),
            }),
        );
    });

    it('scopes the account read by tenant as well as by id, beside RLS', async () => {
        db.connectedIdentityAccount.findFirst.mockResolvedValue(null);

        await getRestorableStateForAccount(ctx, 'acc-elsewhere');

        expect(db.connectedIdentityAccount.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'acc-elsewhere', tenantId: 't1' },
            }),
        );
    });

    it('answers no-account for an unknown or foreign reference, without asking the journal', async () => {
        db.connectedIdentityAccount.findFirst.mockResolvedValue(null);

        const r = await getRestorableStateForAccount(ctx, 'acc-nope');

        expect(r).toStrictEqual({ kind: 'no-account' });
        // Not merely the right answer — the journal is never consulted for an
        // account this tenant cannot see.
        expect(db.identityWriteJournal.findFirst).not.toHaveBeenCalled();
    });

    it('answers no-capture — distinct from no-account — for an account never written to', async () => {
        // The ordinary case on a DRY_RUN tenant. Reporting it as "not found"
        // would send somebody looking for a bug that is not there.
        db.connectedIdentityAccount.findFirst.mockResolvedValue({
            id: 'acc-2', provider: 'entra-id', externalUserId: 'ext-2',
        });
        db.identityWriteJournal.findFirst.mockResolvedValue(null);

        const r = await getRestorableStateForAccount(ctx, 'acc-2');

        expect(r).toStrictEqual({ kind: 'no-capture', accountId: 'acc-2', provider: 'entra-id' });
    });

    it('carries INDETERMINATE through rather than hiding it, so a restore can warn', async () => {
        // The capture may be the only surviving copy of the prior state, and
        // the write it describes may never have landed. Both halves have to
        // reach the human.
        db.connectedIdentityAccount.findFirst.mockResolvedValue({
            id: 'acc-3', provider: 'active-directory', externalUserId: 'guid-3',
        });
        db.identityWriteJournal.findFirst.mockResolvedValue({
            id: 'jrn-3',
            priorStateJson: { userAccountControl: 514 },
            attemptedAt: new Date('2026-09-20T01:00:00.000Z'),
            outcome: 'INDETERMINATE',
        });

        const r = await getRestorableStateForAccount(ctx, 'acc-3');

        expect(r).toMatchObject({ kind: 'found', outcome: 'INDETERMINATE' });
    });
});
