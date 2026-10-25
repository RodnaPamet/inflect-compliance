/**
 * START THE AUDITOR AGENT'S NARRATIVE RUN, ONCE A DAY PER TENANT (#3749,
 * owner decision 4: "a job starts one run after each period's procedures have
 * run, with its own schedule entry and outcome metric").
 *
 * For each tenant it picks ONE period: the one holding the oldest workpaper
 * that has no narrative, whose period has ended, and which was written at least
 * `NARRATIVE_SETTLE_HOURS` ago (so a period's other procedures have run too).
 * It then starts one `audit-narrative` run for that period, as the auditor
 * agent that wrote the workpaper, with that agent's owner's permissions:
 *
 *   ctx = { userId: the agent's owner, actorType: 'JOB', agentId: the auditor,
 *           permissions: what the owner holds TODAY }      (agent-invoke-dispatch)
 *
 * so a run never reads more than the person accountable for the auditor could.
 * The run's narratives are stored by the capture when it settles
 * (`usecases/audit-workpaper-narrative.ts`); this job writes nothing itself.
 *
 * ── EVERY REFUSAL NAMES ITS CAUSE ───────────────────────────────────────────
 *
 * Each tenant's outcome is a closed union, counted by
 * `recordAuditNarrativeDispatch` and logged by name. The causes are distinct
 * operator actions — risk-assess the agent, grant it the read tool, give its
 * owner the view key, lift a kill — so none is folded into another, and a
 * tenant with nothing to narrate is told apart from one that could not be
 * dispatched.
 *
 * ── AT MOST ONE RUN PER TENANT PER DAY ──────────────────────────────────────
 *
 * A tenant that started a narrative run in the last `NARRATIVE_RUN_SPACING_HOURS`
 * is skipped, whoever started it, so a retry of this job or a second scheduler
 * cannot start a second one. A period with more workpapers than one answer
 * carries is narrated over several days: each run skips what is narrated.
 *
 * ── ONLY WHERE A NARRATIVE CAN BE WRITTEN ───────────────────────────────────
 *
 * The narrative is the Flue engine's answer; a static run reads and writes no
 * narrative. So a tenant whose runs resolve to the static engine is refused
 * `engine_not_flue` rather than given a daily run that can only ever narrate
 * nothing.
 */
import type { PrismaClient } from '@prisma/client';

import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { recordAuditNarrativeDispatch } from '@/lib/observability/integration-metrics';
import { resolveTenantContext } from '@/lib/tenant-context';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { selectRunDriver } from '@/lib/agentic/drivers';
import { isReasoningEngine } from '@/lib/agentic/agent-driver';
import { periodBounds } from '@/lib/agentic/audit-workpaper';
import { auditNarrativeWorkflow } from '@/lib/agentic/workflows/audit-narrative';
import type { RequestContext } from '../types';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import type { AuditNarrativeDispatchPayload, JobRunResult } from './types';

const MS_PER_HOUR = 60 * 60 * 1000;

/** How long a workpaper waits before it is narrated, so its period's other procedures have run. */
export const NARRATIVE_SETTLE_HOURS = 24;

/** A tenant that started a narrative run within this many hours is not started again. */
export const NARRATIVE_RUN_SPACING_HOURS = 20;

/** The read tool the run cannot work without; an auditor not granted it is refused. */
export const NARRATIVE_READ_TOOL = 'list_audit_workpapers';

export type NarrativeDispatchOutcome =
    | 'dispatched'
    /** A narrative run was started for this tenant within the spacing window. */
    | 'already_ran_today'
    /** The tenant's runs resolve to the static engine, which writes no narrative. */
    | 'engine_not_flue'
    /** The workpaper's auditor is not in the register. */
    | 'auditor_not_found'
    | 'auditor_not_active'
    /** Never risk-assessed. */
    | 'auditor_unscored'
    /** Not granted `list_audit_workpapers`. */
    | 'tool_not_granted'
    | 'auditor_kill_switched'
    | 'auditor_breaker_latched'
    /** The owner holds neither `audits.workpaper_view` nor `audits.manage`, or is no longer a member. */
    | 'owner_cannot_read_workpapers'
    | 'error';

export interface TenantDispatch {
    readonly tenantId: string;
    readonly outcome: NarrativeDispatchOutcome;
    readonly periodLabel: string;
    readonly agentId: string;
    readonly runId: string | null;
}

export interface AuditNarrativeDispatchResult {
    /** Workpapers with no narrative, of an ended period, old enough — read this run. */
    readonly candidates: number;
    /** One entry per tenant that had a candidate, with what became of it. */
    readonly tenants: readonly TenantDispatch[];
    readonly dispatched: number;
}

export interface AuditNarrativeDispatchOptions {
    /** Scope to one tenant. Omitted = system-wide, which is how it is scheduled. */
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
}

interface Candidate {
    id: string;
    tenantId: string;
    periodLabel: string;
    auditorAgentId: string;
    createdAt: Date;
}

/** Each tenant's oldest candidate — the period, and the auditor that wrote it. */
function firstPerTenant(candidates: readonly Candidate[], now: Date): Map<string, Candidate> {
    const first = new Map<string, Candidate>();
    for (const c of candidates) {
        if (periodBounds(c.periodLabel).end.getTime() > now.getTime()) continue;
        const held = first.get(c.tenantId);
        if (!held || c.createdAt.getTime() < held.createdAt.getTime()) first.set(c.tenantId, c);
    }
    return first;
}

export async function runAuditNarrativeDispatch(
    db: PrismaClient,
    options: AuditNarrativeDispatchOptions = {},
): Promise<AuditNarrativeDispatchResult> {
    const now = options.now ?? new Date();
    const tenantScope = options.tenantId ? { tenantId: options.tenantId } : {};

    // ── 1. Everything the decision reads, once each, grouped in memory. ──
    const candidates = await drainPages((cursor) =>
        db.auditWorkpaper.findMany({
            where: {
                ...tenantScope,
                createdAt: { lte: new Date(now.getTime() - NARRATIVE_SETTLE_HOURS * MS_PER_HOUR) },
                narratives: { none: {} },
            },
            select: { id: true, tenantId: true, periodLabel: true, auditorAgentId: true, createdAt: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );
    const chosen = firstPerTenant(candidates, now);
    const tenantIds = [...chosen.keys()];
    const agentIds = [...new Set([...chosen.values()].map((c) => c.auditorAgentId))];

    const [agents, grants, recentRuns] = tenantIds.length === 0
        ? [[], [], []]
        : await Promise.all([
              db.registeredAgent.findMany({
                  where: { id: { in: agentIds }, tenantId: { in: tenantIds }, deletedAt: null },
                  select: { id: true, tenantId: true, status: true, riskTier: true, ownerUserId: true },
                  take: agentIds.length,
              }),
              db.registeredAgentTool.findMany({
                  where: { agentId: { in: agentIds }, tenantId: { in: tenantIds }, toolName: NARRATIVE_READ_TOOL },
                  select: { agentId: true, tenantId: true },
                  take: agentIds.length,
              }),
              db.workflowRun.findMany({
                  where: {
                      tenantId: { in: tenantIds },
                      workflowKey: auditNarrativeWorkflow.key,
                      createdAt: { gte: new Date(now.getTime() - NARRATIVE_RUN_SPACING_HOURS * MS_PER_HOUR) },
                  },
                  select: { tenantId: true },
                  // One is enough to skip a tenant; a tenant holds at most a few.
                  take: tenantIds.length * 4,
              }),
          ]);
    const agentById = new Map(agents.map((a) => [`${a.tenantId}|${a.id}`, a]));
    const granted = new Set(grants.map((g) => `${g.tenantId}|${g.agentId}`));
    const ranRecently = new Set(recentRuns.map((r) => r.tenantId));

    // ── 2. One decision, and at most one run, per tenant. ──
    const tenants: TenantDispatch[] = [];
    for (const [tenantId, c] of chosen) {
        const decide = async (): Promise<{ outcome: NarrativeDispatchOutcome; runId: string | null }> => {
            if (ranRecently.has(tenantId)) return { outcome: 'already_ran_today', runId: null };

            const agent = agentById.get(`${tenantId}|${c.auditorAgentId}`);
            if (!agent) return { outcome: 'auditor_not_found', runId: null };
            if (agent.status !== 'ACTIVE') return { outcome: 'auditor_not_active', runId: null };
            if (agent.riskTier === null) return { outcome: 'auditor_unscored', runId: null };
            if (!granted.has(`${tenantId}|${agent.id}`)) return { outcome: 'tool_not_granted', runId: null };

            const decision = await resolveDriverForRun(tenantId, { workflowKey: auditNarrativeWorkflow.key });
            if (!isReasoningEngine(selectRunDriver(auditNarrativeWorkflow, decision.driver).driver)) {
                return { outcome: 'engine_not_flue', runId: null };
            }
            if (await resolveKillState(tenantId, agent.id)) return { outcome: 'auditor_kill_switched', runId: null };
            if ((await readBreakerLatch(tenantId, agent.id))?.state === 'OPEN') {
                return { outcome: 'auditor_breaker_latched', runId: null };
            }

            // THE OWNER'S AUTHORITY TODAY, and the job's attribution: the same
            // two facts `agent-invoke-dispatch` keeps apart.
            let tenant: Awaited<ReturnType<typeof resolveTenantContext>>;
            try {
                tenant = await resolveTenantContext({ tenantId }, agent.ownerUserId);
            } catch {
                return { outcome: 'owner_cannot_read_workpapers', runId: null };
            }
            const audits = tenant.appPermissions.audits;
            if (audits.workpaper_view !== true && audits.manage !== true) {
                return { outcome: 'owner_cannot_read_workpapers', runId: null };
            }
            const ctx: RequestContext = {
                requestId: `audit-narrative-dispatch-${tenantId}-${c.periodLabel}`,
                userId: agent.ownerUserId,
                actorType: 'JOB',
                tenantId,
                tenantSlug: tenant.tenant.slug,
                role: tenant.role,
                permissions: tenant.permissions,
                appPermissions: tenant.appPermissions,
                agentId: agent.id,
            };
            const { startWorkflowRun } = await import('@/app-layer/usecases/workflow-runs');
            const started = await startWorkflowRun(ctx, auditNarrativeWorkflow.key, { periodLabel: c.periodLabel });
            return { outcome: 'dispatched', runId: started.runId };
        };

        let decided: { outcome: NarrativeDispatchOutcome; runId: string | null };
        try {
            decided = await decide();
        } catch (err) {
            logger.warn('audit-narrative-dispatch: tenant failed; the next run retries it', {
                component: 'audit-narrative-dispatch',
                tenantId,
                error: err instanceof Error ? err.name : 'unknown',
            });
            decided = { outcome: 'error', runId: null };
        }
        recordAuditNarrativeDispatch({ outcome: decided.outcome });
        if (decided.outcome !== 'dispatched') {
            logger.info('audit-narrative-dispatch: not dispatched', {
                component: 'audit-narrative-dispatch',
                tenantId,
                agentId: c.auditorAgentId,
                outcome: decided.outcome,
            });
        }
        tenants.push({ tenantId, outcome: decided.outcome, periodLabel: c.periodLabel, agentId: c.auditorAgentId, runId: decided.runId });
    }

    // A run that found nothing to narrate anywhere says so, rather than
    // recording nothing — "nothing to do" and "never ran" must differ.
    if (tenants.length === 0) recordAuditNarrativeDispatch({ outcome: 'nothing_to_narrate' });

    return { candidates: candidates.length, tenants, dispatched: tenants.filter((t) => t.outcome === 'dispatched').length };
}

/** BullMQ executor body. A tenant that could not be dispatched is `itemsSkipped`, by name in `details`. */
export async function runAuditNarrativeDispatchJob(payload: AuditNarrativeDispatchPayload): Promise<JobRunResult> {
    return runJob(
        'audit-narrative-dispatch',
        async () => {
            const startedAt = new Date().toISOString();
            const startMs = performance.now();
            const { prisma } = await import('@/lib/prisma');
            const r = await runAuditNarrativeDispatch(prisma, { tenantId: payload.tenantId });
            const byOutcome: Record<string, number> = {};
            for (const t of r.tenants) byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
            return {
                jobName: 'audit-narrative-dispatch',
                jobRunId: crypto.randomUUID(),
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: r.candidates,
                itemsActioned: r.dispatched,
                itemsSkipped: r.tenants.length - r.dispatched,
                details: { tenants: r.tenants.length, dispatched: r.dispatched, byOutcome },
            };
        },
        { tenantId: payload.tenantId },
    );
}
