/**
 * The server half of `src/lib/access-review/scope.ts`: the two refusals a path
 * gives when it would ACT on an AGENT access review it was not written for
 * (#3674).
 *
 * ── The generic paths refuse AGENT, always ──────────────────────────────
 *
 * The member close, the connected decide and the connected close were written
 * for scopes that are not AGENT: the member close has no zero-subject guard,
 * and the connected decide does not know that an agent's owner may not decide
 * their own agent, that a subject waits for its narrowings, or that a pack must
 * exist first. An AGENT campaign is decided and closed by
 * `usecases/access-review-agent.ts`, and the routes dispatch there; these
 * paths refusing AGENT by name is the backstop for a caller that does not —
 * `AGENT_CAMPAIGN_OWN_FLOW`, 409.
 *
 * ── The brake ────────────────────────────────────────────────────────────
 *
 * `AGENT_CAMPAIGNS_IMPLEMENTED` was false in deploy 1 and is true from deploy
 * 2. The agent flow asserts it at every act (create, prepare, decide, close),
 * so setting it back to false — a one-line reviewed diff somebody can ship in
 * a hurry — stops every AGENT campaign act with `AGENT_CAMPAIGN_NOT_AVAILABLE`
 * while every reader keeps reading the rows. The generic paths give that same
 * refusal while the brake is on, so the wording a caller meets does not depend
 * on which door they tried.
 *
 * @module app-layer/usecases/access-review-scope-gate
 */
import { DomainError } from '@/lib/errors/types';
import {
    AGENT_CAMPAIGNS_IMPLEMENTED,
    AGENT_CAMPAIGN_OWN_FLOW,
    AGENT_CAMPAIGN_REFUSAL,
} from '@/lib/access-review/scope';

export type AgentCampaignAction = 'create' | 'prepare' | 'decide' | 'close';

function verb(action: AgentCampaignAction): string {
    switch (action) {
        case 'create': return 'created';
        case 'prepare': return 'prepared';
        case 'decide': return 'decided';
        case 'close': return 'closed';
    }
}

/**
 * The brake's refusal, by name. 409 rather than 400: the request is well
 * formed, and what it conflicts with is this build.
 */
export function refuseAgentCampaign(action: AgentCampaignAction): never {
    throw new DomainError(
        `${AGENT_CAMPAIGN_REFUSAL}: an access review over registered agents cannot be `
            + `${verb(action)} in this release.`,
        'AGENT_CAMPAIGN_NOT_AVAILABLE',
        409,
    );
}

/** The agent flow's own check of the brake, at every act. */
export function assertAgentCampaignsAvailable(action: AgentCampaignAction): void {
    if (!AGENT_CAMPAIGNS_IMPLEMENTED) refuseAgentCampaign(action);
}

/**
 * A generic (member or connected) path refuses an AGENT campaign, by name.
 *
 * Called by every path that decides or closes a campaign without knowing the
 * agent rules. Never a fall-through: each of those paths' `else` was written
 * for a scope that is not AGENT.
 */
export function assertNotAgentCampaign(scope: string | null | undefined, action: AgentCampaignAction): void {
    if (scope !== 'AGENT') return;
    if (!AGENT_CAMPAIGNS_IMPLEMENTED) refuseAgentCampaign(action);
    throw new DomainError(
        `${AGENT_CAMPAIGN_OWN_FLOW}: an access review over registered agents is ${verb(action)} `
            + 'through the agent campaign flow, which holds rules this path does not — the '
            + 'agent\'s owner may not decide their own agent, a subject waits for its narrowings, '
            + 'and a narrowing may only delete a grant.',
        'AGENT_CAMPAIGN_OWN_FLOW',
        409,
    );
}
