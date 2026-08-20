/**
 * The link reconciler runs after a sync, and ONLY after a complete one.
 *
 * `reconcileIdentityAccountLinks` is the only writer of
 * `IdentityAccountLink.lastVerifiedAt`, and `findLeaverCandidates` requires that
 * column to be fresh. So an unhooked reconciler means an empty candidate set:
 * a leaver pass that runs, reports success, and disables nobody. These tests
 * lock the hook, and — more importantly — lock the gate in front of it.
 */
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})),
}));
jest.mock('@/app-layer/integrations/connection-lock', () => ({
    acquireSyncLock: jest.fn(async () => 'lock-token'),
    releaseSyncLock: jest.fn(async () => undefined),
}));
jest.mock('@/app-layer/usecases/identity-sync', () => ({
    runIdentitySync: jest.fn(),
}));
jest.mock('@/app-layer/usecases/identity-account-link', () => ({
    reconcileIdentityAccountLinks: jest.fn(),
}));
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordIdentityLinkReconcile: jest.fn(),
}));

import { runIdentitySyncJob } from '@/app-layer/jobs/identity-sync';
import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import { reconcileIdentityAccountLinks } from '@/app-layer/usecases/identity-account-link';
import { recordIdentityLinkReconcile } from '@/lib/observability/integration-metrics';
import { acquireSyncLock } from '@/app-layer/integrations/connection-lock';

const synced = runIdentitySync as jest.Mock;
const reconciled = reconcileIdentityAccountLinks as jest.Mock;
const metric = recordIdentityLinkReconcile as jest.Mock;
const acquire = acquireSyncLock as jest.Mock;

const PAYLOAD = { tenantId: 't1', connectionId: 'conn-1' };

function syncResult(over: Record<string, unknown> = {}) {
    return {
        executionId: 'exec-1',
        status: 'PASSED',
        upserted: 12,
        deprovisioned: 0,
        provider: 'entra-id',
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    acquire.mockResolvedValue('lock-token');
    synced.mockResolvedValue(syncResult());
    reconciled.mockResolvedValue({ created: 3, verified: 40, unmatched: 2, unresolved: [], contradicted: 1 });
});

describe('the reconciler is hooked at all', () => {
    it('reconciles after a confirmed-complete sync, for that sync’s provider', async () => {
        await runIdentitySyncJob(PAYLOAD);

        expect(reconciled).toHaveBeenCalledTimes(1);
        // The provider comes off the sync result rather than a second read of
        // the connection — the string was already in scope.
        expect(reconciled.mock.calls[0][1]).toBe('entra-id');
    });

    it('returns the sync result unchanged — the hook is not in the return path', async () => {
        const r = await runIdentitySyncJob(PAYLOAD);
        expect(r).toEqual(syncResult());
    });
});

describe('the completeness gate in front of it', () => {
    // Matching is by email against the accounts on record. An account absent
    // from a TRUNCATED slice is indistinguishable from one that no longer
    // exists — so reconciling a partial pass stamps freshness on links nobody
    // observed and contradicts others on a read that never finished. The
    // freshness rail would then be certifying a fact nobody checked.
    it.each([
        ['PARTIAL', 'a resumable page-by-page run'],
        ['ERROR', 'a directory past the enumeration cap'],
    ])('does NOT reconcile after %s — %s', async (status) => {
        synced.mockResolvedValue(syncResult({ status }));

        await runIdentitySyncJob(PAYLOAD);

        expect(reconciled).not.toHaveBeenCalled();
        expect(metric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'skipped' });
    });

    it('does NOT reconcile when another run holds the lock', async () => {
        acquire.mockResolvedValue(null);

        const r = await runIdentitySyncJob(PAYLOAD);

        expect(r.status).toBe('SKIPPED');
        expect(synced).not.toHaveBeenCalled();
        expect(reconciled).not.toHaveBeenCalled();
    });

    it('does NOT reconcile when the connection never resolved, and emits nothing', async () => {
        // No provider on the result means there was no enumeration to
        // reconcile against — not a skip worth counting.
        synced.mockResolvedValue(syncResult({ status: 'ERROR', provider: undefined }));

        await runIdentitySyncJob(PAYLOAD);

        expect(reconciled).not.toHaveBeenCalled();
        expect(metric).not.toHaveBeenCalled();
    });
});

describe('a reconcile failure does not become a sync failure', () => {
    it('still returns PASSED when the reconciler throws', async () => {
        reconciled.mockRejectedValue(new Error('link table is on fire'));

        // The sync genuinely succeeded — accounts were upserted. Reporting
        // ERROR would make the queue retry a full directory enumeration to fix
        // a link table.
        const r = await runIdentitySyncJob(PAYLOAD);

        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(12);
    });

    it('counts the failure, because nothing downstream reports a stopped reconciler', async () => {
        reconciled.mockRejectedValue(new Error('link table is on fire'));

        await runIdentitySyncJob(PAYLOAD);

        expect(metric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'error' });
    });

    it('does not swallow the throw silently — the lock is still released', async () => {
        reconciled.mockRejectedValue(new Error('link table is on fire'));
        const { releaseSyncLock } = jest.requireMock('@/app-layer/integrations/connection-lock');

        await runIdentitySyncJob(PAYLOAD);

        expect(releaseSyncLock).toHaveBeenCalled();
    });
});

describe('the success path is observable', () => {
    it('counts a reconciled pass, so "it stopped running" is a rate change not a silence', async () => {
        await runIdentitySyncJob(PAYLOAD);
        expect(metric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'reconciled' });
    });
});
