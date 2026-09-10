/**
 * GAP-3 — per-connection DB-backed freshness.
 *
 * Proves the cross-tenant freshness computation: seconds since the last
 * SUCCESSFUL execution per enabled connection, the never-succeeded fallback to
 * connection age, and the stalest-first cap. The gauge itself is registered
 * idempotently.
 *
 * #2252 — and the PROVIDER-SCOPED status allowlist. "Successful" is PASSED for
 * every provider, plus FAILED for cloud-posture providers ONLY, because a
 * posture benchmark that reaches the account and finds a gap persists FAILED.
 * The scoping cases below run the real `where` clause through a fake grouped
 * query rather than stubbing its result, so they fail if the allowlist widens
 * fleet-wide, narrows back to PASSED-only, or turns into a `{ not: 'ERROR' }`
 * denylist that would admit RUNNING.
 */
const prismaMock = {
    integrationConnection: { findMany: jest.fn() },
    integrationExecution: { groupBy: jest.fn() },
};

jest.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { fakeExecutionGroupBy, type FakeExecution } from '../../helpers/execution-status-groupby';
import {
    getEnabledConnectionFreshness,
    startConnectionFreshnessReporting,
    _resetConnectionFreshnessForTesting,
    CONNECTION_STALE_AFTER_SECONDS,
    MAX_FRESHNESS_SERIES,
} from '@/lib/observability/connection-freshness';

const NOW = 1_700_000_000_000; // fixed epoch-ms
const minsAgo = (m: number) => new Date(NOW - m * 60_000);

beforeEach(() => {
    jest.clearAllMocks();
    _resetConnectionFreshnessForTesting();
});

describe('getEnabledConnectionFreshness', () => {
    it('returns empty when there are no enabled connections', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([]);
        const rows = await getEnabledConnectionFreshness(NOW);
        expect(rows).toEqual([]);
        expect(prismaMock.integrationExecution.groupBy).not.toHaveBeenCalled();
    });

    it('computes seconds since the last PASSED execution per connection', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', provider: 'okta', tenantId: 't1', createdAt: minsAgo(10_000) },
            { id: 'c2', provider: 'aws', tenantId: 't1', createdAt: minsAgo(10_000) },
        ]);
        prismaMock.integrationExecution.groupBy.mockResolvedValue([
            { connectionId: 'c1', _max: { completedAt: minsAgo(30), executedAt: minsAgo(31) } },
            { connectionId: 'c2', _max: { completedAt: null, executedAt: minsAgo(90) } },
        ]);
        const rows = await getEnabledConnectionFreshness(NOW);
        const byId = Object.fromEntries(rows.map((r) => [r.connectionId, r]));
        expect(byId.c1.secondsSinceLastSuccess).toBe(30 * 60);
        expect(byId.c1.hasEverSucceeded).toBe(true);
        // falls back to executedAt when completedAt is null
        expect(byId.c2.secondsSinceLastSuccess).toBe(90 * 60);
    });

    it('a never-succeeded connection ages from its createdAt (not infinite)', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', provider: 'okta', tenantId: 't1', createdAt: minsAgo(45) },
        ]);
        prismaMock.integrationExecution.groupBy.mockResolvedValue([]); // no successes
        const [row] = await getEnabledConnectionFreshness(NOW);
        expect(row.hasEverSucceeded).toBe(false);
        expect(row.lastSuccessAtMs).toBeNull();
        expect(row.secondsSinceLastSuccess).toBe(45 * 60);
    });

    it('caps the series at MAX_FRESHNESS_SERIES, stalest-first', async () => {
        const conns = Array.from({ length: MAX_FRESHNESS_SERIES + 5 }, (_, i) => ({
            id: `c${i}`, provider: 'p', tenantId: 't1', createdAt: minsAgo(i + 1),
        }));
        prismaMock.integrationConnection.findMany.mockResolvedValue(conns);
        prismaMock.integrationExecution.groupBy.mockResolvedValue([]);
        const rows = await getEnabledConnectionFreshness(NOW);
        expect(rows).toHaveLength(MAX_FRESHNESS_SERIES);
        // stalest (largest age → largest createdAt offset) first
        expect(rows[0].secondsSinceLastSuccess).toBeGreaterThanOrEqual(rows[1].secondsSinceLastSuccess);
    });
});

describe('startConnectionFreshnessReporting', () => {
    it('is idempotent (safe to call twice)', () => {
        expect(() => {
            startConnectionFreshnessReporting();
            startConnectionFreshnessReporting();
        }).not.toThrow();
    });

    it('exports a sane stale threshold (2 days)', () => {
        expect(CONNECTION_STALE_AFTER_SECONDS).toBe(48 * 60 * 60);
    });
});

// ─── #2252 — the status allowlist is scoped to POSTURE providers ─────
//
// These cases do not stub `groupBy`'s RESULT. They stub the QUERY: a tiny
// in-memory execution table is filtered by the very `where` the module built
// (tests/helpers/execution-status-groupby.ts), so an assertion here is about
// the predicate, not about a fixture.

describe('getEnabledConnectionFreshness — posture-scoped status allowlist (#2252)', () => {
    /** Long-enabled, so "never succeeded" is unambiguously past the threshold. */
    const ENABLED_MINS_AGO = 10_000;
    const conn = (id: string, provider: string) => ({
        id, provider, tenantId: 't1', createdAt: minsAgo(ENABLED_MINS_AGO),
    });
    const failedRun = (connectionId: string): FakeExecution => ({
        connectionId, status: 'FAILED', completedAt: minsAgo(30), executedAt: minsAgo(31),
    });

    it('a posture connection whose ONLY execution is FAILED reads as collected and is not stale', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            conn('aws1', 'aws-posture'),
            conn('az1', 'azure-posture'),
            conn('gcp1', 'gcp-posture'),
        ]);
        prismaMock.integrationExecution.groupBy = fakeExecutionGroupBy([
            failedRun('aws1'), failedRun('az1'), failedRun('gcp1'),
        ]);

        const rows = await getEnabledConnectionFreshness(NOW);
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.hasEverSucceeded).toBe(true);
            expect(row.lastSuccessAtMs).toBe(NOW - 30 * 60_000);
            expect(row.secondsSinceLastSuccess).toBe(30 * 60);
            // The defect: it used to anchor on createdAt and climb past 48 h
            // on a connector that had run perfectly every night.
            expect(row.secondsSinceLastSuccess).toBeLessThan(CONNECTION_STALE_AFTER_SECONDS);
        }
    });

    it('a github or servicenow connection whose ONLY execution is FAILED still reads as never-succeeded', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            conn('gh1', 'github'),
            conn('snow1', 'servicenow'),
        ]);
        prismaMock.integrationExecution.groupBy = fakeExecutionGroupBy([
            failedRun('gh1'), failedRun('snow1'),
        ]);

        const rows = await getEnabledConnectionFreshness(NOW);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.hasEverSucceeded).toBe(false);
            expect(row.lastSuccessAtMs).toBeNull();
            // Ages from createdAt, so a genuinely broken one still pages on time.
            expect(row.secondsSinceLastSuccess).toBe(ENABLED_MINS_AGO * 60);
            expect(row.secondsSinceLastSuccess).toBeGreaterThan(CONNECTION_STALE_AFTER_SECONDS);
        }
    });

    it('both scopings hold together, in ONE grouped query, on a mixed fleet', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            conn('aws1', 'aws-posture'),
            conn('gh1', 'github'),
        ]);
        const groupBy = fakeExecutionGroupBy([failedRun('aws1'), failedRun('gh1')]);
        prismaMock.integrationExecution.groupBy = groupBy;

        const rows = await getEnabledConnectionFreshness(NOW);
        const byId = Object.fromEntries(rows.map((r) => [r.connectionId, r]));
        expect(byId.aws1.hasEverSucceeded).toBe(true);
        expect(byId.gh1.hasEverSucceeded).toBe(false);
        // The docstring's promise: two bounded queries total, not one per provider.
        expect(groupBy).toHaveBeenCalledTimes(1);
    });

    it('a posture connection whose only execution is RUNNING is NOT collected (allowlist, not NOT-ERROR)', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([conn('aws1', 'aws-posture')]);
        prismaMock.integrationExecution.groupBy = fakeExecutionGroupBy([
            // An orphaned RUNNING row from a killed worker. A `{ not: 'ERROR' }`
            // denylist would admit it and reset the clock on an unfinished job.
            { connectionId: 'aws1', status: 'RUNNING', completedAt: null, executedAt: minsAgo(30) },
        ]);

        const [row] = await getEnabledConnectionFreshness(NOW);
        expect(row.hasEverSucceeded).toBe(false);
        expect(row.lastSuccessAtMs).toBeNull();
        expect(row.secondsSinceLastSuccess).toBe(ENABLED_MINS_AGO * 60);
    });

    it('PASSED still counts for posture, and ERROR / PENDING / NOT_APPLICABLE never do', async () => {
        prismaMock.integrationConnection.findMany.mockResolvedValue([
            conn('aws1', 'aws-posture'),
            conn('aws2', 'aws-posture'),
        ]);
        prismaMock.integrationExecution.groupBy = fakeExecutionGroupBy([
            { connectionId: 'aws1', status: 'PASSED', completedAt: minsAgo(20), executedAt: null },
            { connectionId: 'aws2', status: 'ERROR', completedAt: minsAgo(5), executedAt: null },
            { connectionId: 'aws2', status: 'PENDING', completedAt: minsAgo(4), executedAt: null },
            { connectionId: 'aws2', status: 'NOT_APPLICABLE', completedAt: minsAgo(3), executedAt: null },
        ]);

        const rows = await getEnabledConnectionFreshness(NOW);
        const byId = Object.fromEntries(rows.map((r) => [r.connectionId, r]));
        expect(byId.aws1.hasEverSucceeded).toBe(true);
        expect(byId.aws1.secondsSinceLastSuccess).toBe(20 * 60);
        expect(byId.aws2.hasEverSucceeded).toBe(false);
    });
});
