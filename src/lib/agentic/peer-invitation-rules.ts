/**
 * Who may invite an A2A peer, or accept an invitation (#3752, #5764).
 *
 * A pure rule that ANSWERS rather than throws, so it is not a gate itself. The
 * gate is `assertMayInvite` in `usecases/peer-invitations.ts`, which keeps its
 * own register-key check (so `tests/unit/agent-registry-view-key.test.ts` still
 * calls every invitation usecase as a view-only principal) and then throws on
 * this rule's answer. The peers page asks the same rule on the server to decide
 * whether to offer Invite and Accept, so the page cannot offer what the usecase
 * refuses; `tests/unit/peer-invitation-affordance.test.ts` holds the two equal.
 */
import type { RequestContext } from '@/app-layer/types';

export type PeerInvitationActorRefusal = 'NO_REGISTER_KEY' | 'NOT_A_PERSON' | 'NEEDS_ADMIN';

/** Why `ctx` may not invite or accept, or `null` when it may. */
export function peerInvitationRefusal(
    ctx: Pick<RequestContext, 'appPermissions' | 'apiKeyId' | 'permissions'>,
): PeerInvitationActorRefusal | null {
    const { appPermissions, apiKeyId, permissions } = ctx;
    if (!appPermissions?.admin?.agent_registry) return 'NO_REGISTER_KEY';
    if (apiKeyId) return 'NOT_A_PERSON';
    // The flow also stores an outbound connection, which `upsertIntegrationConnection`
    // gates on the coarse admin tier. Asked first, so nothing is half-written.
    // An AI admin holds the register key but not that tier.
    if (!permissions?.canAdmin) return 'NEEDS_ADMIN';
    return null;
}
