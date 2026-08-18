/**
 * The hris-sync JOB holds the per-connection lock.
 *
 * Driven at the JOB layer, deliberately. `acquireSyncLock` is called in
 * `jobs/hris-sync.ts`, NOT inside `runHrisSync` — so a test that drove the
 * usecase would bypass the lock entirely and every assertion would be vacuous.
 * The stress suite's own docblock flags that seam as easy to get wrong from
 * reading the usecase alone; it was got wrong here for longer, because HRIS
 * never took the lock at all while identity-sync and sharepoint-delta-sync did.
 *
 * WHAT IT PREVENTS is not wasted work. Two overlapping runs of one connection
 * share `syncCursor` and `syncPassStartedAt`. If one completes the pass it
 * clears both and runs the departure reconcile against its own passStartedAt,
 * terminating every employee whose syncedAt predates it — including the ones
 * the other run has not reached yet, which it then upserts back to ACTIVE.
 * Employees visibly flip to TERMINATED and back.
 */
const acquireSyncLock = jest.fn();
const releaseSyncLock = jest.fn();
const runHrisSync = jest.fn();

jest.mock('@/app-layer/integrations/connection-lock', () => ({
    acquireSyncLock: (...a: unknown[]) => acquireSyncLock(...a),
    releaseSyncLock: (...a: unknown[]) => releaseSyncLock(...a),
}));
jest.mock('@/app-layer/usecases/hris-sync', () => ({
    runHrisSync: (...a: unknown[]) => runHrisSync(...a),
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

import { runHrisSyncJob } from '@/app-layer/jobs/hris-sync';

const PAYLOAD = { tenantId: 't1', connectionId: 'conn-1' };

beforeEach(() => {
    jest.clearAllMocks();
    acquireSyncLock.mockResolvedValue('token-1');
    releaseSyncLock.mockResolvedValue(undefined);
    runHrisSync.mockResolvedValue({ executionId: 'e1', status: 'PASSED', upserted: 3, managersLinked: 1 });
});

describe('the lock is taken before the sync runs', () => {
    it('acquires for the connection, then syncs, then releases with the same token', async () => {
        const r = await runHrisSyncJob(PAYLOAD);
        expect(acquireSyncLock).toHaveBeenCalledWith(expect.anything(), 'conn-1');
        expect(runHrisSync).toHaveBeenCalledWith({ tenantId: 't1', connectionId: 'conn-1' });
        expect(releaseSyncLock).toHaveBeenCalledWith(expect.anything(), 'conn-1', 'token-1');
        expect(r.status).toBe('PASSED');
    });

    it('a contended connection SKIPS without syncing', async () => {
        acquireSyncLock.mockResolvedValue(null);
        const r = await runHrisSyncJob(PAYLOAD);
        expect(r.status).toBe('SKIPPED');
        // The assertion that matters — not "returns a status" but "did not run".
        expect(runHrisSync).not.toHaveBeenCalled();
    });

    it('SKIPPED is not PASSED — a contended connection must not read as synced', async () => {
        // Same reason PARTIAL is not PASSED: nothing was reconciled, and a
        // green status here makes a contended connection indistinguishable
        // from a synced one in exactly the logs someone reads to ask why an
        // employee still shows as active.
        acquireSyncLock.mockResolvedValue(null);
        const r = await runHrisSyncJob(PAYLOAD);
        expect(r.status).not.toBe('PASSED');
        expect(r.upserted).toBe(0);
    });

    it('does not release a lock it never acquired', async () => {
        // Releasing on the skip path would hand the lock away from the run
        // that legitimately holds it — turning one overlap into unbounded
        // overlap, which is worse than having no lock.
        acquireSyncLock.mockResolvedValue(null);
        await runHrisSyncJob(PAYLOAD);
        expect(releaseSyncLock).not.toHaveBeenCalled();
    });
});

describe('the lock is released on every exit', () => {
    it('releases when the sync THROWS, rather than wedging the connection', async () => {
        // Without `finally` the connection stays locked until the lease
        // expires, so one crash silently suspends that tenant's roster sync
        // for the whole TTL and nothing reports it.
        runHrisSync.mockRejectedValue(new Error('boom'));
        await expect(runHrisSyncJob(PAYLOAD)).rejects.toThrow('boom');
        expect(releaseSyncLock).toHaveBeenCalledWith(expect.anything(), 'conn-1', 'token-1');
    });

    it('releases when the sync returns ERROR', async () => {
        runHrisSync.mockResolvedValue({ executionId: 'e1', status: 'ERROR', upserted: 0, managersLinked: 0 });
        await runHrisSyncJob(PAYLOAD);
        expect(releaseSyncLock).toHaveBeenCalled();
    });

    it('releases when the pass is PARTIAL and will resume next run', async () => {
        // The resumable branch returns early-ish; a release skipped on that
        // path would wedge exactly the connections that need the NEXT run.
        runHrisSync.mockResolvedValue({ executionId: 'e1', status: 'PARTIAL', upserted: 5000, managersLinked: 0 });
        await runHrisSyncJob(PAYLOAD);
        expect(releaseSyncLock).toHaveBeenCalled();
    });
});

describe('input validation still comes first', () => {
    it('rejects a payload with no connection before taking any lock', async () => {
        await expect(runHrisSyncJob({ tenantId: 't1' } as never)).rejects.toThrow(/requires tenantId \+ connectionId/);
        expect(acquireSyncLock).not.toHaveBeenCalled();
    });
});
