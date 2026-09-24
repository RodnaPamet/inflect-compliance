/**
 * The server half of the agent driver gate: read the two switches, compose them,
 * and say which engine a run gets.
 *
 * Split from `agent-driver.ts` so that module stays free of server imports and
 * can be held by a client component rendering the admin toggle — the same split
 * `src/lib/identity/write-ladder.ts` carries for the same reason. Everything
 * here touches Prisma or `env`; everything there is pure.
 *
 * ## The absence resolves to STATIC, and that is the opposite of the register
 *
 * `isAgentRegistrationEnforced` reads a missing settings row as ENFORCING,
 * because an absent row must not be a way to switch a control off. This one
 * reads a missing row as STATIC, for exactly the same reason pointed the other
 * way: here the non-default is the thing that GRANTS, so the absence must not
 * be a way to switch a capability on.
 *
 * Both are fail-closed. They differ because "closed" means the safe end of the
 * switch, not a fixed value, and getting that backwards is how an absent row
 * becomes a bypass. Anyone adding a third flag to this table should work out
 * which direction is safe before picking a default, rather than copying
 * whichever neighbour is nearest.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { env } from '@/env';

import {
    flueEnvEnabled,
    resolveAgentDriver,
    STATIC_DRIVER,
    type AgentDriverDecision,
} from './agent-driver';
import { listWorkflowDefinitions } from './workflow-registry';

/**
 * Resolve the driver for one tenant's run.
 *
 * Never throws. A database failure resolves to `static` with the reason the
 * absent-row case would have given, and is logged at WARN: an unreadable
 * settings row must not take down a run that the static engine could have
 * executed perfectly well, and it must not silently grant the capability
 * either.
 */
export async function resolveDriverForTenant(tenantId: string): Promise<AgentDriverDecision> {
    const envEnabled = flueEnvEnabled(env.AGENT_DRIVER_FLUE);

    // Short-circuit BEFORE the query. When the operator's switch is off the
    // tenant's value cannot change the answer, so reading it would be a
    // per-run database round trip that is guaranteed not to matter — on the
    // hot path of every agentic run, for every tenant, in every deployment
    // that has not enabled this.
    if (!envEnabled) {
        return { driver: STATIC_DRIVER, reason: 'ENV_DISABLED' };
    }

    let stored: string | null = null;
    try {
        const row = await prisma.tenantSecuritySettings.findUnique({
            where: { tenantId },
            select: { agentDriver: true },
        });
        stored = row?.agentDriver ?? null;
    } catch (err) {
        logger.warn('agent-driver: settings read failed, falling back to the static engine', {
            tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
        return { driver: STATIC_DRIVER, reason: 'TENANT_NOT_OPTED_IN' };
    }

    const decision = resolveAgentDriver({ envEnabled, tenantSetting: stored });
    if (decision.driver !== 'flue') return decision;

    return narrowToWhatAWorkflowAsksFor(decision);
}

/**
 * THE FOURTH GATE, applied to a decision the first three already allowed.
 *
 * `selectRunDriver` resolves flue only when the DEFINITION asks for it —
 * `requestedDriver(def) === permitted` — so a deployment whose switches are
 * both on still runs everything on the static engine while no registered
 * `WorkflowDefinition` sets `driver`.
 *
 * EXPORTED because the two surfaces that report the driver reach it by
 * different routes, and only one of them goes through `resolveDriverForTenant`:
 * the Overview chip does (`agent-registry`), and the settings page calls
 * `resolveAgentDriver` directly (`getAgentDriverSetting`). Both were reporting
 * `flue` with `reason: null`, which this vocabulary defines as "the configured
 * driver IS in force" — a false statement on a governance surface, and exactly
 * what the reason codes exist to prevent. One helper, so a third surface
 * cannot be added without it.
 *
 * NOT folded into `resolveAgentDriver`: that function is pure over
 * {env, tenant} and has no business reading the workflow registry.
 */
export function narrowToWhatAWorkflowAsksFor(
    decision: AgentDriverDecision,
): AgentDriverDecision {
    if (decision.driver !== 'flue') return decision;
    return someWorkflowRequestsFlue()
        ? decision
        : { driver: STATIC_DRIVER, reason: 'NO_WORKFLOW_REQUESTS_IT' };
}

/**
 * Does any registered definition ask for the engine?
 *
 * Extracted so the WIRING SURFACE and the GATE are the same call rather than
 * two readings of the same registry. A surface that re-implemented this would
 * be a detector mirroring the runtime by name: correct the day it is written
 * and silently stale the day the gate's rule changes, reporting a term
 * satisfied while runs keep falling back.
 */
export function someWorkflowRequestsFlue(): boolean {
    return listWorkflowDefinitions().some((d) => d.driver === 'flue');
}

/**
 * Resolve, and emit the one log line that makes a fallback visible.
 *
 * Kept separate from the resolution so a diagnostics surface can ask the
 * question without writing a log entry — the same `evaluate` / `assert` split
 * `agent-registration-gate.ts` draws.
 *
 * The logging is not decoration. Two of the identity ladder's refusals emit a
 * metric and a log line and write no row, and the consequence recorded in
 * CLAUDE.md is that a tenant left at `DISABLED` looks identical, from inside
 * the product, to a dead worker. A driver fallback has the same shape: the run
 * still succeeds, so nothing anywhere would otherwise say that the engine the
 * operator configured is not the engine that ran.
 *
 * `DRIVER_NOT_IMPLEMENTED` is WARN rather than INFO because it is the only
 * reason of the four that means configuration is ahead of code: both switches
 * were turned on deliberately and the build cannot honour them.
 */
export async function resolveDriverForRun(
    tenantId: string,
    runContext: { requestId?: string; workflowKey?: string },
): Promise<AgentDriverDecision> {
    const decision = await resolveDriverForTenant(tenantId);

    if (decision.reason === 'DRIVER_NOT_IMPLEMENTED' || decision.reason === 'UNRECOGNISED_SETTING') {
        logger.warn('agent-driver: configured driver not used', {
            tenantId,
            requestId: runContext.requestId,
            workflowKey: runContext.workflowKey,
            driver: decision.driver,
            reason: decision.reason,
        });
    }

    return decision;
}
