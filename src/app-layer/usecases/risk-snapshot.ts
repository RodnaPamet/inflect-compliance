/**
 * RQ-9 — historical snapshots (trend + velocity foundation).
 *
 * The daily `risk-snapshot` cron captures each active risk's metrics +
 * a portfolio aggregate, so analysts can show "portfolio ALE fell 18%
 * over 6 months" — data that doesn't exist from a point-in-time register.
 *
 * `takeSnapshot` is idempotent per UTC day (PortfolioSnapshot carries a
 * unique [tenantId, snapshotAt]).
 *
 * @module usecases/risk-snapshot
 */
import type { PrismaClient } from '@prisma/client';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import { resolveALE } from './fair-calculator';
import { riskStatusNeedsTreatment } from '../domain/risk-status';

/** Midnight UTC of the given instant — the per-day snapshot key. */
function dayStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Snapshot all active risks + the portfolio aggregate for a tenant.
 * Idempotent per UTC day. Called by the cron with a bypass-capable client.
 */
export async function takeSnapshot(
    db: PrismaClient,
    tenantId: string,
    now: Date = new Date(),
): Promise<{ riskSnapshots: number; portfolioSnapshot: boolean }> {
    const at = dayStart(now);
    const existing = await db.portfolioSnapshot.findFirst({ where: { tenantId, snapshotAt: at }, select: { id: true } });
    if (existing) return { riskSnapshots: 0, portfolioSnapshot: false };

    const risks = await db.risk.findMany({
        where: { tenantId, deletedAt: null },
        select: {
            id: true, score: true, inherentScore: true, residualScore: true, likelihood: true, impact: true, status: true,
            fairAle: true, sleAmount: true, aroAmount: true, threatEventFrequency: true, vulnerabilityProbability: true, primaryLossMagnitude: true,
        },
        take: 20000,
    });

    let totalAle = 0, quantifiedCount = 0, totalScore = 0, openCount = 0, maxSingleAle = 0;
    const rows = risks.map((r) => {
        const ale = resolveALE({ fairAle: r.fairAle, sleAmount: r.sleAmount, aroAmount: r.aroAmount });
        if (ale != null) { totalAle += ale; quantifiedCount += 1; if (ale > maxSingleAle) maxSingleAle = ale; }
        totalScore += r.score;
        // `openRiskCount` has always counted OPEN + MITIGATING: the risks still
        // needing treatment, the line the Board's severity figures now draw too.
        if (riskStatusNeedsTreatment(r.status)) openCount += 1;
        return {
            tenantId, riskId: r.id, score: r.score, inherentScore: r.inherentScore, residualScore: r.residualScore,
            likelihood: r.likelihood, impact: r.impact, status: String(r.status),
            ale, fairAle: r.fairAle, sleAmount: r.sleAmount, aroAmount: r.aroAmount,
            tef: r.threatEventFrequency, vulnerability: r.vulnerabilityProbability, plm: r.primaryLossMagnitude,
            snapshotAt: at,
        };
    });

    if (rows.length > 0) await db.riskSnapshot.createMany({ data: rows });
    await db.portfolioSnapshot.create({
        data: {
            tenantId, totalRiskCount: risks.length, openRiskCount: openCount, quantifiedCount,
            totalAle: quantifiedCount > 0 ? totalAle : null,
            avgAle: quantifiedCount > 0 ? totalAle / quantifiedCount : null,
            maxSingleAle: quantifiedCount > 0 ? maxSingleAle : null,
            totalScore, avgScore: risks.length > 0 ? totalScore / risks.length : 0,
            snapshotAt: at,
        },
    });
    return { riskSnapshots: rows.length, portfolioSnapshot: true };
}

/** Delete snapshots older than `retentionDays` (default 730). */
export async function cleanupSnapshots(db: PrismaClient, tenantId: string, retentionDays = 730, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 86400000);
    const a = await db.riskSnapshot.deleteMany({ where: { tenantId, snapshotAt: { lt: cutoff } } });
    const b = await db.portfolioSnapshot.deleteMany({ where: { tenantId, snapshotAt: { lt: cutoff } } });
    return a.count + b.count;
}

export async function getRiskHistory(ctx: RequestContext, riskId: string, opts: { since?: Date; until?: Date } = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.riskSnapshot.findMany({
            where: { tenantId: ctx.tenantId, riskId, ...(opts.since || opts.until ? { snapshotAt: { ...(opts.since ? { gte: opts.since } : {}), ...(opts.until ? { lte: opts.until } : {}) } } : {}) },
            orderBy: { snapshotAt: 'asc' }, take: 1000,
        }),
    );
}

export async function getPortfolioTrend(ctx: RequestContext, opts: { since?: Date; until?: Date } = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.portfolioSnapshot.findMany({
            where: { tenantId: ctx.tenantId, ...(opts.since || opts.until ? { snapshotAt: { ...(opts.since ? { gte: opts.since } : {}), ...(opts.until ? { lte: opts.until } : {}) } } : {}) },
            orderBy: { snapshotAt: 'asc' }, take: 1000,
        }),
    );
}
