/**
 * The per-connection sync lease, under real concurrent contention.
 *
 * Driven at the JOB layer, not the usecase. `acquireSyncLock` /
 * `releaseSyncLock` are called in `jobs/identity-sync.ts`, NOT inside
 * `runIdentitySync` — so a harness that drove the usecase would bypass the lock
 * entirely and every assertion here would be vacuous. That seam is easy to get
 * wrong from reading the usecase alone.
 *
 * Contention is real: N concurrent `acquireSyncLock` calls against real
 * Postgres, relying on the database's own row-lock re-evaluation of the
 * conditional UPDATE. A fake would prove nothing, because the whole design claim
 * is "check and claim are one atomic statement".
 *
 * Concurrency is capped at 8 by measurement, not taste: the pg pool defaults to
 * max 10 under the driver adapter and each in-flight tenant holds one connection
 * for its entire enumeration, so 10 concurrent drivers all fail with a pool
 * timeout.
 *
 * @see tests/stress/README.md
 */
import { randomUUID } from 'node:crypto';
import {
    requireStressDb,
    stressPrisma,
    teardownTenant,
    CONCURRENCY_CAP,
    recordTrend,
} from './helpers/stress-env';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import {
    acquireSyncLock,
    releaseSyncLock,
    SYNC_LOCK_TTL_MS,
} from '@/app-layer/integrations/connection-lock';

jest.setTimeout(180_000);

/** Short lease so the reaper is testable without waiting 30 minutes. */
const SHORT_TTL_MS = 500;

const prisma = stressPrisma();
const TAG = `stressl${Date.now().toString(36)}`;
const TENANT_ID = `t-${TAG}`;
const ctx = buildSystemContext({ tenantId: TENANT_ID, job: 'stress-lock' });

let connectionId: string;

async function seedConnection(): Promise<string> {
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: TENANT_ID,
            provider: 'okta',
            name: `okta-${randomUUID().slice(0, 8)}`,
            isEnabled: true,
            configJson: { orgUrl: 'https://acme.okta.com', apiToken: 'x', enrichPerUser: 'false' },
            secretEncrypted: null,
        },
        select: { id: true },
    });
    return conn.id;
}

const acquire = (now?: Date, ttlMs?: number) =>
    runInTenantContext(ctx, (db) => acquireSyncLock(db, connectionId, now, ttlMs));

const release = (token: string) =>
    runInTenantContext(ctx, (db) => releaseSyncLock(db, connectionId, token));

const lockRow = () =>
    prisma.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { syncLockedAt: true, syncLockToken: true },
    });

beforeAll(async () => {
    requireStressDb();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `stress ${TAG}`, slug: TAG },
    });
});

afterAll(async () => {
    await teardownTenant(prisma, TENANT_ID);
    await prisma.$disconnect();
});

beforeEach(async () => {
    connectionId = await seedConnection();
});

afterEach(async () => {
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT_ID } });
});

describe('the lease admits exactly one winner under real contention', () => {
    it('THRESHOLD 13 — N concurrent acquires yield 1 token and N-1 refusals', async () => {
        // The property the whole lock exists for. Two concurrent SharePoint
        // delta syncs replay the same change set and each create a FRESH
        // Evidence row for every changed file, leaving an orphaned duplicate
        // with no provenance.
        const started = Date.now();
        const results = await Promise.all(
            Array.from({ length: CONCURRENCY_CAP }, () => acquire()),
        );

        const tokens = results.filter((t): t is string => typeof t === 'string');
        const refusals = results.filter((t) => t === null);

        expect(tokens).toHaveLength(1);
        expect(refusals).toHaveLength(CONCURRENCY_CAP - 1);

        // The winner is the one the row actually records — not merely "someone
        // got a token".
        expect((await lockRow())?.syncLockToken).toBe(tokens[0]);
        recordTrend('lock_contention_ms', Date.now() - started, 'ms');
    });

    it('a released lease is immediately re-acquirable', async () => {
        const first = await acquire();
        expect(first).toEqual(expect.any(String));

        expect(await release(first!)).toBe(true);
        expect((await lockRow())?.syncLockToken).toBeNull();

        const second = await acquire();
        expect(second).toEqual(expect.any(String));
        expect(second).not.toBe(first);
    });
});

describe('the reaper frees a lease a dead worker left behind', () => {
    it('THRESHOLD 14 — a lease older than the TTL is reclaimed, exactly once', async () => {
        // The reaper IS the acquire predicate. A separate sweeper would leave a
        // window where the lock is stale and nothing has reclaimed it.
        const dead = await acquire(new Date(), SHORT_TTL_MS);
        expect(dead).toEqual(expect.any(String));

        // Fresh: still refused.
        expect(await acquire(new Date(), SHORT_TTL_MS)).toBeNull();

        // Past the lease: reclaimed. Time is passed in, never waited for.
        const future = new Date(Date.now() + SHORT_TTL_MS + 50);
        const reclaimers = await Promise.all(
            Array.from({ length: CONCURRENCY_CAP }, () => acquire(future, SHORT_TTL_MS)),
        );
        const got = reclaimers.filter((t): t is string => typeof t === 'string');

        // Exactly one — a stale lease must not admit a crowd.
        expect(got).toHaveLength(1);
        expect(got[0]).not.toBe(dead);
    });

    it('THRESHOLD 15 — a reaped holder cannot unlock the run that replaced it', async () => {
        // The dangerous case. If the old holder's release were unconditional it
        // would unlock the connection WHILE the new holder is still running,
        // turning one overlap into an unbounded number.
        const stale = await acquire(new Date(), SHORT_TTL_MS);
        const future = new Date(Date.now() + SHORT_TTL_MS + 50);
        const fresh = await acquire(future, SHORT_TTL_MS);

        expect(fresh).toEqual(expect.any(String));
        expect(await release(stale!)).toBe(false);

        const row = await lockRow();
        expect(row?.syncLockToken).toBe(fresh);
        expect(row?.syncLockedAt).not.toBeNull();
    });

    it('the production TTL sits above any plausible run and below the tightest schedule', () => {
        // Too short reintroduces the overlap; too long leaves a connection
        // wedged past its next scheduled run. SharePoint's 4h cadence is the
        // binding constraint.
        expect(SYNC_LOCK_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
        expect(SYNC_LOCK_TTL_MS).toBeLessThan(4 * 3_600_000);
    });
});

describe('the lock lives in the JOB layer', () => {
    it('THRESHOLD 16 — concurrent job runs skip rather than overlap', async () => {
        // Driven through the job wrapper, because that is where the lock is.
        // A version of this test written against `runIdentitySync` would pass
        // while proving nothing — the usecase never touches the lease.
        const { runIdentitySyncJob } = await import('@/app-layer/jobs/identity-sync');

        const results = await Promise.all(
            Array.from({ length: CONCURRENCY_CAP }, () =>
                runIdentitySyncJob({ tenantId: TENANT_ID, connectionId }).catch((e) => ({
                    status: `THREW:${e instanceof Error ? e.message : String(e)}`,
                })),
            ),
        );

        const skipped = results.filter((r) => r.status === 'SKIPPED');
        // One runs, the rest skip. The runner itself fails (no reachable Okta),
        // which is fine — the assertion is about exclusion, not about the sync.
        expect(skipped).toHaveLength(CONCURRENCY_CAP - 1);

        // A skip must be distinguishable from a success, or the lock is
        // invisible in exactly the logs someone checks to find out why data
        // looks stale.
        expect(skipped.every((r) => r.status !== 'PASSED')).toBe(true);

        // And the lease is released afterwards, not left wedged.
        expect((await lockRow())?.syncLockToken).toBeNull();
    });
});
