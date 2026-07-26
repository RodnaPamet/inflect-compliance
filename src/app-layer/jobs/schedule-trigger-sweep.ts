/**
 * Scheduled-trigger sweep (PR-E).
 *
 * The single Archer-parity time/schedule trigger. A rule with
 * `triggerEvent = 'SCHEDULE'` carries a `scheduleConfigJson`
 * `{ kind: 'DATE_RELATIVE', target, offsetDays }`. This daily sweep finds
 * every target entity whose due date is `offsetDays` away (plus a small
 * catch-up window for missed runs) and enqueues a targeted
 * `automation-event-dispatch` so the rule's action fires per entity
 * (`triggeredBy: 'schedule'`). A deterministic `stableKey` keyed on the
 * entity's OWN due-day makes a re-run — or a catch-up re-scan —
 * idempotent: one execution per (rule, entity, due-day).
 *
 * Targets are ALLOWLISTED (entity → model + date field) so a rule config can
 * never schedule a scan of an arbitrary table/column.
 *
 * Fault isolation: a per-(tenant, target) query failure, a per-rule
 * processing failure, or a per-entity enqueue failure are each contained —
 * one failing rule/tenant never aborts the rest of the sweep.
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import type { JobRunResult } from './types';
import { enqueue } from './queue';

export type ScheduleTarget = 'Evidence' | 'ControlException' | 'ControlTestPlan';

export const SCHEDULE_TARGETS: Record<ScheduleTarget, { dateField: string }> = {
    Evidence: { dateField: 'retentionUntil' },
    ControlException: { dateField: 'expiresAt' },
    ControlTestPlan: { dateField: 'nextDueAt' },
};

export interface ScheduleConfig {
    kind: 'DATE_RELATIVE';
    target: ScheduleTarget;
    offsetDays: number;
}

/** Validate + narrow a raw scheduleConfigJson. Returns null if unusable. */
export function parseScheduleConfig(raw: unknown): ScheduleConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    if (c.kind !== 'DATE_RELATIVE') return null;
    if (typeof c.target !== 'string' || !(c.target in SCHEDULE_TARGETS)) return null;
    if (typeof c.offsetDays !== 'number' || c.offsetDays < 0 || c.offsetDays > 365) return null;
    return { kind: 'DATE_RELATIVE', target: c.target as ScheduleTarget, offsetDays: c.offsetDays };
}

const DAY_MS = 86_400_000;

/**
 * Catch-up horizon (days). The sweep fires triggers whose due date lands on
 * the offset day AND on any of the previous `CATCH_UP_DAYS` days, so a missed
 * daily run does not permanently skip that day's triggers. Bounded on purpose
 * — we never scan unbounded history. Re-fires are deduped at the dispatch
 * layer by the per-(rule, entity, due-day) `stableKey`.
 */
const CATCH_UP_DAYS = 3;

/** Per-(tenant, target) query cap. */
const GROUP_QUERY_TAKE = 2000;

/** Pure — the UTC day window that is `offsetDays` from `now`. A target whose
 * date falls in [gte, lt) is due to fire today. */
export function dueWindow(now: Date, offsetDays: number): { gte: Date; lt: Date } {
    const t = now.getTime() + offsetDays * DAY_MS;
    const start = new Date(t);
    start.setUTCHours(0, 0, 0, 0);
    return { gte: start, lt: new Date(start.getTime() + DAY_MS) };
}

/**
 * Pure — the catch-up window: the offset day AND the prior `catchUpDays`
 * days. `lt` is the end of the offset day (we never fire triggers whose due
 * date has not yet reached the offset); `gte` reaches back `catchUpDays` to
 * pick up any triggers a missed daily run skipped.
 */
export function catchUpWindow(
    now: Date,
    offsetDays: number,
    catchUpDays = CATCH_UP_DAYS,
): { gte: Date; lt: Date } {
    const top = dueWindow(now, offsetDays);
    return { gte: new Date(top.gte.getTime() - catchUpDays * DAY_MS), lt: top.lt };
}

interface ScheduleRuleEntry {
    ruleId: string;
    offsetDays: number;
    win: { gte: Date; lt: Date };
}

interface QueryGroup {
    target: ScheduleTarget;
    tenantId: string;
    field: string;
    /** Union of every rule window in the group (one batched query per group). */
    gte: Date;
    lt: Date;
    rules: ScheduleRuleEntry[];
}

/**
 * Query an allowlisted target's due entities for a single (tenant, target)
 * group over the union window (tenant-scoped, bounded). The `tenantId` filter
 * keeps the query single-tenant, so callers bucket rows to rules by date
 * alone — no cross-tenant leak is possible.
 */
async function queryGroupEntities(
    g: QueryGroup,
): Promise<Array<{ id: string; due: Date | null }>> {
    const where = { tenantId: g.tenantId, [g.field]: { gte: g.gte, lt: g.lt } };
    const select = { id: true, [g.field]: true };
    let rows: Array<Record<string, unknown>>;
    switch (g.target) {
        case 'Evidence':
            rows = await prisma.evidence.findMany({ where, select, take: GROUP_QUERY_TAKE });
            break;
        case 'ControlException':
            rows = await prisma.controlException.findMany({ where, select, take: GROUP_QUERY_TAKE });
            break;
        case 'ControlTestPlan':
            rows = await prisma.controlTestPlan.findMany({ where, select, take: GROUP_QUERY_TAKE });
            break;
    }
    if (rows.length === GROUP_QUERY_TAKE) {
        logger.warn('schedule-trigger-sweep: group query hit take cap — some due entities may be dropped this tick', {
            component: 'schedule-trigger-sweep',
            target: g.target,
            tenantId: g.tenantId,
            cap: GROUP_QUERY_TAKE,
        });
    }
    return rows.map((r) => ({ id: r.id as string, due: (r[g.field] as Date | null) ?? null }));
}

export async function runScheduleTriggerSweep(
    now: Date,
): Promise<{ result: JobRunResult; firedCount: number }> {
    return runJob('schedule-trigger-sweep', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();

        const rules = await prisma.automationRule.findMany({
            where: { triggerEvent: 'SCHEDULE', status: 'ENABLED', deletedAt: null },
            select: { id: true, tenantId: true, scheduleConfigJson: true },
            take: 2000,
        });

        // ── Group rules by (target, tenantId) so we issue ONE batched query
        //    per group instead of one query per rule (was an N+1). The union
        //    window covers every rule in the group; each rule then buckets the
        //    result by its own catch-up window in memory.
        const groups = new Map<string, QueryGroup>();
        for (const rule of rules) {
            const cfg = parseScheduleConfig(rule.scheduleConfigJson);
            if (!cfg) continue;
            const win = catchUpWindow(now, cfg.offsetDays);
            const key = `${cfg.target}::${rule.tenantId}`;
            let g = groups.get(key);
            if (!g) {
                g = {
                    target: cfg.target,
                    tenantId: rule.tenantId,
                    field: SCHEDULE_TARGETS[cfg.target].dateField,
                    gte: win.gte,
                    lt: win.lt,
                    rules: [],
                };
                groups.set(key, g);
            } else {
                if (win.gte.getTime() < g.gte.getTime()) g.gte = win.gte;
                if (win.lt.getTime() > g.lt.getTime()) g.lt = win.lt;
            }
            g.rules.push({ ruleId: rule.id, offsetDays: cfg.offsetDays, win });
        }

        // ── One batched query per group, run in parallel. `allSettled` so a
        //    single tenant/target DB failure does not abort the whole sweep.
        const groupList = [...groups.values()];
        const settledQueries = await Promise.allSettled(
            groupList.map((g) => queryGroupEntities(g)),
        );

        // ── Build the enqueue tasks with per-rule fault isolation.
        const enqueueTasks: Array<Promise<unknown>> = [];
        for (let gi = 0; gi < groupList.length; gi++) {
            const g = groupList[gi];
            const q = settledQueries[gi];
            if (q.status === 'rejected') {
                logger.error('schedule-trigger-sweep: group query failed — skipping its rules this tick', {
                    component: 'schedule-trigger-sweep',
                    target: g.target,
                    tenantId: g.tenantId,
                    err: q.reason instanceof Error ? q.reason : new Error(String(q.reason)),
                });
                continue;
            }
            const rows = q.value;
            for (const r of g.rules) {
                try {
                    for (const entity of rows) {
                        if (!entity.due) continue;
                        const t = entity.due.getTime();
                        if (t < r.win.gte.getTime() || t >= r.win.lt.getTime()) continue;
                        // Key the idempotency token on the ENTITY's own due-day
                        // (not the sweep day) so a catch-up re-scan on a later
                        // day cannot double-fire the same (rule, entity).
                        const dueDayKey = entity.due.toISOString().slice(0, 10);
                        enqueueTasks.push(
                            enqueue('automation-event-dispatch', {
                                tenantId: g.tenantId,
                                event: {
                                    event: 'SCHEDULE',
                                    tenantId: g.tenantId,
                                    entityType: g.target,
                                    entityId: entity.id,
                                    actorUserId: null,
                                    emittedAt: now.toISOString(),
                                    stableKey: `sched-${r.ruleId}-${entity.id}-${dueDayKey}`,
                                    data: {
                                        target: g.target,
                                        dueAt: entity.due.toISOString(),
                                        offsetDays: r.offsetDays,
                                    },
                                },
                                targetRuleId: r.ruleId,
                                triggeredBy: 'schedule',
                            }),
                        );
                    }
                } catch (err) {
                    // One rule's processing failure must not abort the rest.
                    logger.error('schedule-trigger-sweep: rule processing failed', {
                        component: 'schedule-trigger-sweep',
                        ruleId: r.ruleId,
                        tenantId: g.tenantId,
                        err: err instanceof Error ? err : new Error(String(err)),
                    });
                }
            }
        }

        // ── Batch the enqueues with per-item isolation. A failed enqueue for
        //    one entity must not lose the others.
        let firedCount = 0;
        let enqueueFailures = 0;
        const settled = await Promise.allSettled(enqueueTasks);
        for (const s of settled) {
            if (s.status === 'fulfilled') {
                firedCount++;
            } else {
                enqueueFailures++;
                logger.error('schedule-trigger-sweep: enqueue failed', {
                    component: 'schedule-trigger-sweep',
                    err: s.reason instanceof Error ? s.reason : new Error(String(s.reason)),
                });
            }
        }

        const result: JobRunResult = {
            jobName: 'schedule-trigger-sweep',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: rules.length,
            itemsActioned: firedCount,
            itemsSkipped: enqueueFailures,
            details: { rules: rules.length, fired: firedCount, enqueueFailures },
        };
        return { result, firedCount };
    });
}
