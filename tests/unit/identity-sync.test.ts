/**
 * PR-2 — identity-sync usecase: idempotent upsert + deprovision reconcile.
 * `runInTenantContext` is mocked to hand the callback a fake tenant-scoped db.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: jest.fn(() => '{}') }));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));
// Spread the real module rather than replacing it: `markAuthFailure` reaches
// for `recordConnectionAuthState` from here too, and a bare factory silently
// removes every counter this file does not think about.
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordDeprovisionRefused: jest.fn(),
}));

import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import type { NormalizedIdentityAccount } from '@/app-layer/integrations/providers/identity/types';
import { IntegrationAuthError } from '@/app-layer/integrations/http-resilience';
import { recordDeprovisionRefused } from '@/lib/observability/integration-metrics';

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    connectedIdentityAccount: { upsert: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
};

/**
 * The two COUNT queries the reconcile's blast-radius rails issue, told apart by
 * the predicate rather than by call order.
 *
 * `syncedAt` in the where-clause means "rows this pass did not touch" — the
 * numerator, what the reconcile would flip. Its absence means "rows this
 * connection still calls live" — the denominator. Dispatching on the predicate
 * rather than on the call index is the point: an assertion keyed to call order
 * would keep passing if the two queries were swapped, which is precisely the
 * numerator/denominator confusion these rails exist to catch.
 */
function countsBy(stale: number, population: number) {
    return async (args: { where?: { syncedAt?: unknown } }) =>
        args?.where?.syncedAt !== undefined ? stale : population;
}

const NOW = new Date('2026-06-01T00:00:00.000Z');

function stubProvider(accounts: NormalizedIdentityAccount[]) {
    return { listAccounts: jest.fn(async () => ({ accounts, complete: true })) };
}

function acct(id: string): NormalizedIdentityAccount {
    return { externalUserId: id, email: `${id}@acme.com`, status: 'ACTIVE', isAdmin: false, mfaEnrolled: true, ssoEnrolled: true, onPremisesSyncEnabled: null, groups: [], lastActiveAt: NOW };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true, syncCursor: null, syncPassStartedAt: null });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    mockDb.integrationExecution.update.mockResolvedValue({});
    mockDb.connectedIdentityAccount.upsert.mockResolvedValue({});
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 0 });
    // One connection for this provider — the shape every tenant in the field
    // has, and the one where the reconcile may still sweep rows that carry no
    // connectionId. Tests that care about the two-connection case override it.
    mockDb.integrationConnection.count.mockResolvedValue(1);
    mockDb.connectedIdentityAccount.updateMany.mockResolvedValue({ count: 3 });
    // 3 of 100 = 3%, under the share cap, so the default fixture reconciles.
    mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(3, 100));
});

describe('runIdentitySync', () => {
    it('upserts each account idempotently by (tenantId, connectionId, externalUserId)', async () => {
        const provider = stubProvider([acct('a'), acct('b')]);
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(2);
        expect(mockDb.connectedIdentityAccount.upsert).toHaveBeenCalledTimes(2);
        const where = mockDb.connectedIdentityAccount.upsert.mock.calls[0][0].where;
        // Keyed on the CONNECTION as of phase 2. The old
        // tenantId_provider_externalUserId key made two forests under one tenant
        // collide on a single row, which is what forced the reconcile to be
        // provider-scoped and produced the nightly cross-deprovision.
        expect(where.tenantId_connectionId_externalUserId).toEqual({
            tenantId: 't1',
            connectionId: 'conn-1',
            externalUserId: 'a',
        });
        expect(where.tenantId_provider_externalUserId).toBeUndefined();
        // execution finalized PASSED
        expect(mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data.status).toBe('PASSED');
    });

    it('scopes the deprovision reconcile to the CONNECTION, not the provider', async () => {
        // THE BUG THIS CLOSES. IntegrationConnection is unique on
        // (tenantId, provider, NAME), so two AD forests or two Entra tenants
        // under one customer are a supported configuration. The reconcile used
        // to match on `provider`, so connection A's pass swept everything for
        // that provider it had not itself touched — which is all of connection
        // B — and B's pass then did the reverse. Both reported PASSED. It ran on
        // the READ path: no write permission, no consent, no bind.
        mockDb.integrationConnection.count.mockResolvedValue(2);
        const provider = stubProvider([acct('a')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const where = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0].where;
        expect(where.connectionId).toBe('conn-1');
        // And NOT widened back to "or anything unattributed" — in a
        // two-connection tenant an unattributed row may belong to the other one,
        // which is the original bug in a new spelling.
        expect(where.OR).toBeUndefined();
    });

    it('no longer widens to unattributed rows — there are none to widen to', async () => {
        // REVERSED DELIBERATELY IN PHASE 2, and the reversal is the point.
        //
        // Phase 1 had to include NULL-connectionId rows when the tenant held one
        // connection: the column was nullable, and excluding them would have
        // silently stopped deprovisioning every row written before it existed —
        // with the deprovisioned count reporting 0, which reads exactly like a
        // healthy directory.
        //
        // The column is NOT NULL now, so `connectionId: null` matches nothing and
        // the widening has nothing left to widen to. The extra COUNT query that
        // decided whether to widen is gone with it.
        const provider = stubProvider([acct('a')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const where = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0].where;
        expect(where.connectionId).toBe('conn-1');
        expect(where.OR).toBeUndefined();
        // And the count query that drove the old decision is no longer issued —
        // asserted positively so "we removed it" is checked, not assumed.
        expect(mockDb.integrationConnection.count).not.toHaveBeenCalled();
    });

    it('claims the connection on every pass, not only when the row is created', async () => {
        // An account row that predates the column, or whose connection was
        // deleted, is adopted by whichever connection can still see it — the
        // only evidence available about where it lives. Setting it on `create`
        // alone would freeze attribution at whatever ran first and leave the
        // legacy rows unattributed forever.
        const provider = stubProvider([acct('a')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const call = mockDb.connectedIdentityAccount.upsert.mock.calls[0][0];
        expect(call.create.connectionId).toBe('conn-1');
        expect(call.update.connectionId).toBe('conn-1');
    });

    it('never writes an operator protection field — the omission is the feature', async () => {
        // THE SINGLE MOST IMPORTANT LINE IN THIS FEATURE, per the schema's own
        // comment beside `isProtected`, and until now nothing tested it: this
        // file had zero occurrences of the word. `isProtected`, `protectedAt`,
        // `protectedByUserId` and `protectionReason` are OPERATOR state — the
        // directory has no opinion about them — so a nightly sync that
        // expressed one would clear a break-glass flag every night and the
        // failure would stay invisible until the one pass that should have
        // refused a disable doesn't.
        //
        // Asserted as an ABSENCE on the update arm because that is exactly how
        // the guarantee is spelled in the source: Prisma's field lists are
        // explicit, not a spread, so the protection columns are opted OUT by
        // not being named. Nothing about that survives a well-meaning edit
        // except a test that reads the object and finds them missing. All four,
        // not just the flag — the three companions are what a later reader uses
        // to tell a break-glass credential from somebody's mistake.
        const provider = stubProvider([acct('a')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const call = mockDb.connectedIdentityAccount.upsert.mock.calls[0][0];
        expect(call.update).not.toHaveProperty('isProtected');
        expect(call.update).not.toHaveProperty('protectedAt');
        expect(call.update).not.toHaveProperty('protectedByUserId');
        expect(call.update).not.toHaveProperty('protectionReason');
        // The create arm carries none of them either — a new row takes the
        // column default (false) rather than being told what it is by a sync.
        expect(call.create).not.toHaveProperty('isProtected');
        // Positive control: this IS the upsert those assertions are about, so
        // an empty or renamed object cannot satisfy the four negatives above.
        expect(call.update.connectionId).toBe('conn-1');
    });

    it('writes the observation stamp as a PAIR with the value, on BOTH arms', async () => {
        // `onPremStateObservedAt` is the only thing separating "the directory
        // answered null" from "nobody asked", and the write-target rail acts on
        // that difference. Both arms matter and neither fails loudly if dropped:
        // Prisma's explicit field lists mean an omission here is silent, and the
        // one in `update` is the nastier half — it would leave a STALE stamp
        // beside a freshly-refreshed value, which is exactly the lie the rail
        // would then act on.
        const provider = stubProvider([{ ...acct('a'), onPremStateObserved: true }]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const call = mockDb.connectedIdentityAccount.upsert.mock.calls[0][0];
        expect(call.create.onPremStateObservedAt).toEqual(NOW);
        expect(call.update.onPremStateObservedAt).toEqual(NOW);
    });

    it('CLEARS the stamp when the provider did not answer, rather than leaving it stale', async () => {
        // The failure this prevents: a provider stops answering (a $select is
        // trimmed, a permission is lost), the value goes null-because-unasked,
        // and a surviving stamp from an earlier pass tells the rail the null was
        // observed. It would then allow a disable on an observation nobody made.
        const provider = stubProvider([acct('a')]); // no onPremStateObserved
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const call = mockDb.connectedIdentityAccount.upsert.mock.calls[0][0];
        expect(call.create.onPremStateObservedAt).toBeNull();
        expect(call.update.onPremStateObservedAt).toBeNull();
    });

    it('H3 — a PARTIAL (truncated) enumeration does NOT deprovision and marks ERROR', async () => {
        // Directory larger than the cap: complete=false. Accounts past the cap
        // weren't observed, so deprovisioning "everything not seen" would be
        // catastrophic — it must be skipped and the run failed.
        const provider = { listAccounts: jest.fn(async () => ({ accounts: [acct('a')], complete: false })) };
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('ERROR');
        expect(r.deprovisioned).toBe(0);
        // The load-bearing assertion: NO deprovision reconcile ran.
        expect(mockDb.connectedIdentityAccount.updateMany).not.toHaveBeenCalled();
        // But the accounts we DID see were still upserted (additive, safe).
        expect(mockDb.connectedIdentityAccount.upsert).toHaveBeenCalledTimes(1);
    });

    it('reconciles vanished accounts to DEPROVISIONED (by pass timestamp)', async () => {
        // The predicate changed with H3-2, from `externalUserId notIn <this
        // run's seen set>` to `syncedAt < <when the pass began>`. The invariant
        // is the same — accounts no longer in the directory get deprovisioned —
        // but the old form was correct only while a pass was a single run.
        const provider = stubProvider([acct('a')]);
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(mockDb.connectedIdentityAccount.updateMany).toHaveBeenCalledTimes(1);
        const call = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0];
        expect(call.where.syncedAt).toEqual({ lt: NOW });
        expect(call.where.status).toEqual({ not: 'DEPROVISIONED' });
        expect(call.data.status).toBe('DEPROVISIONED');
        expect(r.deprovisioned).toBe(3);
    });

    it('running twice with the same directory is idempotent (same upsert keys)', async () => {
        const provider = stubProvider([acct('a'), acct('b')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        const firstKeys = mockDb.connectedIdentityAccount.upsert.mock.calls.map((c) => c[0].where.tenantId_connectionId_externalUserId.externalUserId);
        jest.clearAllMocks();
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true, syncCursor: null, syncPassStartedAt: null });
        mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-2' });
        mockDb.connectedIdentityAccount.updateMany.mockResolvedValue({ count: 0 });
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        const secondKeys = mockDb.connectedIdentityAccount.upsert.mock.calls.map((c) => c[0].where.tenantId_connectionId_externalUserId.externalUserId);
        expect(secondKeys).toEqual(firstKeys);
    });

    it('errors cleanly when the connection is not an identity provider', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'github', configJson: {}, secretEncrypted: null, isEnabled: true, syncCursor: null, syncPassStartedAt: null });
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]) });
        expect(r.status).toBe('ERROR');
        expect(mockDb.connectedIdentityAccount.upsert).not.toHaveBeenCalled();
    });

    it('records ERROR (not a throw) when listAccounts fails', async () => {
        const provider = { listAccounts: jest.fn(async () => { throw new Error('rate limited'); }) };
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('rate limited');
        expect(mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data.status).toBe('ERROR');
    });
});

// ── H1-3: credential health on the connection ────────────────────────────
// Recording an auth failure only on IntegrationExecution left a dead
// connection presenting as healthy until someone opened the execution history
// of a job nobody watches.

describe('runIdentitySync — credential health', () => {
    const authFail = () => ({
        listAccounts: jest.fn(async () => {
            throw new IntegrationAuthError(401, 'https://acme.okta.com/api/v1/users');
        }),
    });

    it('marks the connection when the credential is rejected', async () => {
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: authFail() });

        expect(r.status).toBe('ERROR');
        const call = mockDb.integrationConnection.updateMany.mock.calls.at(-1)?.[0];
        expect(call.where).toEqual({ id: 'conn-1' });
        expect(call.data.authFailedAt).toBe(NOW);
        expect(String(call.data.authFailureReason)).toContain('401');
    });

    it('tells the queue not to retry a revoked credential', async () => {
        // The usecase CATCHES the provider error, so without this the
        // classification dies here and BullMQ retries three times in ~35s.
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: authFail() });
        expect(r.noRetry).toBe(true);
    });

    it('does NOT mark the connection for a non-auth failure', async () => {
        // A throttle or a network blip must not put a "credential revoked"
        // banner in front of an admin whose credential is fine.
        const provider = { listAccounts: jest.fn(async () => { throw new Error('socket hang up'); }) };
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('ERROR');
        expect(r.noRetry).toBe(false);
        const marked = mockDb.integrationConnection.updateMany.mock.calls
            .some((c) => c[0].data.authFailedAt instanceof Date);
        expect(marked).toBe(false);
    });

    it('CLEARS a stale failure on the next successful sync', async () => {
        // The load-bearing half. A banner that survives the admin fixing the
        // credential trains people to ignore the one signal that matters.
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([acct('a')]) });

        expect(r.status).toBe('PASSED');
        const call = mockDb.integrationConnection.updateMany.mock.calls.at(-1)?.[0];
        expect(call.where).toEqual({ id: 'conn-1', authFailedAt: { not: null } });
        expect(call.data).toEqual({ authFailedAt: null, authFailureReason: null });
    });

    it('a truncated enumeration fails loudly but is not retried', async () => {
        // The cap is deterministic — retrying re-enumerates the same too-large
        // directory and truncates at the same point.
        const provider = { listAccounts: jest.fn(async () => ({ accounts: [acct('a')], complete: false })) };
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('ERROR');
        expect(r.noRetry).toBe(true);
        // Not a credential problem, so the connection must stay unmarked.
        const marked = mockDb.integrationConnection.updateMany.mock.calls
            .some((c) => c[0].data.authFailedAt instanceof Date);
        expect(marked).toBe(false);
    });
});

// ── H3-2: resuming a directory larger than MAX_USERS ─────────────────────
// A directory over the cap could never finish: every run started at page one
// and stopped in exactly the same place, so accounts past the cap were never
// synced and the reconcile was skipped forever.
//
// The dangerous part of the fix is the reconcile. Under resume, this run's
// `seen` set holds only the LAST slice of the directory — so the old
// `externalUserId notIn seen` predicate would have deprovisioned every account
// from every earlier run of the same pass. That is the wrongful-mass-
// deprovision failure this area exists to prevent, and it would have been
// introduced BY the resume feature.

describe('runIdentitySync — resumable enumeration', () => {
    const partial = (accounts: string[], resumeToken: string | null) => ({
        listAccounts: jest.fn(async () => ({
            accounts: accounts.map(acct),
            complete: false,
            resumeToken,
        })),
    });

    it('stores the cursor and reports PARTIAL rather than ERROR', async () => {
        // Progress, not failure. Reporting ERROR would page someone every night
        // for a large directory that is working exactly as designed.
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW,
            provider: partial(['a'], 'https://acme.okta.com/api/v1/users?after=xyz'),
        });

        expect(r.status).toBe('PARTIAL');

        // AND THE PERSISTED ROW SAYS SO TOO.
        //
        // This assertion is the one that was missing, and its absence is why
        // the defect survived: the RETURN was always 'PARTIAL' — the job reads
        // it and correctly skips the reconcile — while the row written for the
        // operator said 'PASSED'. A green badge, zero links, and nothing on the
        // connection page distinguishing it from a complete sync. Asserting
        // only `r.status` checks the half that was already right.
        const persisted = mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data;
        expect(persisted.status).toBe('PARTIAL');
        // Not an error: a resumable partial continues next pass, so the row
        // must not carry an errorMessage that would read as a failure.
        expect(persisted.errorMessage).toBeNull();
        expect(persisted.resultJson).toMatchObject({ partial: true, resuming: true });

        const stored = mockDb.integrationConnection.updateMany.mock.calls
            .map((c) => c[0].data)
            .find((d) => typeof d.syncCursor === 'string');
        expect(stored.syncCursor).toBe('https://acme.okta.com/api/v1/users?after=xyz');
        expect(stored.syncPassStartedAt).toBe(NOW);
        // Still no reconcile — the directory is only partly observed.
        expect(mockDb.connectedIdentityAccount.updateMany).not.toHaveBeenCalled();
    });

    it('passes the stored cursor back to the provider on the next run', async () => {
        // Without this the resume does nothing at all: the run restarts at page
        // one and truncates in exactly the same place, forever.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true,
            syncCursor: 'CURSOR_FROM_LAST_RUN', syncPassStartedAt: new Date('2026-05-30T00:00:00Z'),
        });
        const provider = partial(['b'], 'NEXT_CURSOR');

        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(provider.listAccounts).toHaveBeenCalledWith(expect.anything(), 'CURSOR_FROM_LAST_RUN');
    });

    it('keeps the ORIGINAL pass timestamp across runs', async () => {
        // The reconcile compares against this. If a resumed run reset it to
        // `now`, the completing run would deprovision every account synced by
        // the earlier runs of its own pass.
        const passStart = new Date('2026-05-30T00:00:00Z');
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true,
            syncCursor: 'C1', syncPassStartedAt: passStart,
        });

        await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: partial(['b'], 'C2'),
        });

        const stored = mockDb.integrationConnection.updateMany.mock.calls
            .map((c) => c[0].data)
            .find((d) => typeof d.syncCursor === 'string');
        expect(stored.syncPassStartedAt).toBe(passStart);
    });

    it('on the FINAL run, reconciles against the pass start and clears the cursor', async () => {
        // The whole point. Accounts synced by earlier runs of this pass have
        // `syncedAt >= passStart` and must survive; only accounts untouched
        // since the pass began are genuinely gone.
        const passStart = new Date('2026-05-30T00:00:00Z');
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true,
            syncCursor: 'LAST_PAGE', syncPassStartedAt: passStart,
        });

        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([acct('z')]),
        });

        expect(r.status).toBe('PASSED');
        const rec = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0];
        // Against the PASS start — NOT `now`, and NOT this run's seen set.
        expect(rec.where.syncedAt).toEqual({ lt: passStart });
        expect(rec.where.externalUserId).toBeUndefined();

        const cleared = mockDb.integrationConnection.updateMany.mock.calls
            .map((c) => c[0].data)
            .find((d) => d.syncCursor === null);
        expect(cleared).toEqual({ syncCursor: null, syncPassStartedAt: null });
    });

    it('a provider that CANNOT resume keeps the old loud behaviour', async () => {
        // Active Directory: ldapjs paged search uses a server-side cookie tied
        // to the live connection, so it cannot survive a process boundary.
        // Silently treating that as "resuming" would store a null cursor and
        // report success for a sync that will truncate identically forever.
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: partial(['a'], null),
        });

        expect(r.status).toBe('ERROR');
        expect(r.noRetry).toBe(true);
        expect(mockDb.connectedIdentityAccount.updateMany).not.toHaveBeenCalled();
    });
});

// ── The deprovision reconcile has a FLOOR and a CEILING ──────────────────
//
// `complete` says the provider finished its traversal. It says nothing about
// what the traversal SAW, and the reconcile is a sweep over everything the pass
// did not touch. For Active Directory `complete` was `searchEntries.length <
// 5000`, so a baseDN typo / an OU ACL change / a bind account scoped down
// returned zero entries, `0 < 5000` evaluated to complete, and the whole forest
// was marked DEPROVISIONED with the run recorded PASSED.
//
// Two rails, deliberately covering different cases, and each has its own test
// below WITH THE OTHER RULED OUT BY CONSTRUCTION — a fixture that trips both
// would pass with either one deleted and so could not tell you which is
// load-bearing:
//
//   • the FLOOR      — nothing was ingested. Tested at a proposed count BELOW
//                      `DEPROVISION_SHARE_FLOOR`, where the share rule is
//                      silent by definition.
//   • the SHARE CAP  — too large a slice of the connection. Tested with a
//                      non-empty ingest, where the floor cannot fire.

describe('runIdentitySync — deprovision floor', () => {
    it('a complete-but-EMPTY enumeration does not deprovision, and does not report PASSED', async () => {
        // THE DEFECT, end to end. Four accounts on record, an enumeration that
        // returns nothing, `complete: true`. Four is BELOW the share-rule floor
        // of 5, so the share cap is silent here and this test can only be
        // satisfied by the zero-enumeration guard.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(4, 4));
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        // Not one row flipped.
        expect(mockDb.connectedIdentityAccount.updateMany).not.toHaveBeenCalled();
        expect(r.deprovisioned).toBe(0);

        // And the run does not claim to be clean — in the RETURN and on the ROW.
        // Asserting only the return would check the half a caller sees; the row
        // is the operator's only durable record, and a green badge over a
        // withheld reconcile is the failure this half exists to prevent.
        expect(r.status).toBe('PARTIAL');
        const persisted = mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data;
        expect(persisted.status).toBe('PARTIAL');
        expect(persisted.errorMessage).toContain('ingested none');
        expect(persisted.resultJson).toMatchObject({ deprovisionRefused: 'zero_enumeration', deprovisionProposed: 4 });
    });

    it('measures what was INGESTED, not what the provider handed back', async () => {
        // The provider answered with three entries and not one of them could be
        // keyed, so the upsert loop wrote nothing. `accounts.length` is 3 and
        // the number that matters is 0 — the same two-collections confusion the
        // AD provider's `complete` flag had, arriving through the other door.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(4, 4));
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW,
            provider: stubProvider([acct(''), acct(''), acct('')]),
        });

        expect(mockDb.connectedIdentityAccount.upsert).not.toHaveBeenCalled();
        expect(mockDb.connectedIdentityAccount.updateMany).not.toHaveBeenCalled();
        expect(r.status).toBe('PARTIAL');
    });

    it('still reconciles when an EARLIER run of the same pass saw accounts', async () => {
        // The counter-case, and the reason the guard is not simply "refuse on
        // empty". Under resume the last run of a pass reads an empty final page
        // whenever the directory size is an exact multiple of the page cap: the
        // provider is answering, the pass already ingested rows, and refusing
        // here would mean a tenant of that exact size never reconciles again.
        // `hris-sync` learned this one the hard way; this follows its shape.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true,
            syncCursor: 'LAST_PAGE', syncPassStartedAt: new Date('2026-05-30T00:00:00Z'),
        });
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(4, 4));
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        expect(mockDb.connectedIdentityAccount.updateMany).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
    });

    it('clears the pass marker on a refusal, so the NEXT empty run is refused too', async () => {
        // Load-bearing, and the opposite of what "hold the pass open" intuition
        // suggests. `passSawAccounts` ORs in `syncPassStartedAt`, so a marker
        // left behind by a refused pass would read on the next run as "an
        // earlier run of this pass saw rows" — and the second zero-entry
        // enumeration in a row would sweep the connection the first refusal
        // saved. The enumeration finished; there is no page to resume.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(4, 4));
        await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        const cleared = mockDb.integrationConnection.updateMany.mock.calls
            .map((c) => c[0].data)
            .find((d) => d.syncCursor === null);
        expect(cleared).toEqual({ syncCursor: null, syncPassStartedAt: null });
    });

    it('counts a REFUSAL, which the deprovisioned counter structurally cannot', async () => {
        // `recordIdentityDeprovisioned` early-returns on `count <= 0`, so the
        // held sweep — zero by definition — emitted nothing while an executed
        // sweep emitted a number. The event with the larger blast radius was
        // the silent one.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(4, 4));
        await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([]),
        });

        expect(recordDeprovisionRefused).toHaveBeenCalledWith({ provider: 'okta', reason: 'zero_enumeration' });
    });
});

describe('runIdentitySync — deprovision share cap', () => {
    it('refuses a sweep over a tenth of what the connection calls live', async () => {
        // 30 of 100. The enumeration was non-empty, so the floor is satisfied
        // and cannot be what refuses this — only the share cap can. This is the
        // partial-scoping failure the floor cannot see: the bind still reaches
        // most of the forest, so accounts keep arriving while a whole OU does
        // not.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(30, 100));
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([acct('a')]),
        });

        expect(mockDb.connectedIdentityAccount.updateMany).not.toHaveBeenCalled();
        expect(r.status).toBe('PARTIAL');
        expect(r.deprovisioned).toBe(0);
        const persisted = mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data;
        expect(persisted.status).toBe('PARTIAL');
        expect(persisted.errorMessage).toContain('30.0%');
        expect(persisted.resultJson).toMatchObject({ deprovisionRefused: 'share_cap', deprovisionProposed: 30 });
        expect(recordDeprovisionRefused).toHaveBeenCalledWith({ provider: 'okta', reason: 'share_cap' });
    });

    it('lets ordinary churn through — 6 of 100 is not an anomaly', async () => {
        // The positive control the refusal tests need. 6 is above the floor, so
        // the share rule is live and evaluating; 6% is under the cap. A rail
        // that refused this would be a rail operators switch off.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(6, 100));
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([acct('a')]),
        });

        expect(mockDb.connectedIdentityAccount.updateMany).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
        expect(mockDb.integrationExecution.update.mock.calls.at(-1)?.[0].data.errorMessage).toBeNull();
    });

    it('does not refuse a small connection where two departures are half the roster', async () => {
        // 2 of 4 is 50% and would trip a bare percentage rule every time
        // somebody leaves. `DEPROVISION_SHARE_FLOOR` is what keeps the share
        // rule silent at the bottom end — and the zero-enumeration floor is
        // what still covers this connection when the enumeration comes back
        // empty, which is the case that actually endangers it.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(2, 4));
        const r = await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([acct('a'), acct('b')]),
        });

        expect(mockDb.connectedIdentityAccount.updateMany).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
    });

    it('judges the reconcile with the reconcile’s own predicate', async () => {
        // The numerator and the write must describe the same set. Measuring one
        // and writing the other is how a rail ends up authorising a batch it
        // never looked at (#2498, in the leaver path). Asserted as object
        // identity of the where-clause rather than field-by-field, because a
        // field-by-field copy is exactly what drifts.
        mockDb.connectedIdentityAccount.count.mockImplementation(countsBy(3, 100));
        await runIdentitySync({
            tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider([acct('a')]),
        });

        const counted = mockDb.connectedIdentityAccount.count.mock.calls[0][0].where;
        const written = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0].where;
        expect(written).toBe(counted);
        // Positive control — `toBe` on two undefineds would also pass.
        expect(written.syncedAt).toEqual({ lt: NOW });
    });
});
