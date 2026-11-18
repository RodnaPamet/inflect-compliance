/**
 * Who may invite an A2A peer or accept an invitation (#3752), asked once
 * (#5764). The peers page offers Invite and Accept from `peerInvitationRefusal`,
 * and the usecase throws on the same answer, so the page cannot offer what the
 * server refuses. An AI admin holds the register key, which opens the page, but
 * not the coarse admin tier the flow's outbound connection needs.
 */
import { createPeerInvitation, peerInvitationRefusal, previewPeerInvitation } from '@/app-layer/usecases/peer-invitations';
import { makeRequestContext } from '../helpers/make-context';

describe('peerInvitationRefusal', () => {
    it('takes an Owner and an Admin', () => {
        expect(peerInvitationRefusal(makeRequestContext('OWNER'))).toBeNull();
        expect(peerInvitationRefusal(makeRequestContext('ADMIN'))).toBeNull();
    });

    it('refuses an AI admin, who holds the register key but not the admin tier', () => {
        const ctx = makeRequestContext('AI_ADMIN');
        expect(ctx.appPermissions.admin.agent_registry).toBe(true);
        expect(peerInvitationRefusal(ctx)).toBe('NEEDS_ADMIN');
    });

    it('refuses a role without the register key, and an API key', () => {
        expect(peerInvitationRefusal(makeRequestContext('EDITOR'))).toBe('NO_REGISTER_KEY');
        expect(peerInvitationRefusal(makeRequestContext('ADMIN', { apiKeyId: 'key_1' }))).toBe('NOT_A_PERSON');
    });

    it('is the rule the usecase throws on, before it reads anything', async () => {
        const ai = makeRequestContext('AI_ADMIN');
        await expect(createPeerInvitation(ai, {})).rejects.toMatchObject({
            status: 403,
            details: { reason: 'NEEDS_ADMIN' },
        });
        await expect(previewPeerInvitation(ai, {})).rejects.toMatchObject({
            status: 403,
            details: { reason: 'NEEDS_ADMIN' },
        });
    });
});
