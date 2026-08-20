/**
 * Disabling an account: the write, and every refusal in front of it.
 *
 * The refusals carry the weight. This is the first code in the product that
 * changes a customer's directory, and the failure it must never produce is not
 * a failed write — it is a SUCCESSFUL-LOOKING one against the wrong person, the
 * wrong directory, or with no record of what it replaced.
 *
 * Every test drives an injected fake writer. There is no module-level default
 * that reaches a real directory, so no test can acquire one by forgetting.
 */
const db = {
    tenantSecuritySettings: { findUnique: jest.fn() },
    identityWriteJournal: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
    // Reached only by the leaver NOTIFICATION the batch path now enqueues.
    // Present so the batch tests exercise a working notification lookup rather
    // than its fail-open branch — a suite that silently runs the error path
    // proves nothing about the happy one.
    tenantNotificationSettings: { findUnique: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    tenant: { findUnique: jest.fn() },
    notificationOutbox: { create: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
const recordOutcome = jest.fn();
const recordBatchRefused = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordIdentityWriteOutcome: (...a: unknown[]) => recordOutcome(...a),
    recordIdentityBatchRefused: (...a: unknown[]) => recordBatchRefused(...a),
    recordIdentityWritesUnsettled: jest.fn(),
}));

import {
    DirectoryWriteError,
    disableAccount,
    disableAccountsForLeaver,
    findLeaverCandidates,
    type DirectoryWriter,
} from '@/app-layer/usecases/identity-disable-account';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'admin-1' });

/** Records what it was asked to do, and never touches a network. */
function fakeWriter(over: Partial<DirectoryWriter> = {}): DirectoryWriter & { disabled: string[] } {
    const disabled: string[] = [];
    return {
        provider: 'entra-id',
        disabled,
        readState: async () => ({ enabled: true, priorState: { accountEnabled: true } }),
        disable: async (id: string) => { disabled.push(id); },
        ...over,
    } as DirectoryWriter & { disabled: string[] };
}

const input = (over = {}) => ({
    linkId: 'link-1',
    externalUserId: 'ext-1',
    onPremisesSyncEnabled: false,
    ...over,
});

function setMode(mode: string, since: Date | null = null) {
    db.tenantSecuritySettings.findUnique.mockResolvedValue({
        identityLeaverMode: mode,
        identityJoinerMode: 'DISABLED',
        identityLeaverDryRunSince: since,
        identityJoinerDryRunSince: null,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    setMode('AUTOMATIC');
    db.identityWriteJournal.create.mockResolvedValue({ id: 'j1' });
    db.identityWriteJournal.updateMany.mockResolvedValue({ count: 1 });
    db.identityWriteJournal.findFirst.mockResolvedValue(null);
    db.identityAccountLink.findMany.mockResolvedValue([]);
    db.tenantNotificationSettings.findUnique.mockResolvedValue({ complianceMailbox: 'it@acme.test' });
    db.tenantMembership.findMany.mockResolvedValue([]);
    db.tenant.findUnique.mockResolvedValue({ slug: 'acme' });
    db.notificationOutbox.create.mockImplementation(async (a: { data: unknown }) => ({ id: 'o1', ...(a.data as object) }));
});

describe('the happy path writes, and journals what it replaced', () => {
    it('disables and reports the journal row', async () => {
        const w = fakeWriter();
        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('DISABLED');
        expect(w.disabled).toEqual(['ext-1']);
        expect(r.journalId).toBe('j1');
    });

    it('captures BEFORE the write, never after', async () => {
        // The ordering the journal exists for: a capture taken after a
        // successful write does not exist for the write that crashed halfway.
        const order: string[] = [];
        db.identityWriteJournal.create.mockImplementation(async () => { order.push('capture'); return { id: 'j1' }; });
        const w = fakeWriter({ disable: async () => { order.push('write'); } });

        await disableAccount(ctx, w, input());
        expect(order).toEqual(['capture', 'write']);
    });

    it('settles the journal APPLIED on success', async () => {
        await disableAccount(ctx, fakeWriter(), input());
        expect(db.identityWriteJournal.updateMany.mock.calls[0][0].data.outcome).toBe('APPLIED');
    });
});

describe('SELF-LOCKOUT — the one refusal that comes before everything', () => {
    /**
     * Disabling the account this connection binds with locks the product out of
     * the customer's directory by its own hand. Nothing afterwards recovers it:
     * the next sync cannot authenticate, so the journal's restore path cannot
     * reach the account to put it back.
     *
     * A plausible input, not a contrived one — service accounts appear in HR
     * exports, and the link model matches on email, which a service account
     * with a human-looking address satisfies exactly as well as a human does.
     */
    it('refuses to disable the account the writer authenticates as', async () => {
        const w = fakeWriter({ selfAccountId: 'ext-1' });
        const r = await disableAccount(ctx, w, input({ externalUserId: 'ext-1' }));

        expect(r.outcome).toBe('REFUSED_PROTECTED');
        expect(r.reason).toMatch(/lock the product out/i);
        expect(w.disabled).toEqual([]);
    });

    it('compares case- and whitespace-insensitively', async () => {
        // A bind DN and a roster value routinely differ in case.
        const w = fakeWriter({ selfAccountId: '  CN=Svc,DC=acme  ' });
        const r = await disableAccount(ctx, w, input({ externalUserId: 'cn=svc,dc=acme' }));
        expect(r.outcome).toBe('REFUSED_PROTECTED');
    });

    it('refuses BEFORE the ladder — a tenant in AUTOMATIC has not consented to this', async () => {
        setMode('AUTOMATIC');
        const readState = jest.fn();
        const w = fakeWriter({ selfAccountId: 'ext-1', readState });
        await disableAccount(ctx, w, input({ externalUserId: 'ext-1' }));
        expect(readState).not.toHaveBeenCalled();
    });

    it('still refuses in DRY_RUN, so the danger is visible before go-live', async () => {
        setMode('DRY_RUN', new Date('2026-08-01T00:00:00Z'));
        const w = fakeWriter({ selfAccountId: 'ext-1' });
        expect((await disableAccount(ctx, w, input({ externalUserId: 'ext-1' }))).outcome).toBe(
            'REFUSED_PROTECTED',
        );
    });

    it('does not refuse a DIFFERENT account', async () => {
        const w = fakeWriter({ selfAccountId: 'ext-svc' });
        expect((await disableAccount(ctx, w, input({ externalUserId: 'ext-1' }))).outcome).toBe('DISABLED');
    });

    it('a writer with no account identity refuses nothing', async () => {
        // An Entra app registration is not a user; null must not match a blank
        // externalUserId or anything else.
        const w = fakeWriter({ selfAccountId: null });
        expect((await disableAccount(ctx, w, input())).outcome).toBe('DISABLED');
    });

    it('an account marked protected is refused too', async () => {
        const w = fakeWriter();
        const r = await disableAccount(ctx, w, input({ isProtected: true }));
        expect(r.outcome).toBe('REFUSED_PROTECTED');
        expect(r.reason).toMatch(/break-glass|policy/i);
        expect(w.disabled).toEqual([]);
    });
});

describe('every outcome is counted, including the refusals', () => {
    it('counts a successful disable', async () => {
        await disableAccount(ctx, fakeWriter(), input());
        expect(recordOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'disable', outcome: 'DISABLED' }),
        );
    });

    it('counts each refusal DISTINCTLY, not as one bucket', async () => {
        // An operator's next action differs per refusal: REFUSED_MODE is normal
        // for a tenant climbing the ladder; REFUSED_PROTECTED on any volume
        // means the roster is naming service accounts.
        setMode('DISABLED');
        await disableAccount(ctx, fakeWriter(), input());
        expect(recordOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'REFUSED_MODE' }),
        );

        recordOutcome.mockClear();
        setMode('AUTOMATIC');
        await disableAccount(ctx, fakeWriter({ selfAccountId: 'ext-1' }), input({ externalUserId: 'ext-1' }));
        expect(recordOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'REFUSED_PROTECTED' }),
        );
    });

    it('a refused BATCH is its own counter, not N per-account refusals', async () => {
        // One decision about a batch. Folding it into the per-account counter
        // would make a single bad roster look like a hundred problems.
        const candidates = Array.from({ length: 400 }, (_, i) => input({ externalUserId: `e${i}` }));
        await disableAccountsForLeaver(ctx, fakeWriter(), { candidates, population: 500 });

        expect(recordBatchRefused).toHaveBeenCalledTimes(1);
        expect(recordOutcome).not.toHaveBeenCalled();
    });
});

describe('the ladder refuses before any network call', () => {
    it('DISABLED mode writes nothing and reads nothing', async () => {
        // A tenant with writes switched off must not generate directory
        // traffic to discover that writes are switched off.
        setMode('DISABLED');
        const readState = jest.fn();
        const w = fakeWriter({ readState });

        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('REFUSED_MODE');
        expect(readState).not.toHaveBeenCalled();
        expect(w.disabled).toEqual([]);
    });

    it('PROPOSE mode declines rather than behaving as AUTOMATIC', async () => {
        // PROPOSE means a human approves each one. This function performs
        // writes; silently treating PROPOSE as AUTOMATIC would be the single
        // worst misreading of the ladder.
        setMode('PROPOSE');
        const w = fakeWriter();
        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('REFUSED_MODE');
        expect(r.reason).toMatch(/approval/i);
        expect(w.disabled).toEqual([]);
    });

    it('an unset policy defaults to refusing', async () => {
        // No settings row at all — the safe reading is DISABLED, not "no
        // restriction configured".
        db.tenantSecuritySettings.findUnique.mockResolvedValue(null);
        const r = await disableAccount(ctx, fakeWriter(), input());
        expect(r.outcome).toBe('REFUSED_MODE');
    });
});

describe('the write-target refuses what would silently revert', () => {
    it('refuses a directory-synced account and says where it belongs', async () => {
        const w = fakeWriter();
        const r = await disableAccount(ctx, w, input({ onPremisesSyncEnabled: true }));
        expect(r.outcome).toBe('REFUSED_TARGET');
        expect(r.reason).toMatch(/mastered on-premises/i);
        expect(w.disabled).toEqual([]);
    });

    it('refuses when the sync flag was never observed', async () => {
        const r = await disableAccount(ctx, fakeWriter(), input({ onPremisesSyncEnabled: null }));
        expect(r.outcome).toBe('REFUSED_TARGET');
        expect(r.reason).toMatch(/never observed/i);
    });

    it('refuses BEFORE reading state — no network call for a decided refusal', async () => {
        const readState = jest.fn();
        await disableAccount(ctx, fakeWriter({ readState }), input({ onPremisesSyncEnabled: true }));
        expect(readState).not.toHaveBeenCalled();
    });
});

describe('an already-disabled account is left completely alone', () => {
    it('does not write, and does not journal', async () => {
        // Journalling here would record a prior state of "disabled", which is
        // what a later restore would restore TO — turning a harmless no-op into
        // permanent loss of the real prior state.
        const w = fakeWriter({ readState: async () => ({ enabled: false, priorState: { accountEnabled: false } }) });
        const r = await disableAccount(ctx, w, input());

        expect(r.outcome).toBe('ALREADY_DISABLED');
        expect(w.disabled).toEqual([]);
        expect(db.identityWriteJournal.create).not.toHaveBeenCalled();
    });
});

describe('DRY_RUN decides everything and writes nothing', () => {
    it('reads the real state but performs no write and no journal', async () => {
        // No journal row on purpose: a dry run replaced nothing, so a capture
        // of what it "replaced" would be a lie a restore could later read.
        setMode('DRY_RUN', new Date('2026-08-01T00:00:00Z'));
        const readState = jest.fn(async () => ({ enabled: true, priorState: { accountEnabled: true } }));
        const w = fakeWriter({ readState });

        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('DRY_RUN');
        expect(readState).toHaveBeenCalled();
        expect(w.disabled).toEqual([]);
        expect(db.identityWriteJournal.create).not.toHaveBeenCalled();
    });

    it('still refuses a synced account in dry run — the decision is the point', async () => {
        setMode('DRY_RUN', new Date('2026-08-01T00:00:00Z'));
        const r = await disableAccount(ctx, fakeWriter(), input({ onPremisesSyncEnabled: true }));
        expect(r.outcome).toBe('REFUSED_TARGET');
    });
});

describe('a LOST RESPONSE is never recorded as a refusal', () => {
    /**
     * Found by adversarial review, and it was worse than the bug it sat next
     * to. FAILED is a POSITIVE claim that the directory is unchanged. A write
     * that reached the provider, was applied, and then lost its response throws
     * exactly like a 403 does — and recording that as FAILED files the row
     * under the one outcome BOTH readers exclude: findRestorableState reads
     * APPLIED, listUnsettledWrites reads PENDING/INDETERMINATE. The captured
     * prior state becomes unreachable and nobody is told to look.
     *
     * A crash at the same instant leaves PENDING, which honestly means "go and
     * look". A timeout is the same epistemic state and must not be downgraded
     * to a certainty.
     */
    it('a timeout settles INDETERMINATE, not FAILED', async () => {
        const w = fakeWriter({ disable: async () => { throw new Error('fetch failed: ETIMEDOUT'); } });
        const r = await disableAccount(ctx, w, input());

        expect(r.outcome).toBe('INDETERMINATE');
        expect(db.identityWriteJournal.updateMany.mock.calls[0][0].data.outcome).toBe('INDETERMINATE');
    });

    it('an untyped error is treated as indeterminate — the safe default', async () => {
        // A writer must opt IN to claiming the directory is unchanged.
        const w = fakeWriter({ disable: async () => { throw new Error('something odd'); } });
        expect((await disableAccount(ctx, w, input())).outcome).toBe('INDETERMINATE');
    });

    it('a DirectoryWriteError that does NOT prove non-application is indeterminate', async () => {
        const w = fakeWriter({
            disable: async () => { throw new DirectoryWriteError('502 from the proxy'); },
        });
        expect((await disableAccount(ctx, w, input())).outcome).toBe('INDETERMINATE');
    });

    it('only a proven refusal settles FAILED', async () => {
        const w = fakeWriter({
            disable: async () => {
                throw new DirectoryWriteError('Graph 403: insufficient privileges', {
                    definitivelyNotApplied: true,
                });
            },
        });
        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('FAILED');
        expect(db.identityWriteJournal.updateMany.mock.calls[0][0].data.outcome).toBe('FAILED');
    });
});

describe('the retry RESOLVES an unconfirmed write instead of sealing it', () => {
    it('reconciles a prior INDETERMINATE row when the account is now disabled', async () => {
        // This path used to return before journalling, which made the ambiguity
        // permanent: every later run reproduced ALREADY_DISABLED and nothing
        // ever corrected the row. The read IS the evidence the first call never
        // got.
        db.identityWriteJournal.findFirst.mockResolvedValue({ id: 'j-old' });
        const w = fakeWriter({ readState: async () => ({ enabled: false, priorState: { accountEnabled: false } }) });

        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('ALREADY_DISABLED');
        expect(r.journalId).toBe('j-old');
        expect(db.identityWriteJournal.updateMany.mock.calls[0][0].data.outcome).toBe('APPLIED');
    });

    it('an ordinary already-disabled account stays an ordinary no-op', async () => {
        db.identityWriteJournal.findFirst.mockResolvedValue(null);
        const w = fakeWriter({ readState: async () => ({ enabled: false, priorState: {} }) });

        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('ALREADY_DISABLED');
        expect(r.journalId).toBeUndefined();
        expect(db.identityWriteJournal.create).not.toHaveBeenCalled();
    });
});

describe('a failed write is settled FAILED, with its reason', () => {
    it('records the failure against the journal row and returns it', async () => {
        const w = fakeWriter({
            disable: async () => {
                throw new DirectoryWriteError('Graph returned 403', { definitivelyNotApplied: true });
            },
        });
        const r = await disableAccount(ctx, w, input());

        expect(r.outcome).toBe('FAILED');
        expect(r.reason).toMatch(/403/);
        const settle = db.identityWriteJournal.updateMany.mock.calls[0][0];
        expect(settle.data.outcome).toBe('FAILED');
        expect(settle.data.detail).toMatch(/403/);
    });

    it('does NOT rethrow — one account failing is not the batch failing', async () => {
        const w = fakeWriter({ disable: async () => { throw new Error('boom'); } });
        await expect(disableAccount(ctx, w, input())).resolves.toMatchObject({ outcome: 'INDETERMINATE' });
    });
});

describe('a failure to READ is contained, and the directory is untouched', () => {
    /**
     * readState was previously called outside the try. A transient read failure
     * therefore propagated out of disableAccount as a throw — and the batch loop
     * did not wrap the call either, so one unreadable account abandoned every
     * remaining candidate in the pass, with no record of which ones.
     *
     * FAILED is honest here in a way it is NOT for a lost write response:
     * nothing was attempted, so the directory is genuinely unchanged.
     */
    it('returns FAILED rather than throwing', async () => {
        const w = fakeWriter({ readState: async () => { throw new Error('Graph 503'); } });
        const r = await disableAccount(ctx, w, input());
        expect(r.outcome).toBe('FAILED');
        expect(r.reason).toMatch(/could not read the account/i);
    });

    it('journals nothing — there was no write to record', async () => {
        const w = fakeWriter({ readState: async () => { throw new Error('Graph 503'); } });
        await disableAccount(ctx, w, input());
        expect(db.identityWriteJournal.create).not.toHaveBeenCalled();
    });

    it('one unreadable account does not abandon the rest of the batch', async () => {
        let n = 0;
        const w = fakeWriter({
            readState: async () => {
                if (n++ === 0) throw new Error('Graph 503');
                return { enabled: true, priorState: { accountEnabled: true } };
            },
        });
        const candidates = [input({ externalUserId: 'a' }), input({ externalUserId: 'b' })];
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });

        expect(r.results.map((x) => x.outcome)).toEqual(['FAILED', 'DISABLED']);
        expect(w.disabled).toEqual(['b']);
    });

    it('an unexpected THROW from the per-account path still continues the batch', async () => {
        // disableAccount is written to return rather than throw, but "written
        // to" is not "guaranteed to" — a provider-writer bug must not abandon
        // the remaining candidates silently.
        let n = 0;
        const w = fakeWriter({
            readState: async () => {
                if (n++ === 0) throw { weird: 'not an Error' };
                return { enabled: true, priorState: { accountEnabled: true } };
            },
        });
        const candidates = [input({ externalUserId: 'a' }), input({ externalUserId: 'b' })];
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });
        expect(r.results).toHaveLength(2);
        expect(r.results[1].outcome).toBe('DISABLED');
    });
});

describe('the batch gate', () => {
    it('refuses the WHOLE batch when the blast radius is implausible', async () => {
        // 400 of 500 is a broken feed, not a departure wave. Nothing is
        // attempted — not even the first 50.
        const w = fakeWriter();
        const candidates = Array.from({ length: 400 }, (_, i) => input({ externalUserId: `ext-${i}` }));
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });

        expect(r.refused).toMatch(/per-run/i);
        expect(r.results).toEqual([]);
        expect(w.disabled).toEqual([]);
    });

    it('a plausible batch proceeds and returns one result per candidate', async () => {
        const w = fakeWriter();
        const candidates = [input({ externalUserId: 'a' }), input({ externalUserId: 'b' })];
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });

        expect(r.refused).toBeUndefined();
        expect(r.results.map((x) => x.outcome)).toEqual(['DISABLED', 'DISABLED']);
        expect(w.disabled).toEqual(['a', 'b']);
    });

    it('one failure does not stop the rest', async () => {
        let n = 0;
        const w = fakeWriter({
            disable: async () => {
                if (n++ === 0) throw new DirectoryWriteError('first refused', { definitivelyNotApplied: true });
            },
        });
        const candidates = [input({ externalUserId: 'a' }), input({ externalUserId: 'b' })];
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });
        expect(r.results.map((x) => x.outcome)).toEqual(['FAILED', 'DISABLED']);
    });

    it('an empty batch is allowed and does nothing', async () => {
        const r = await disableAccountsForLeaver(ctx, fakeWriter(), { candidates: [], population: 500 });
        expect(r.refused).toBeUndefined();
        expect(r.results).toEqual([]);
    });

    it('enqueues the leaver notification for each disable, and sends nothing itself', async () => {
        const w = fakeWriter();
        const candidates = [input({ externalUserId: 'a' }), input({ externalUserId: 'b' })];
        await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });

        // One IT mail per disable, into the OUTBOX. The pass is holding a
        // customer's directory rate limit; it must not also be holding an SMTP
        // connection.
        expect(db.notificationOutbox.create).toHaveBeenCalledTimes(2);
        const first = db.notificationOutbox.create.mock.calls[0][0].data;
        expect(first.type).toBe('IDENTITY_LEAVER_DISABLED');
        expect(first.toEmail).toBe('it@acme.test');
    });

    it('a broken notification path does not stop the batch', async () => {
        // The account writes are the product; the mail about them is not. A
        // notification-layer failure must cost a message, never a leaver.
        db.notificationOutbox.create.mockRejectedValue(new Error('outbox is on fire'));
        const w = fakeWriter();
        const candidates = [input({ externalUserId: 'a' }), input({ externalUserId: 'b' })];
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });

        expect(r.results.map((x) => x.outcome)).toEqual(['DISABLED', 'DISABLED']);
        expect(w.disabled).toEqual(['a', 'b']);
    });

    it('an audience lookup that throws is fail-open — the batch still runs', async () => {
        db.tenantNotificationSettings.findUnique.mockRejectedValue(new Error('settings unreadable'));
        const w = fakeWriter();
        const candidates = [input({ externalUserId: 'a' })];
        const r = await disableAccountsForLeaver(ctx, w, { candidates, population: 500 });

        expect(r.results.map((x) => x.outcome)).toEqual(['DISABLED']);
        expect(db.notificationOutbox.create).not.toHaveBeenCalled();
    });
});

describe('candidate selection demands FRESH link evidence', () => {
    it('EXCLUDES links a sync has disproved', async () => {
        // Freshness alone was never a witness that a pairing is still true —
        // only a bound on how long ago it last was. The reconciler marks the
        // ones it disproved; this must respect the mark.
        await findLeaverCandidates(ctx, 'entra-id', ['e1'], new Date('2026-08-01'));
        expect(db.identityAccountLink.findMany.mock.calls[0][0].where.contradictedAt).toBeNull();
    });

    it('filters on lastVerifiedAt and the provider, bounded', async () => {
        // A pairing last confirmed months ago is evidence about a directory
        // that has since changed — acting on it is the failure the link model
        // exists to avoid.
        const stale = new Date('2026-08-01T00:00:00Z');
        await findLeaverCandidates(ctx, 'entra-id', ['e1'], stale);

        const q = db.identityAccountLink.findMany.mock.calls[0][0];
        expect(q.where.lastVerifiedAt).toEqual({ gte: stale });
        expect(q.where.connectedAccount).toEqual({ provider: 'entra-id' });
        expect(q.where.tenantId).toBe('t1');
        expect(typeof q.take).toBe('number');
    });

    it('no employees means no query at all', async () => {
        expect(await findLeaverCandidates(ctx, 'entra-id', [], new Date())).toEqual([]);
        expect(db.identityAccountLink.findMany).not.toHaveBeenCalled();
    });

    it('carries the sync flag through, so the target check can use it', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            { id: 'l1', connectedAccount: { externalUserId: 'x1', onPremisesSyncEnabled: true } },
        ]);
        const out = await findLeaverCandidates(ctx, 'entra-id', ['e1'], new Date('2026-08-01'));
        expect(out).toEqual([{ linkId: 'l1', externalUserId: 'x1', onPremisesSyncEnabled: true }]);
    });
});
