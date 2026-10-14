/**
 * Agent-invoke dispatch (#3471) — the other side of the `INVOKE_AGENT` action.
 *
 * The executor enqueues; this starts the run. The split is the same one
 * `subflow-dispatcher` makes and for the same reason: a rule's action should
 * return promptly, and a run that may last an hour belongs on the worker that
 * already has the shutdown drain.
 *
 * ── EVERY REFUSAL NAMES ITS OWN CAUSE (finding F7) ──────────────────────────
 *
 * The plan asks that only an ACTIVE, scored, un-killed, un-breaker-latched
 * agent may be invoked, "refused server-side, not only hidden in the picker".
 *
 * The audit found that the unscored case currently surfaces elsewhere as an
 * autonomy ceiling of −1 rather than as a named denial, so an operator reading
 * it sees a mis-set ceiling rather than an agent nobody has risk-assessed. A
 * refusal here must therefore say which term failed, in its own words, rather
 * than relaying a number computed for a different purpose.
 *
 * ── REFUSE, DO NOT THROW ────────────────────────────────────────────────────
 *
 * A rule naming a suspended agent is a misconfigured rule, not an
 * infrastructure fault. Throwing would put the job into retry and turn one bad
 * rule into sustained queue pressure — the argument `subflow-dispatcher` makes
 * about its own depth cap.
 */
import { runJob } from '@/lib/observability/job-runner';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { resolveTenantContext } from '@/lib/tenant-context';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import type { RequestContext } from '@/app-layer/types';
import type { JobRunResult, AgentInvokeDispatchPayload } from './types';

/**
 * The trigger event's TYPED fields, projected by the mapping the rule declares.
 *
 * Never free text. A mapping names which event field feeds which input key, so
 * what reaches prompt assembly is bounded by the event's shape rather than by
 * what someone typed into a rule — and whatever does arrive is injection-scanned
 * at the door by `startWorkflowRun` (#3468), which is why that had to land
 * first.
 */
function projectInput(payload: AgentInvokeDispatchPayload): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [inputKey, eventField] of Object.entries(payload.inputMapping)) {
        if (Object.prototype.hasOwnProperty.call(payload.data, eventField)) {
            out[inputKey] = payload.data[eventField];
        }
    }
    return out;
}

/**
 * Recursion cap, mirroring `MAX_SUBFLOW_DEPTH`.
 *
 * An agent run can emit events; an event can fire a rule; a rule can invoke an
 * agent. That is a cycle with a model in it, which is more expensive per lap
 * than a sub-flow cycle and no less likely — so it is capped on the same
 * counter discipline rather than trusted not to close.
 */
export const MAX_AGENT_INVOKE_DEPTH = 5;

export type { AgentInvokeDispatchPayload } from './types';

/** Why an invoke was refused. Each value is a DIFFERENT operator action. */
export type AgentInvokeRefusal =
    | 'depth_exceeded'
    | 'rule_has_no_owner'
    | 'agent_not_found'
    | 'agent_not_active'
    | 'agent_unscored'
    | 'agent_kill_switched'
    | 'agent_breaker_latched';

export async function runAgentInvokeDispatch(
    payload: AgentInvokeDispatchPayload,
): Promise<{ result: JobRunResult; runId: string | null; refusal: AgentInvokeRefusal | null }> {
    let refusal: AgentInvokeRefusal | null = null;
    const out = await runJob('agent-invoke-dispatch', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const { tenantId, agentId, workflowKey } = payload;
        const depth = payload.depth ?? 1;

        /**
         * The job's own result row, built the way `subflow-dispatcher` builds
         * its own: a refusal is a SUCCESSFUL run that actioned nothing, not a
         * failure. `itemsSkipped` is what separates the two in the job log.
         */
        const done = (summary: string, dispatched = false): JobRunResult => ({
            jobName: 'agent-invoke-dispatch',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: 1,
            itemsActioned: dispatched ? 1 : 0,
            itemsSkipped: dispatched ? 0 : 1,
            details: { agentId, workflowKey, depth, dispatched, summary },
        });

        /**
         * ONE sink for every refusal, and the cause is a field rather than a
         * message.
         *
         * Written as a single call deliberately. Six branches each with their
         * own `logger.warn` is six places an operator has to grep and six
         * places a field can go missing; it is also six sink calls for
         * `no-raw-prompt-logging` to walk, each contributing holes for the
         * same three identifiers. `refusal` is a closed union, so the cause
         * stays machine-readable with none of that duplication.
         */
        const refuse = (why: AgentInvokeRefusal, detail?: string) => {
            refusal = why;
            logger.warn('agent-invoke: refused', {
                component: 'automation', tenantId, agentId, refusal: why, depth,
            });
            return { result: done(`Refused: ${detail ?? why}`), runId: null };
        };

        if (depth > MAX_AGENT_INVOKE_DEPTH) {
            return refuse(
                'depth_exceeded',
                `depth_exceeded (${depth} > ${MAX_AGENT_INVOKE_DEPTH})`,
            );
        }

        const agent = await prisma.registeredAgent.findFirst({
            where: { id: agentId, tenantId },
            select: { id: true, status: true, riskTier: true },
        });

        // Each branch names ITS OWN cause. Collapsing them into one
        // "agent unavailable" would hand an operator a message that does not
        // say whether to re-activate, risk-assess, or lift a kill switch.
        if (!agent) return refuse('agent_not_found');
        if (agent.status !== 'ACTIVE') return refuse('agent_not_active');
        if (agent.riskTier === null) return refuse('agent_unscored');

        if (!payload.ownerUserId) return refuse('rule_has_no_owner');

        /**
         * THE TWO RUNTIME STOPS, ASKED BEFORE THE RUN ROW EXISTS.
         *
         * `flue/execute.ts` already asks `resolveKillState` when a turn is
         * taken, so a killed agent cannot act either way. Asking here as well
         * is not redundancy for its own sake: without it an automation that
         * fires hourly mints a run per hour that can only ever refuse, and the
         * operator reading the register sees a queue of started runs rather
         * than a switch somebody engaged. The refusal is also the only place
         * the CAUSE reaches the rule's own log line.
         *
         * The breaker is the stop `execute.ts` does NOT make — `readBreakerLatch`
         * had no caller outside its own store. `OPEN` is the tripped state
         * (`latchOnGuardBlock` moves `CLOSED` -> `OPEN`); `null` is an agent the
         * breaker has never observed, which that function's docstring is
         * explicit is not a refusal.
         */
        const kill = await resolveKillState(tenantId, agentId);
        if (kill) return refuse('agent_kill_switched', `agent_kill_switched (${kill.scope})`);

        const latch = await readBreakerLatch(tenantId, agentId);
        if (latch?.state === 'OPEN') return refuse('agent_breaker_latched');

        // THE OWNER'S AUTHORITY, AND THE JOB'S ATTRIBUTION. Two separate facts
        // that `RequestContext` deliberately keeps apart: `resolveTenantContext`
        // supplies the permissions the rule's author actually holds TODAY — so a
        // rule outliving its author's role narrows with it rather than keeping a
        // snapshot — while `actorType: 'JOB'` keeps the audit trail honest. The
        // types.ts docblock is explicit that satisfying `userId` with a person
        // while writing `USER` rows made the trail "claim a person did something
        // no person did".
        const tenant = await resolveTenantContext({ tenantId }, payload.ownerUserId);
        const ctx: RequestContext = {
            requestId: `agent-invoke-${agentId}`,
            userId: payload.ownerUserId,
            actorType: 'JOB',
            tenantId,
            tenantSlug: tenant.tenant.slug,
            role: tenant.role,
            permissions: tenant.permissions,
            appPermissions: tenant.appPermissions,
            agentId,
        };

        const { startWorkflowRun } = await import('@/app-layer/usecases/workflow-runs');
        // THE CAUSE REACHES THE ROW (#3537). `parentExecutionId` has been in
        // this payload since #3471 — copied from `subflow-dispatcher`, which
        // carries it for exactly this purpose — and was read by nothing, so the
        // lineage lived in the queue and vanished when the job completed.
        const started = await startWorkflowRun(ctx, workflowKey, projectInput(payload), {
            parentExecutionId: payload.parentExecutionId,
        });
        logger.info('agent-invoke: dispatched', {
            component: 'automation', tenantId, agentId, workflowKey, depth, runId: started.runId,
        });
        return {
            result: done(`Started ${workflowKey} for agent ${agentId}`, true),
            runId: started.runId,
        };
    });
    return { ...out, refusal };
}
