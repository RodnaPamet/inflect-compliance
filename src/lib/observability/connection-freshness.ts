/**
 * GAP-3 — per-connection integration freshness (DB-backed).
 *
 * The H6 gauge `integration.check.staleness_seconds` is per-PROVIDER and
 * IN-MEMORY: it tracks the last outcome this process observed, so it
 * resets on restart and can't see a connection that has never emitted in
 * this process. This module adds the durable, per-CONNECTION view:
 *
 *   integration.connection.freshness_seconds{connection, provider}
 *     = seconds since the last SUCCESSFUL IntegrationExecution for each
 *       ENABLED connection, read from Postgres.
 *
 * A connection whose collector has silently died — or that has never once
 * succeeded since being enabled — climbs without bound. Alert on
 * `> CONNECTION_STALE_AFTER_SECONDS`.
 *
 * WHAT COUNTS AS A SUCCESS depends on the provider, and deliberately so:
 *
 *   - CLOUD-POSTURE providers (`isPostureProvider` — aws-posture and the
 *     cloud-posture family, Azure + GCP): PASSED **or** FAILED. A posture
 *     benchmark that reaches the account, reads it, and finds a gap persists
 *     FAILED — that is a successful collection with an unwelcome answer, and
 *     the collectors already treat it as one when they `clearAuthFailure` on
 *     FAILED. Anchoring on PASSED alone made every real posture connection
 *     read "never succeeded" and climb past the 48 h threshold forever, on a
 *     completely healthy connector.
 *   - EVERY OTHER provider: PASSED only. github and servicenow also emit
 *     FAILED for "the check ran and found a gap", but a genuinely broken one
 *     of those is the far more common cause — widening the allowlist fleet-
 *     wide would let a dead connector read fresh for up to 48 h longer than
 *     it should.
 *
 * The allowlist is written as an explicit `status: { in: [...] }` at the query
 * below, never as `{ not: 'ERROR' }`: IntegrationExecutionStatus has seven
 * values, and NOT-ERROR would admit RUNNING — resetting the freshness clock on
 * a job that has not finished (every posture run inserts RUNNING at its start).
 *
 * The gauge callback queries the DB per scrape (bounded + capped). It uses
 * the base `prisma` client (RLS-bypassing, like automation-runner) because
 * it reports platform-wide across every tenant. It never gates readiness —
 * out-of-band + fail-safe, like the other integration metrics.
 */
import { metrics } from '@opentelemetry/api';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import type { Prisma } from '@prisma/client';
import { isPostureProvider } from '@/app-layer/integrations/posture-providers';

const METER_NAME = 'inflect-compliance-integrations';
function getMeter() {
    return metrics.getMeter(METER_NAME);
}

/**
 * A connection is considered stale if its last success is older than this.
 * Integration checks are typically daily crons, so 48 h leaves a full missed
 * cycle of slack before a healthy daily check is flagged — avoids false
 * positives while still catching a collector that has genuinely stopped.
 */
export const CONNECTION_STALE_AFTER_SECONDS = 48 * 60 * 60;

/**
 * Hard cap on the number of connection series the gauge emits per scrape.
 * `connection` is a per-id label (necessarily high cardinality); the cap
 * bounds the metric's series count on a large multi-tenant fleet. When the
 * cap bites we report the STALEST connections (the ones worth alerting on)
 * and log the truncation so it is never silent.
 */
export const MAX_FRESHNESS_SERIES = 1000;

export interface ConnectionFreshness {
    connectionId: string;
    provider: string;
    tenantId: string;
    /**
     * ms-epoch of the last SUCCESSFUL execution, or null if never succeeded.
     * "Successful" is PASSED, plus FAILED for cloud-posture providers only —
     * see the status allowlist in the module docstring.
     */
    lastSuccessAtMs: number | null;
    /**
     * Seconds since the last SUCCESSFUL execution. When the connection has
     * never succeeded, this is the age since it was enabled (its createdAt) —
     * so a long-enabled-never-succeeded connection climbs like a dead one,
     * while a brand-new connection isn't instantly "infinitely stale".
     */
    secondsSinceLastSuccess: number;
    hasEverSucceeded: boolean;
}

/**
 * Compute per-connection freshness across every ENABLED connection, tenant-wide.
 * Two bounded queries (enabled connections + one grouped max-per-connection
 * over the collected statuses) — never a per-connection query in a loop.
 */
export async function getEnabledConnectionFreshness(
    now: number = Date.now(),
): Promise<ConnectionFreshness[]> {
    const connections = await prisma.integrationConnection.findMany({
        where: { isEnabled: true },
        select: { id: true, provider: true, tenantId: true, createdAt: true },
        take: MAX_FRESHNESS_SERIES * 5, // read headroom; the cap is applied after ranking
    });
    if (connections.length === 0) return [];

    // Split by provider so the status allowlist can widen for posture WITHOUT
    // widening for anything else. Still ONE grouped query: an OR of the two
    // (id-set, allowlist) pairs, not a query per provider or per connection.
    const postureIds: string[] = [];
    const otherIds: string[] = [];
    for (const c of connections) (isPostureProvider(c.provider) ? postureIds : otherIds).push(c.id);

    const collected: Prisma.IntegrationExecutionWhereInput[] = [];
    // Posture: a FAILED benchmark READ the account and found a gap, so it is a
    // collection. Explicit allowlist, never `{ not: 'ERROR' }` — that would
    // admit RUNNING and reset the clock on an unfinished job.
    if (postureIds.length > 0) {
        collected.push({ status: { in: ['PASSED', 'FAILED'] }, connectionId: { in: postureIds } });
    }
    // Everything else: PASSED only.
    if (otherIds.length > 0) {
        collected.push({ status: { in: ['PASSED'] }, connectionId: { in: otherIds } });
    }
    const grouped = await prisma.integrationExecution.groupBy({
        by: ['connectionId'],
        where: { OR: collected },
        _max: { completedAt: true, executedAt: true },
    });

    const lastSuccessByConn = new Map<string, Date>();
    for (const g of grouped) {
        if (!g.connectionId) continue;
        const ts = g._max.completedAt ?? g._max.executedAt;
        if (ts) lastSuccessByConn.set(g.connectionId, ts);
    }

    const rows: ConnectionFreshness[] = connections.map((c) => {
        const last = lastSuccessByConn.get(c.id) ?? null;
        const anchorMs = (last ?? c.createdAt).getTime();
        return {
            connectionId: c.id,
            provider: c.provider,
            tenantId: c.tenantId,
            lastSuccessAtMs: last ? last.getTime() : null,
            secondsSinceLastSuccess: Math.max(0, Math.round((now - anchorMs) / 1000)),
            hasEverSucceeded: last != null,
        };
    });

    // Rank stalest-first and apply the cap; log if it bit.
    rows.sort((a, b) => b.secondsSinceLastSuccess - a.secondsSinceLastSuccess);
    if (rows.length > MAX_FRESHNESS_SERIES) {
        logger.warn('Connection-freshness gauge truncated to the series cap', {
            component: 'integration-metrics',
            total: rows.length,
            reported: MAX_FRESHNESS_SERIES,
        });
        return rows.slice(0, MAX_FRESHNESS_SERIES);
    }
    return rows;
}

let _connectionFreshnessStarted = false;

/**
 * Register the observable gauge `integration.connection.freshness_seconds`.
 * DB-backed (queries per scrape); idempotent. Register once at startup.
 */
export function startConnectionFreshnessReporting(now: () => number = Date.now): void {
    if (_connectionFreshnessStarted) return;
    _connectionFreshnessStarted = true;
    const gauge = getMeter().createObservableGauge('integration.connection.freshness_seconds', {
        description: 'Seconds since the last successful execution (PASSED, plus FAILED for cloud-posture providers), per enabled connection',
        unit: 's',
    });
    gauge.addCallback(async (result) => {
        try {
            const rows = await getEnabledConnectionFreshness(now());
            for (const r of rows) {
                result.observe(r.secondsSinceLastSuccess, {
                    connection: r.connectionId,
                    provider: r.provider,
                });
            }
        } catch (err) {
            // Fail-safe: a DB blip just skips this scrape.
            logger.warn('Connection-freshness gauge scrape failed', {
                component: 'integration-metrics',
                err: err instanceof Error ? err : new Error(String(err)),
            });
        }
    });
}

/** Reset registration state (testing only). @internal */
export function _resetConnectionFreshnessForTesting(): void {
    _connectionFreshnessStarted = false;
}
