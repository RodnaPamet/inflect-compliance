/**
 * Reading an agent's behavioural circuit breaker, and closing it.
 *
 * The breaker itself is written at the MCP tool boundary — see
 * `src/lib/agentic/circuit-breaker-store.ts`. This file is the HUMAN side: the
 * operator surface's read, and the one action that can un-trip an agent.
 *
 * ## Nothing here trips a breaker, and nothing anywhere closes one on its own
 *
 * There is no half-open probe and no timeout. Both are auto-recovery, and an
 * agent that has gone rogue can wait one out — an automatic close would turn the
 * control into a delay. The close is a named human, through
 * `requirePermission('admin.agent_registry')`, and it is audited: the whole value
 * of a manual un-trip is that somebody's name is against it, which is why the
 * database CHECK refuses a closed row that does not carry an actor and a reason.
 *
 * ## The reason is load-bearing, not a comment field
 *
 * `ACCEPTED_NEW_BASELINE` and `RESOLVED` do different things, and collapsing
 * them is how a breaker becomes a rubber stamp:
 *
 *   ACCEPTED_NEW_BASELINE — "yes, I changed this agent." The old history is
 *       DISCARDED (the epoch advances) and the agent re-learns from zero,
 *       reporting `NO_BASELINE` until it has twelve active windows again. This
 *       is the false-positive escape hatch, and it is the reason an operator who
 *       deliberately widened an agent has something to do other than switch the
 *       control off.
 *   RESOLVED — "I fixed the agent." The old baseline is KEPT, because it is what
 *       the agent should return to. Re-baselining here would silently adopt the
 *       rogue behaviour as normal, which is the failure the whole design is
 *       arranged against.
 *
 * Which is why `recordAgentBreakerClose` labels the counter by reason: a
 * deployment where every trip is answered with "that's fine now" has a detector
 * calibrated to fire on ordinary work, and that is the shape this control dies
 * of. It is measured rather than assumed.
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    BASELINE_WINDOW_LIMIT,
    BREAKER_CLOSE_REASONS,
    MIN_BASELINE_OBSERVATIONS,
    MIN_BASELINE_WINDOWS,
    WINDOWS_TO_TRIP,
    type BreakerCloseReason,
} from '@/lib/agentic/circuit-breaker';
import { recordAgentBreakerClose } from '@/lib/observability/integration-metrics';

import { assertCanAdmin, assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';

/** How many recent windows the operator surface shows. */
const WINDOW_PAGE = 48;

/**
 * The breaker's state, its recent history, and the constants it judges by.
 *
 * The thresholds are returned rather than duplicated in the client, for the
 * reason `write-ladder.ts` exists: a number copied into whatever renders it
 * agrees with the detector only by coincidence, and the identity subsystem has
 * already paid for that once with a rung a route went on offering after the
 * ladder dropped it.
 */
export async function getAgentCircuitBreaker(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, riskTier: true },
        });
        if (!agent) throw notFound('Agent not found');

        const breaker = await db.agentCircuitBreaker.findUnique({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            select: {
                state: true,
                lastVerdict: true,
                lastVerdictAt: true,
                lastEvaluatedWindow: true,
                anomalousStreak: true,
                streakSignals: true,
                trippedAt: true,
                trippedWindow: true,
                trippedSignals: true,
                baselineEpoch: true,
                closedAt: true,
                closedByUserId: true,
                closeReason: true,
            },
        });

        const windows = await db.agentBehaviourWindow.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            orderBy: { windowStart: 'desc' },
            take: WINDOW_PAGE,
            select: {
                windowStart: true,
                readCalls: true,
                proposeCalls: true,
                orchestrateCalls: true,
                toolNames: true,
                anomalous: true,
                verdict: true,
            },
        });

        // Counted over the ACCEPTED history only — the same population the
        // detector judges against — so the surface's "12 of 12 windows" agrees
        // with the verdict rather than with a bigger, friendlier number.
        const accepted = windows.filter(
            (w) => !w.anomalous && (breaker === null || w.windowStart >= breaker.baselineEpoch),
        );

        return {
            agentId: agent.id,
            agentName: agent.name,
            riskTier: agent.riskTier,
            // `null` is NOT "closed". It is "this agent has never been observed",
            // which is a third state an operator has to be able to see: a page
            // showing CLOSED for an agent nothing has ever watched is the
            // reassurance-shaped failure this whole subsystem is arranged
            // against.
            breaker,
            windows,
            baseline: {
                windows: accepted.length,
                observations: accepted.reduce(
                    (t, w) => t + w.readCalls + w.proposeCalls + w.orchestrateCalls,
                    0,
                ),
                requiredWindows: MIN_BASELINE_WINDOWS,
                requiredObservations: MIN_BASELINE_OBSERVATIONS,
                lookbackWindows: BASELINE_WINDOW_LIMIT,
            },
            windowsToTrip: WINDOWS_TO_TRIP,
            closeReasons: [...BREAKER_CLOSE_REASONS],
        };
    });
}

/**
 * Close a tripped breaker. The only thing that un-trips an agent.
 *
 * `assertCanAdmin` in addition to the route's `requirePermission`, and the
 * duplication is deliberate: the route gate is what writes the hash-chained
 * `AUTHZ_DENIED` row on refusal, and the usecase gate is what stops a future
 * caller reaching this function from somewhere that has no route in front of it.
 */
export async function closeAgentCircuitBreaker(
    ctx: RequestContext,
    agentId: string,
    reason: BreakerCloseReason,
) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const breaker = await db.agentCircuitBreaker.findUnique({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            select: { state: true, trippedSignals: true, trippedWindow: true },
        });
        if (!breaker) throw notFound('This agent has no circuit breaker');
        if (breaker.state !== 'OPEN') {
            // Not a no-op returning success. "It was already closed" and "you
            // closed it" are different facts, and an idempotent-looking success
            // here would put a name and a reason into the audit trail against a
            // decision nobody made.
            throw badRequest('This agent’s circuit breaker is not open');
        }

        const now = new Date();
        const reBaseline = reason === 'ACCEPTED_NEW_BASELINE';

        await db.agentCircuitBreaker.update({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            data: {
                state: 'CLOSED',
                closedAt: now,
                closedByUserId: ctx.userId,
                closeReason: reason,
                // The streak is cleared either way: whatever the operator
                // decided, the agent does not resume two-thirds of the way to
                // its next trip.
                anomalousStreak: 0,
                streakSignals: [],
                // Advanced ONLY on an accepted change. On RESOLVED the old
                // baseline is the thing the agent should be measured against.
                ...(reBaseline ? { baselineEpoch: now, lastEvaluatedWindow: null } : {}),
            },
        });

        // Named field by field rather than spread. A spread puts whatever the
        // row happens to carry into permanent, hash-chained evidence — and the
        // signal codes are the only part of a trip that is safe to write there.
        await logEvent(db, ctx, {
            action: 'AGENT_CIRCUIT_BREAKER_CLOSED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'access',
                entityName: 'AgentCircuitBreaker',
                operation: 'close',
                // The agent id is `entityId` on this row already; repeating it
                // into prose buys nothing and costs one more value the
                // `no-raw-prompt-logging` rule cannot resolve.
                summary:
                    `Closed the behavioural circuit breaker as ${reason}` +
                    (reBaseline
                        ? '; the prior baseline was discarded and the agent re-learns'
                        : '; the prior baseline was kept'),
                closeReason: reason,
                rebaselined: reBaseline,
                trippedWindow: breaker.trippedWindow,
                trippedSignals: breaker.trippedSignals,
            },
        });

        recordAgentBreakerClose({
            agentId,
            reason: reBaseline ? 'accepted_new_baseline' : 'resolved',
        });

        return { agentId, state: 'CLOSED' as const, closeReason: reason, rebaselined: reBaseline };
    });
}
