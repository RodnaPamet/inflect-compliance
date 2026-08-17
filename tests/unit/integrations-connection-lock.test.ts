/**
 * The per-connection sync lease.
 *
 * What this prevents is not "wasted work". Two concurrent SharePoint delta
 * syncs replay the same change set from the same delta token, and `importOne`
 * always calls `uploadEvidenceFile` — only the *mapping* is upserted. So the
 * same file becomes two Evidence rows and one mapping, and the copy without a
 * mapping has no provenance back to the drive it came from. In a compliance
 * product that is a document an auditor sees twice.
 *
 * The assertions here are mostly about the LEASE semantics, because that is
 * where a lock goes subtly wrong: reaping too eagerly reintroduces the overlap,
 * and releasing without checking the token turns one overlap into unbounded
 * overlap.
 */
import {
    acquireSyncLock,
    releaseSyncLock,
    SYNC_LOCK_TTL_MS,
} from '@/app-layer/integrations/connection-lock';

type Where = Record<string, unknown>;

/**
 * A fake `integrationConnection.updateMany` backed by one row, honouring the
 * predicates the lock actually uses. Faithful enough that the conditional-update
 * semantics — the whole point of the design — are really exercised.
 */
function fakeDb(initial: { syncLockedAt: Date | null; syncLockToken: string | null }) {
    const row = { ...initial };
    const db = {
        integrationConnection: {
            // Present only so acquire can LABEL its metric (acquired vs reaped).
            // Deliberately returns the pre-claim state.
            findFirst: jest.fn(async () => ({ syncLockedAt: row.syncLockedAt })),
            updateMany: jest.fn(async ({ where, data }: { where: Where; data: Where }) => {
                let match = true;

                if (Array.isArray(where.OR)) {
                    match = (where.OR as Where[]).some((clause) => {
                        if ('syncLockedAt' in clause && clause.syncLockedAt === null) {
                            return row.syncLockedAt === null;
                        }
                        const lt = (clause.syncLockedAt as { lt?: Date } | undefined)?.lt;
                        return lt != null && row.syncLockedAt != null && row.syncLockedAt < lt;
                    });
                }
                if (typeof where.syncLockToken === 'string') {
                    match = match && row.syncLockToken === where.syncLockToken;
                }

                if (!match) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }),
        },
    };
    return { db: db as never, row };
}

const CONN = 'conn_1';
const NOW = new Date('2026-08-17T12:00:00Z');

describe('acquireSyncLock', () => {
    it('takes a free lock and stamps a token', async () => {
        const { db, row } = fakeDb({ syncLockedAt: null, syncLockToken: null });

        const token = await acquireSyncLock(db, CONN, NOW);

        expect(token).toEqual(expect.any(String));
        expect(row.syncLockedAt).toBe(NOW);
        expect(row.syncLockToken).toBe(token);
    });

    it('refuses when another run holds a FRESH lock', async () => {
        // The whole point: this is the second concurrent delta sync, and it must
        // not proceed to create a duplicate Evidence row.
        const held = new Date(NOW.getTime() - 60_000);
        const { db } = fakeDb({ syncLockedAt: held, syncLockToken: 'other-run' });

        expect(await acquireSyncLock(db, CONN, NOW)).toBeNull();
    });

    it('reaps a lock older than the TTL — a dead worker must not wedge a connection', async () => {
        // The reaper IS this predicate. A separate sweeper job would leave a
        // window where the lock is stale but nothing has reclaimed it, and would
        // be one more scheduled thing that can fail silently.
        const stale = new Date(NOW.getTime() - SYNC_LOCK_TTL_MS - 1);
        const { db, row } = fakeDb({ syncLockedAt: stale, syncLockToken: 'dead-worker' });

        const token = await acquireSyncLock(db, CONN, NOW);

        expect(token).toEqual(expect.any(String));
        expect(token).not.toBe('dead-worker');
        expect(row.syncLockToken).toBe(token);
    });

    it('does NOT reap a lock exactly at the TTL boundary', async () => {
        // Off-by-one here reintroduces the overlap for any run that takes
        // exactly the budget, which is the run most likely to be near it.
        const boundary = new Date(NOW.getTime() - SYNC_LOCK_TTL_MS);
        const { db } = fakeDb({ syncLockedAt: boundary, syncLockToken: 'holder' });

        expect(await acquireSyncLock(db, CONN, NOW)).toBeNull();
    });

    it('claims with ONE conditional UPDATE that carries the freshness predicate', async () => {
        // A read-then-write claim would leave exactly the race this exists to
        // close. There IS a read now — added to label the metric acquired-vs-
        // reaped — so this asserts the claim itself is still a single
        // conditional statement and that the predicate travels WITH it, rather
        // than the read having become load-bearing.
        const { db } = fakeDb({ syncLockedAt: null, syncLockToken: null });
        await acquireSyncLock(db, CONN, NOW);

        const conn = (db as unknown as {
            integrationConnection: { updateMany: jest.Mock; findFirst: jest.Mock };
        }).integrationConnection;

        expect(conn.updateMany.mock.calls).toHaveLength(1);
        const where = conn.updateMany.mock.calls[0][0].where;
        expect(where.id).toBe(CONN);
        expect(where.OR).toHaveLength(2);
        // The read must select ONLY the label input. If it ever starts feeding
        // the claim, the claim has stopped being atomic.
        expect(conn.findFirst.mock.calls[0][0].select).toEqual({ syncLockedAt: true });
    });

    it('still refuses a fresh lock even if the labelling read is stale', async () => {
        // The read is best-effort. A stale one may mislabel a counter; it must
        // never admit a second concurrent sync, because the claim does not
        // consult it.
        const { db } = fakeDb({ syncLockedAt: new Date(NOW.getTime() - 1000), syncLockToken: 'holder' });
        (db as unknown as { integrationConnection: { findFirst: jest.Mock } })
            .integrationConnection.findFirst.mockResolvedValueOnce({ syncLockedAt: null });

        expect(await acquireSyncLock(db, CONN, NOW)).toBeNull();
    });

    it('issues a distinct token per acquisition', async () => {
        const a = await acquireSyncLock(
            fakeDb({ syncLockedAt: null, syncLockToken: null }).db, CONN, NOW,
        );
        const b = await acquireSyncLock(
            fakeDb({ syncLockedAt: null, syncLockToken: null }).db, CONN, NOW,
        );
        expect(a).not.toBe(b);
    });
});

describe('releaseSyncLock', () => {
    it('clears the lock it holds', async () => {
        const { db, row } = fakeDb({ syncLockedAt: NOW, syncLockToken: 'mine' });

        expect(await releaseSyncLock(db, CONN, 'mine')).toBe(true);
        expect(row.syncLockedAt).toBeNull();
        expect(row.syncLockToken).toBeNull();
    });

    it('will NOT clear a lock that was reaped and retaken', async () => {
        // The dangerous case. This run overran its lease, someone else took the
        // lock, and now this run finishes. Clearing unconditionally would unlock
        // the connection WHILE the new holder is still running — turning one
        // overlap into an unbounded number.
        const { db, row } = fakeDb({ syncLockedAt: NOW, syncLockToken: 'the-new-holder' });

        expect(await releaseSyncLock(db, CONN, 'my-stale-token')).toBe(false);
        expect(row.syncLockToken).toBe('the-new-holder');
        expect(row.syncLockedAt).toBe(NOW);
    });
});

describe('the TTL itself', () => {
    it('sits above any plausible run and below the tightest schedule', () => {
        // Too short reintroduces the overlap it exists to prevent; too long
        // means a connection wedged by a killed worker stays wedged past its
        // next scheduled run. The SharePoint dispatcher's 4h cadence is the
        // tightest constraint.
        const FOUR_HOURS = 4 * 3_600_000;
        expect(SYNC_LOCK_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
        expect(SYNC_LOCK_TTL_MS).toBeLessThan(FOUR_HOURS);
    });
});
