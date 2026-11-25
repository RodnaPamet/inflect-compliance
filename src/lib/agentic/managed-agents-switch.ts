/**
 * THE MANAGED AGENTS SWITCH, AS A REFUSAL (#5964, owner decisions 2026-11-25).
 *
 * The switch is a WORKSPACE's to decide: an owner's toggle on Admin → AI
 * features, which the operator's `AGENT_MANAGED_AGENTS` overrides when it is
 * set (`managedAgentsDecisionFor` in `agent-switches-policy.ts`, the one
 * reader). This module turns an OFF answer into the one refusal every surface
 * gives, by the same name:
 *
 *   - a new Managed Agents run (admission, in `resolveRunDefinition`);
 *   - a queued run's next segment (the worker fails it) and a person's resume
 *     of a paused one (refused, the run left as it is);
 *   - a save or a Test of the `anthropic-workspace` connection.
 *
 * OFF KEEPS THE SET-UP. Nothing here deletes a connection, changes the engine
 * choice or touches Anthropic, and the clean-ups (connection removal, the
 * tenant purge, a DSAR erasure, the session reconciliation) never ask the
 * switch: turning it back on resumes, and turning it off never strands what
 * Inflect created in the customer's workspace.
 */
import { ConflictError } from '@/lib/errors/types';

import type { WorkspaceAgentSwitchBasis, WorkspaceAgentSwitchDecision } from './agent-switches';
import { managedAgentsDecisionFor } from './agent-switches-policy';

/** The name every Managed Agents refusal carries while the switch is off. */
export const MANAGED_AGENTS_OFF = 'MANAGED_AGENTS_OFF';

/** The sentence for an OFF answer, naming who can change it. */
export function managedAgentsOffMessage(basis: WorkspaceAgentSwitchBasis): string {
    return basis === 'DEPLOYMENT_OFF'
        ? 'The Managed Agents engine is turned off for every workspace by this deployment\'s operator.'
        : 'The Managed Agents engine is turned off for this workspace. An owner turns it on under Admin, AI features.';
}

/** The refusal, for a decision that is off. */
export function managedAgentsOffError(decision: WorkspaceAgentSwitchDecision): ConflictError {
    return new ConflictError(`${MANAGED_AGENTS_OFF}: ${managedAgentsOffMessage(decision.basis)}`, {
        reason: MANAGED_AGENTS_OFF,
        basis: decision.basis,
    });
}

/** Refuse unless the Managed Agents engine is on for this workspace. */
export async function assertManagedAgentsOn(
    tenant: { readonly tenantId: string } | { readonly tenantSlug: string },
): Promise<void> {
    const decision = await managedAgentsDecisionFor(tenant);
    if (!decision.on) throw managedAgentsOffError(decision);
}
