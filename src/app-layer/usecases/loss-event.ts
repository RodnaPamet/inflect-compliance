/**
 * RQ3-6 — the loss-event register.
 *
 * The system predicts losses everywhere (FAIR ALE, Monte Carlo
 * P50/P90, LEC); this usecase is where the world's answer comes
 * back, so the forecasting stack becomes falsifiable. A forecasting
 * system that never scores its forecasts isn't analytics — it's
 * theology.
 *
 * Contract:
 *   - tenant-scoped (RLS + application-layer filter on every query);
 *   - free-text fields server-sanitised on write (Epic D.2) BEFORE
 *     the encryption middleware (Epic B) writes them — every
 *     decryptor (UI, PDF, audit-pack share link) reads safe HTML;
 *   - audit-logged + the AuditLog row carries the RQ2-1-style
 *     provenance (source, justification);
 *   - aggregate read returns the per-period and per-risk roll-up
 *     the predicted-vs-actual overlay consumes — actuals never
 *     leak the predictions (those live with the simulation).
 *
 * @module usecases/loss-event
 */

import type { RequestContext } from '../types';
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import type { LossEventSource } from '@prisma/client';

/** A single loss event as returned to the client. */
export interface LossEventRow {
    id: string;
    riskId: string | null;
    occurredAt: Date;
    amount: number;
    description: string | null;
    source: LossEventSource;
    justification: string | null;
    createdByUserId: string | null;
    createdAt: Date;
    /** #4773 — the attributed risk's title, for the register. Absent on create. */
    risk?: { id: string; title: string } | null;
}

export interface CreateLossEventInput {
    riskId?: string | null;
    occurredAt: Date | string;
    amount: number;
    description?: string | null;
    source?: LossEventSource;
    justification?: string | null;
}

/** RQ3-6 — the predicted-vs-actual roll-up. */
export interface LossEventAggregate {
    /** Total loss across all events in scope (currency, tenant symbol). */
    total: number;
    /** Number of recorded events in scope. */
    count: number;
    /** Per-calendar-year actuals (oldest → newest), the comparison units
     *  the predicted-vs-actual overlay charts against the simulator's
     *  Mean / P90 / portfolio percentile per year. */
    byYear: Array<{ year: number; total: number; count: number }>;
    /** Per-risk roll-up — null riskId is "portfolio-attributed".
     *  Sorted by total descending. */
    byRisk: Array<{ riskId: string | null; total: number; count: number }>;
}

/**
 * Epic D.2 — sanitise free-text before persistence. Three-state
 * contract preserved: undefined (unchanged) / null (cleared) /
 * string (sanitised).
 */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return sanitizePlainText(value);
}

const MAX_TAKE = 500;

export async function listLossEvents(
    ctx: RequestContext,
    opts: { riskId?: string; take?: number; cursor?: string } = {},
): Promise<{ events: LossEventRow[]; nextCursor: string | null }> {
    assertCanRead(ctx);
    const take = Math.min(MAX_TAKE, Math.max(1, opts.take ?? 100));
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.lossEvent.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(opts.riskId ? { riskId: opts.riskId } : {}),
            },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: take + 1,
            ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
            select: {
                id: true,
                riskId: true,
                occurredAt: true,
                amount: true,
                description: true,
                source: true,
                justification: true,
                createdByUserId: true,
                createdAt: true,
                risk: { select: { id: true, title: true } },
            },
        });
        const hasMore = rows.length > take;
        const events = hasMore ? rows.slice(0, take) : rows;
        return { events, nextCursor: hasMore ? events[events.length - 1].id : null };
    });
}

/**
 * RQ3-6 — the predicted-vs-actual roll-up. Aggregated server-side
 * so the client never holds raw row volume; deleted rows excluded
 * (a soft delete is the policy answer to "the reclassification
 * supersedes the original"). Per-year buckets are the calendar
 * years actuals fall into — the simulation's "per year" reads as
 * "annualised", so calendar years are the honest comparison unit.
 */
export async function getLossEventAggregate(
    ctx: RequestContext,
    opts: { riskId?: string } = {},
): Promise<LossEventAggregate> {
    assertCanRead(ctx);
    return runInTenantReadContext(ctx, async (db) => {
        const rows = await db.lossEvent.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                ...(opts.riskId ? { riskId: opts.riskId } : {}),
            },
            select: { riskId: true, occurredAt: true, amount: true },
            take: 10000,
            orderBy: { occurredAt: 'asc' },
        });

        let total = 0;
        const yearMap = new Map<number, { year: number; total: number; count: number }>();
        const riskMap = new Map<string | null, { riskId: string | null; total: number; count: number }>();
        for (const r of rows) {
            total += r.amount;
            const y = r.occurredAt.getUTCFullYear();
            const yb = yearMap.get(y) ?? { year: y, total: 0, count: 0 };
            yb.total += r.amount;
            yb.count += 1;
            yearMap.set(y, yb);
            const rb = riskMap.get(r.riskId) ?? { riskId: r.riskId, total: 0, count: 0 };
            rb.total += r.amount;
            rb.count += 1;
            riskMap.set(r.riskId, rb);
        }
        return {
            total,
            count: rows.length,
            byYear: [...yearMap.values()].sort((a, b) => a.year - b.year),
            byRisk: [...riskMap.values()].sort((a, b) => b.total - a.total),
        };
    });
}

export async function createLossEvent(
    ctx: RequestContext,
    input: CreateLossEventInput,
): Promise<LossEventRow> {
    assertCanWrite(ctx);
    if (!Number.isFinite(input.amount) || input.amount < 0) {
        throw badRequest('amount must be a non-negative finite number');
    }
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
        throw badRequest('occurredAt must be a valid date');
    }

    const description = sanitizeOptional(input.description);
    const justification = sanitizeOptional(input.justification);

    const created = await runInTenantContext(ctx, async (db) => {
        if (input.riskId) {
            const exists = await db.risk.findFirst({
                where: { id: input.riskId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!exists) throw notFound('Risk not found');
        }
        const created = await db.lossEvent.create({
            data: {
                tenantId: ctx.tenantId,
                riskId: input.riskId ?? null,
                occurredAt,
                amount: input.amount,
                description: (description ?? null) as string | null,
                source: input.source ?? 'USER',
                justification: (justification ?? null) as string | null,
                createdByUserId: ctx.userId,
            },
            select: {
                id: true,
                riskId: true,
                occurredAt: true,
                amount: true,
                description: true,
                source: true,
                justification: true,
                createdByUserId: true,
                createdAt: true,
            },
        });
        await logEvent(db, ctx, {
            action: 'LOSS_EVENT_RECORDED',
            entityType: 'LossEvent',
            entityId: created.id,
            details: `Recorded loss event (${created.source}) of ${created.amount}`,
            detailsJson: {
                category: 'custom',
                event: 'loss_event_recorded',
                source: created.source,
                amount: created.amount,
                riskId: created.riskId,
            },
        });
        return created;
    });
    await bumpEntityCacheVersion(ctx, 'lossEvent');
    return created;
}

/** Soft delete. ADMIN-only — actuals are evidence; an EDITOR write
 *  flow must not destroy them silently. */
export async function deleteLossEvent(ctx: RequestContext, id: string): Promise<void> {
    assertCanAdmin(ctx);
    await runInTenantContext(ctx, async (db) => {
        const existing = await db.lossEvent.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, amount: true, source: true },
        });
        if (!existing) throw notFound('Loss event not found');
        await db.lossEvent.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
        await logEvent(db, ctx, {
            action: 'LOSS_EVENT_REMOVED',
            entityType: 'LossEvent',
            entityId: id,
            details: `Removed loss event (${existing.source}) of ${existing.amount}`,
            detailsJson: { category: 'custom', event: 'loss_event_removed', amount: existing.amount },
        });
    });
    await bumpEntityCacheVersion(ctx, 'lossEvent');
}
