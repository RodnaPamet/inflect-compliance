/**
 * The server half of `src/lib/access-review/scope.ts`: the refusal every path
 * that would ACT on an AGENT access review gives in a build that implements no
 * AGENT campaign (#3674, deploy 1 of 2).
 *
 * One function, called by every writer and every decide/close path, so the
 * refusal has one name and one wording. A path that forgot it would fall
 * through to whatever its `else` did with an unknown scope, and every such
 * `else` in this subsystem was written for a scope that is not AGENT: the member
 * close has no zero-subject guard, and the connected decide does not know that
 * an agent's owner may not decide their own agent.
 *
 * @module app-layer/usecases/access-review-scope-gate
 */
import { DomainError } from '@/lib/errors/types';
import {
    AGENT_CAMPAIGNS_IMPLEMENTED,
    AGENT_CAMPAIGN_REFUSAL,
} from '@/lib/access-review/scope';

export type AgentCampaignAction = 'create' | 'decide' | 'close';

/**
 * Refuse, by name. 409 rather than 400: the request is well formed, and what it
 * conflicts with is this build — a later one implements the action.
 */
export function refuseAgentCampaign(action: AgentCampaignAction): never {
    throw new DomainError(
        `${AGENT_CAMPAIGN_REFUSAL}: an access review over registered agents cannot be `
            + `${action === 'create' ? 'created' : action === 'decide' ? 'decided' : 'closed'} `
            + 'in this release. Its campaign rules — the agent\'s owner may not decide their '
            + 'own agent, a narrowing may only delete a grant — ship with the release that '
            + 'creates such campaigns.',
        'AGENT_CAMPAIGN_NOT_AVAILABLE',
        409,
    );
}

/** Refuse `action` on a campaign whose scope is AGENT, while no AGENT campaign is implemented. */
export function assertNotUnimplementedAgentCampaign(scope: string | null | undefined, action: AgentCampaignAction): void {
    if (scope === 'AGENT' && !AGENT_CAMPAIGNS_IMPLEMENTED) refuseAgentCampaign(action);
}
