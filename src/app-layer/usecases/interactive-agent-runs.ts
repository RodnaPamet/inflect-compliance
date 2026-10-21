/**
 * A PERSON IN A BROWSER STARTS AN AGENT RUN (#3868 step 2).
 *
 * The fourth starter. Until now a Flue run came from a job, an API credential
 * or an automation rule; this admits a signed-in person asking a question,
 * answered by the agent their tenant designated.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS ADDS NO AUTHORITY, WHICH IS WHAT ADR 0004 SETTLED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The run is started with the REQUESTER'S OWN CONTEXT and the agent bound —
 * `{ ...ctx, agentId }`, the seam `agent-invoke-dispatch` and agent
 * recertification already use. That is the whole of the authority story, and
 * #3868 step 1 determined by test that it is sufficient:
 *
 *   • a session is its own principal (`buildMcpInvocation` intersects with a
 *     credential's scopes only `if (keyCtx.apiKeyId)`), so there is nothing to
 *     widen it;
 *   • the propose class authorises on `basis: 'principal'`, so a READER bound
 *     to a propose-granted agent is refused while an EDITOR with the same agent
 *     is admitted;
 *   • `resolveAutonomyCeiling` takes three terms and the person's role is not
 *     one, so no role lifts a low agent ceiling.
 *
 * So no fourth narrowing term was added, and none is added here. The person's
 * permissions are one term of an intersection, never a way around it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHECKS `startWorkflowRun` DOES NOT MAKE — AND THIS IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `startWorkflowRun` checks the monthly budget, a concurrency slot, the Flue
 * gate (`standing === 'vouched'`) and the skill mounts. It does NOT check the
 * kill switch or the circuit-breaker latch. `agent-invoke-dispatch` checks both
 * ITSELF, before starting — that asymmetry is the seam's actual contract, and
 * reading `{ ...ctx, agentId }` as the whole of it is how a KILLED AGENT ends
 * up answering questions. The kill switch exists to stop an agent; a person
 * typing a question is exactly when that has to hold.
 *
 * So both are asked here, through the same functions rather than a local
 * reimplementation, and asked BEFORE the run row exists. `flue/execute.ts` asks
 * about the kill switch again per turn, which is not a reason to skip it here:
 * a refusal after the row exists leaves a RUNNING run nothing will advance —
 * "a refusal wearing the costume of an outage", in the words of the comment
 * above the Flue gate — and for an interactive run it also means a person waits
 * out a ten-second window to be told nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STANDING IS DELIBERATELY NOT RE-CHECKED HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Flue gate inside `startWorkflowRun` already refuses an agent whose
 * standing is not `vouched`, with a named reason, before the row exists. A
 * second standing check here would be two controls that can disagree about the
 * same fact, and the one that is wrong would be whichever nobody exercised.
 *
 * What IS checked here is narrower and not the gate's job: that the designation
 * names an agent **in this tenant at all**. Without it a stale or cross-tenant
 * id would be handed to `resolveKillState(tenantId, agentId)`, which would find
 * no kill row for it and pass — so the existence check is a tenant-isolation
 * control, not a duplicate of the gate.
 */
import { prisma } from '@/lib/prisma';
import { env } from '@/env';
import { flueEnvEnabled } from '@/lib/agentic/agent-driver';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import { isPersonContext } from '../request-context-kind';
import type { RequestContext } from '../types';

/**
 * Every way a browser-started run can be refused, as a NAMED code.
 *
 * Named rather than a boolean, because each one is a DIFFERENT thing for an
 * operator to do: turn the flag on, designate an agent, un-retire or re-register
 * one, lift a kill switch, reset a breaker. A single "not available" would make
 * all five look like the same outage, which is the failure mode
 * `uniform-failure-shape` describes — one error shape for every cause means the
 * logs name nothing.
 */
export const INTERACTIVE_RUN_REFUSALS = [
    /** A credential, an agent or a job tried to use the person-only path. */
    'NOT_A_PERSON',
    /** `AGENT_INTERACTIVE_RUNS` is not set on this deployment. */
    'DEPLOYMENT_NOT_ENABLED',
    /** The tenant has designated no interactive agent. */
    'NO_AGENT_DESIGNATED',
    /** The designation names an agent this tenant does not hold. */
    'AGENT_NOT_FOUND',
    /** A kill switch is in force for the designated agent. */
    'AGENT_KILL_SWITCHED',
    /** The designated agent's circuit breaker is latched OPEN. */
    'AGENT_BREAKER_LATCHED',
] as const;

export type InteractiveRunRefusal = (typeof INTERACTIVE_RUN_REFUSALS)[number];

export type InteractiveAgentResolution =
    | { readonly ok: true; readonly agentId: string }
    | { readonly ok: false; readonly refusal: InteractiveRunRefusal; readonly detail: string };

/**
 * Which agent answers for this requester, or the named reason none does.
 *
 * ── ORDER IS DELIBERATE ─────────────────────────────────────────────────────
 *
 * The caller is refused BEFORE it learns anything about the deployment or the
 * tenant: a machine caller gets `NOT_A_PERSON` and stops, rather than being
 * told whether the feature is enabled or which agent is designated. The two
 * free checks come first for that reason, not for speed.
 *
 * After that it is cheapest-first and most-specific-first, so the reason names
 * the thing an operator would actually change.
 */
export async function resolveInteractiveAgent(ctx: RequestContext): Promise<InteractiveAgentResolution> {
    // 1. WHO IS ASKING. An API key, a bound agent or a job must not reach this
    //    path: the designation is a tenant's answer to "which agent answers our
    //    PEOPLE", and a credential inheriting it would be acting as a person it
    //    is not. Asked first so a machine caller learns nothing else.
    if (!isPersonContext(ctx)) {
        return {
            ok: false,
            refusal: 'NOT_A_PERSON',
            detail:
                'A browser-started agent run is for a signed-in person. An API key, a bound agent and a ' +
                'scheduled job each have their own starter and their own authority.',
        };
    }

    // 2. THE DEPLOYMENT'S HALF. Read through `flueEnvEnabled`, so '1' and 'true'
    //    are on and anything else — including `AGENT_INTERACTIVE_RUNS=yes` — is
    //    off rather than a boot failure.
    if (!flueEnvEnabled(env.AGENT_INTERACTIVE_RUNS)) {
        return {
            ok: false,
            refusal: 'DEPLOYMENT_NOT_ENABLED',
            detail: 'AGENT_INTERACTIVE_RUNS is not enabled on this deployment.',
        };
    }

    // 3. THE TENANT'S HALF. NULL is a refusal, never a fallback: resolving to
    //    "the only ACTIVE agent" would silently change which agent answers the
    //    moment a tenant registers a second one.
    const settings = await prisma.tenantSecuritySettings.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { interactiveAgentId: true },
    });
    const agentId = settings?.interactiveAgentId ?? null;
    if (!agentId) {
        return {
            ok: false,
            refusal: 'NO_AGENT_DESIGNATED',
            detail:
                'This workspace has designated no interactive agent. Designate one on the agent register ' +
                '(admin.agent_registry); there is deliberately no default, because a default would change ' +
                'which agent answers whenever the register changes.',
        };
    }

    // 4. TENANT ISOLATION, not a duplicate of the Flue gate. A stale or
    //    cross-tenant id handed to `resolveKillState` below would find no kill
    //    row and pass. Scoped on `tenantId` for that reason, and `deletedAt`
    //    is excluded because a soft-deleted row vouches for nothing.
    //
    //    STATUS IS NOT READ HERE. The Flue gate inside `startWorkflowRun`
    //    decides standing, once, with its own named refusal — two controls over
    //    one fact would eventually disagree.
    const agent = await prisma.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
    });
    if (!agent) {
        return {
            ok: false,
            refusal: 'AGENT_NOT_FOUND',
            detail:
                `The designated interactive agent (${agentId}) is not an agent this workspace holds. The ` +
                'designation is kept rather than cleared when an agent is retired, so this is what an ' +
                'operator sees after a retirement — re-designate on the agent register.',
        };
    }

    // 5. THE KILL SWITCH, which `startWorkflowRun` does not ask about.
    const kill = await resolveKillState(ctx.tenantId, agent.id);
    if (kill) {
        return {
            ok: false,
            refusal: 'AGENT_KILL_SWITCHED',
            detail: `A kill switch is in force for the designated agent (scope: ${kill.scope}).`,
        };
    }

    // 6. THE BREAKER LATCH, which it does not ask about either. `OPEN` is the
    //    tripped state; `null` is an agent the breaker has never observed,
    //    which is not a refusal.
    const latch = await readBreakerLatch(ctx.tenantId, agent.id);
    if (latch?.state === 'OPEN') {
        return {
            ok: false,
            refusal: 'AGENT_BREAKER_LATCHED',
            detail: "The designated agent's circuit breaker is latched OPEN and must be reset.",
        };
    }

    return { ok: true, agentId: agent.id };
}

/**
 * The context a browser-started run executes under.
 *
 * `{ ...ctx, agentId }` — the requester's own context with the agent bound, and
 * NOTHING ELSE CHANGED. Three things it deliberately does not do:
 *
 *   • it does not touch `role`, `permissions` or `appPermissions`. They are the
 *     asker's, which is what makes the invariant hold;
 *   • it does not set `actorType: 'JOB'`. A job writes that so the audit trail
 *     does not claim a person did something no person did; here a person DID,
 *     so the trail carries the person AND the agent, and neither field
 *     substitutes for the other;
 *   • it does not set `apiKeyId`. A session has no credential, and inventing
 *     one would start the permission intersection that step 1 proved a session
 *     does not run.
 */
export function interactiveRunContext(ctx: RequestContext, agentId: string): RequestContext {
    return { ...ctx, agentId };
}
