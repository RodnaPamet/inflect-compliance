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

import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import type { NormalizedIdentityAccount } from '@/app-layer/integrations/providers/identity/types';
import { IntegrationAuthError } from '@/app-layer/integrations/http-resilience';

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    connectedIdentityAccount: { upsert: jest.fn(), updateMany: jest.fn() },
};

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
});

describe('runIdentitySync', () => {
    it('upserts each account idempotently by (tenantId, provider, externalUserId)', async () => {
        const provider = stubProvider([acct('a'), acct('b')]);
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(2);
        expect(mockDb.connectedIdentityAccount.upsert).toHaveBeenCalledTimes(2);
        const where = mockDb.connectedIdentityAccount.upsert.mock.calls[0][0].where;
        expect(where.tenantId_provider_externalUserId).toEqual({ tenantId: 't1', provider: 'okta', externalUserId: 'a' });
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

    it('still sweeps rows that predate the column — but only where one connection exists', async () => {
        // The other half. Scoping strictly to connectionId would silently stop
        // deprovisioning every row written before the column existed, and the
        // silence is the dangerous part: the deprovisioned count would report 0,
        // which reads exactly like a healthy directory. With a single connection
        // there is no other connection those rows could belong to, so including
        // them is safe and preserves today's behaviour for every tenant in the
        // field.
        mockDb.integrationConnection.count.mockResolvedValue(1);
        const provider = stubProvider([acct('a')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        const where = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([{ connectionId: 'conn-1' }, { connectionId: null }]);
        expect(where.connectionId).toBeUndefined();
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
        const firstKeys = mockDb.connectedIdentityAccount.upsert.mock.calls.map((c) => c[0].where.tenantId_provider_externalUserId.externalUserId);
        jest.clearAllMocks();
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true, syncCursor: null, syncPassStartedAt: null });
        mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-2' });
        mockDb.connectedIdentityAccount.updateMany.mockResolvedValue({ count: 0 });
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        const secondKeys = mockDb.connectedIdentityAccount.upsert.mock.calls.map((c) => c[0].where.tenantId_provider_externalUserId.externalUserId);
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
