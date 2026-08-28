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
// A REAL double, not `{}`. The reconcile report is written through this client,
// and `{}` would make every access throw into the writer's own try/catch — the
// feature would be dead while every test in this file stayed green.
const execFindFirst = jest.fn();
const execUpdate = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            integrationExecution: {
                findFirst: (...a: unknown[]) => execFindFirst(...a),
                update: (...a: unknown[]) => execUpdate(...a),
            },
        }),
    ),
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
// Spread the real module and override only what this file asserts on. A factory
// that LISTS the functions is a snapshot of the module as it looked the day it
// was written: the next counter added upstream is `undefined` here, and calling
// undefined throws out of a caller contracted never to throw — so the red lands
// on an unrelated assertion in another file. The spread tracks the module by
// itself, and the exports nobody overrides stay real (a noop meter, no cost).
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
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
    execFindFirst.mockResolvedValue({ resultJson: { upserted: 12, deprovisioned: 0, total: 12 } });
    execUpdate.mockResolvedValue({});
});

/** The `linkReconcile` block written onto the sync's own execution row. */
const written = () => execUpdate.mock.calls.at(-1)?.[0]?.data?.resultJson?.linkReconcile;

describe('the reconcile report reaches somewhere an operator can read it', () => {
    const unresolvedOf = (n: number, reason = 'NO_EMPLOYEE') =>
        Array.from({ length: n }, (_, i) => ({ connectedAccountId: `acc-${i}`, reason }));

    it('names the accounts, on the execution row the sync already wrote', async () => {
        // The defect this closes: the reconciler computes WHICH accounts could
        // not be linked and why, and its only caller logged four counts and
        // dropped the array. "9 unmatched" is exactly the unactionable number
        // that naming them was meant to replace.
        reconciled.mockResolvedValue({
            created: 1, verified: 0, unmatched: 2, contradicted: 0,
            unresolved: [
                { connectedAccountId: 'acc-1', reason: 'NO_EMPLOYEE' },
                { connectedAccountId: 'acc-2', reason: 'AMBIGUOUS_EMPLOYEE' },
            ],
        });
        await runIdentitySyncJob(PAYLOAD);

        // The SYNC's row — not a second execution row, which would double every
        // connection's history and surface on a list gated by a weaker
        // permission than the rest of this chain.
        expect(execUpdate.mock.calls.at(-1)?.[0].where).toEqual({ id: 'exec-1' });
        expect(written().unresolved).toEqual([
            { connectedAccountId: 'acc-1', reason: 'NO_EMPLOYEE' },
            { connectedAccountId: 'acc-2', reason: 'AMBIGUOUS_EMPLOYEE' },
        ]);
    });

    it('MERGES — the sync\'s own counters survive', async () => {
        // Prisma has no JSON merge, so this is read-modify-write. Overwriting
        // would erase `upserted` / `deprovisioned` from the row an operator
        // reads to find out what the sync did.
        await runIdentitySyncJob(PAYLOAD);
        const json = execUpdate.mock.calls.at(-1)?.[0].data.resultJson;
        expect(json).toMatchObject({ upserted: 12, deprovisioned: 0, total: 12 });
        expect(json.linkReconcile).toBeDefined();
    });

    it('replaces, rather than spreads, a resultJson that is not an object', async () => {
        // A Json column can hold a scalar or an array. Spreading either yields
        // index keys or nothing, silently losing the block being written.
        execFindFirst.mockResolvedValue({ resultJson: ['not', 'an', 'object'] });
        await runIdentitySyncJob(PAYLOAD);
        const json = execUpdate.mock.calls.at(-1)?.[0].data.resultJson;
        expect(json.linkReconcile).toBeDefined();
        expect(json['0']).toBeUndefined();
    });

    it('says so when the sample is truncated — derived, never assumed', async () => {
        // The reconciler caps the sample at MAX_UNRESOLVED_REPORTED while
        // `unmatched` counts every one, so the two disagreeing IS the signal.
        // Without it a capped list of 50 reads as a complete list of 50.
        reconciled.mockResolvedValue({
            created: 0, verified: 0, unmatched: 137, contradicted: 0,
            unresolved: unresolvedOf(50),
        });
        await runIdentitySyncJob(PAYLOAD);
        expect(written().unresolvedTruncated).toBe(true);
        expect(written().unmatched).toBe(137);
        expect(written().unresolved).toHaveLength(50);
    });

    it('does not claim truncation when the report is complete', async () => {
        reconciled.mockResolvedValue({
            created: 0, verified: 0, unmatched: 2, contradicted: 0,
            unresolved: unresolvedOf(2),
        });
        await runIdentitySyncJob(PAYLOAD);
        expect(written().unresolvedTruncated).toBe(false);
    });

    it('a failed write never fails the pass it is reporting on', async () => {
        // The reconcile already happened and already counted itself
        // `reconciled`. Letting this throw would emit `outcome: 'error'` for the
        // same pass immediately after — one pass reported twice under
        // contradictory outcomes is worse than one whose report is missing.
        execUpdate.mockRejectedValue(new Error('ledger down'));
        await expect(runIdentitySyncJob(PAYLOAD)).resolves.toBeDefined();

        // NOT `toHaveBeenCalledWith('reconciled')` — that passes if ANY call
        // matches, so it stayed green when the writer was made to throw: the
        // caller's own catch then emitted 'error' AS WELL, which is the exact
        // double-report this guard exists to prevent. Assert on the whole set.
        const outcomes = metric.mock.calls.map((c) => c[0].outcome);
        expect(outcomes).toEqual(['reconciled']);
    });
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
