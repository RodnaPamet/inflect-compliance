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
    integrationConnection: { findFirst: jest.fn(), updateMany: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    connectedIdentityAccount: { upsert: jest.fn(), updateMany: jest.fn() },
};

const NOW = new Date('2026-06-01T00:00:00.000Z');

function stubProvider(accounts: NormalizedIdentityAccount[]) {
    return { listAccounts: jest.fn(async () => ({ accounts, complete: true })) };
}

function acct(id: string): NormalizedIdentityAccount {
    return { externalUserId: id, email: `${id}@acme.com`, status: 'ACTIVE', isAdmin: false, mfaEnrolled: true, ssoEnrolled: true, groups: [], lastActiveAt: NOW };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    mockDb.integrationExecution.update.mockResolvedValue({});
    mockDb.connectedIdentityAccount.upsert.mockResolvedValue({});
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 0 });
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

    it('reconciles vanished accounts to DEPROVISIONED (excludes the seen set)', async () => {
        const provider = stubProvider([acct('a')]);
        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(mockDb.connectedIdentityAccount.updateMany).toHaveBeenCalledTimes(1);
        const call = mockDb.connectedIdentityAccount.updateMany.mock.calls[0][0];
        expect(call.where.externalUserId).toEqual({ notIn: ['a'] });
        expect(call.data.status).toBe('DEPROVISIONED');
        expect(r.deprovisioned).toBe(3);
    });

    it('running twice with the same directory is idempotent (same upsert keys)', async () => {
        const provider = stubProvider([acct('a'), acct('b')]);
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        const firstKeys = mockDb.connectedIdentityAccount.upsert.mock.calls.map((c) => c[0].where.tenantId_provider_externalUserId.externalUserId);
        jest.clearAllMocks();
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true });
        mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-2' });
        mockDb.connectedIdentityAccount.updateMany.mockResolvedValue({ count: 0 });
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        const secondKeys = mockDb.connectedIdentityAccount.upsert.mock.calls.map((c) => c[0].where.tenantId_provider_externalUserId.externalUserId);
        expect(secondKeys).toEqual(firstKeys);
    });

    it('errors cleanly when the connection is not an identity provider', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'github', configJson: {}, secretEncrypted: null, isEnabled: true });
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
