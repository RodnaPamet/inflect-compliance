/**
 * The A2A peer invitation's wire shapes (#3752; owner decisions 2026-11-11),
 * pure: the code, where an acceptance goes, and the acceptance signature.
 */
import { generateKeyPairSync } from 'node:crypto';

import {
    PEER_INVITATION_ACCEPT_VERSION,
    PeerInvitationAcceptBodySchema,
    formatPeerInvitation,
    hashPeerInvitationCode,
    mintPeerInvitationCode,
    parsePeerInvitation,
    peerInvitationAcceptUrl,
    signPeerInvitationAcceptance,
    verifyPeerInvitationAcceptance,
} from '@/lib/agentic/a2a/invitation';

const CARD = 'https://inflect.example/api/a2a/acme/agent-card.json';

describe('the code', () => {
    it('is single-shape, hashed for storage, and round-trips through the one string handed over', () => {
        const minted = mintPeerInvitationCode();
        expect(minted.code).toMatch(/^iflinv_[A-Za-z0-9_-]{43}$/);
        expect(minted.codeHash).toBe(hashPeerInvitationCode(minted.code));
        expect(minted.codeHash).not.toContain(minted.code);
        expect(minted.code.startsWith(minted.codePrefix)).toBe(true);
        expect(minted.codePrefix.length).toBeLessThan(minted.code.length);
        expect(parsePeerInvitation(`  ${formatPeerInvitation(CARD, minted.code)}\n`)).toEqual({ cardUrl: CARD, code: minted.code });
        expect(mintPeerInvitationCode().code).not.toBe(minted.code);
    });

    it('refuses anything that is not exactly a public https card URL and one code', () => {
        const { code } = mintPeerInvitationCode();
        for (const text of [
            code,
            `http://inflect.example/x#${code}`,
            `https://user:pw@inflect.example/x#${code}`,
            `${CARD}#${code}x`,
            `${CARD}#iflk_${'a'.repeat(43)}`,
            `${CARD}#`,
            `not a url#${code}`,
            '',
        ]) {
            expect(parsePeerInvitation(text)).toBeNull();
        }
    });
});

describe('where an acceptance goes', () => {
    it("is the pinned card's own endpoint plus /invitations, never anything else", () => {
        expect(peerInvitationAcceptUrl('https://inflect.example/api/a2a/acme')).toBe('https://inflect.example/api/a2a/acme/invitations');
        expect(peerInvitationAcceptUrl('https://inflect.example/api/a2a/acme/?x=1#y')).toBe(
            'https://inflect.example/api/a2a/acme/invitations',
        );
        expect(peerInvitationAcceptUrl('http://inflect.example/api/a2a/acme')).toBeNull();
        expect(peerInvitationAcceptUrl('https://u:p@inflect.example/a')).toBeNull();
        expect(peerInvitationAcceptUrl('nonsense')).toBeNull();
    });
});

describe('the acceptance signature', () => {
    const pair = () => {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        return { privateKey, publicHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
    };
    const body = JSON.stringify({
        v: PEER_INVITATION_ACCEPT_VERSION,
        code: mintPeerInvitationCode().code,
        cardUrl: CARD,
        token: `iflp_${'t'.repeat(40)}`,
        issuedAt: new Date().toISOString(),
    });

    it('verifies over the exact bytes under the signer key, and under no other key or bytes', () => {
        const signer = pair();
        const other = pair();
        const sig = signPeerInvitationAcceptance(body, signer.privateKey);
        expect(verifyPeerInvitationAcceptance(body, sig, signer.publicHex)).toBe(true);
        expect(verifyPeerInvitationAcceptance(body, sig, other.publicHex)).toBe(false);
        expect(verifyPeerInvitationAcceptance(`${body} `, sig, signer.publicHex)).toBe(false);
        expect(verifyPeerInvitationAcceptance(body, null, signer.publicHex)).toBe(false);
        expect(verifyPeerInvitationAcceptance(body, 'zz', signer.publicHex)).toBe(false);
        expect(verifyPeerInvitationAcceptance(body, sig, 'not a key')).toBe(false);
    });

    it('the body is strict: an extra member, another version or a non-iflp token is refused', () => {
        const parsed = JSON.parse(body);
        expect(PeerInvitationAcceptBodySchema.safeParse(parsed).success).toBe(true);
        expect(PeerInvitationAcceptBodySchema.safeParse({ ...parsed, extra: 1 }).success).toBe(false);
        expect(PeerInvitationAcceptBodySchema.safeParse({ ...parsed, v: 'other/1' }).success).toBe(false);
        expect(PeerInvitationAcceptBodySchema.safeParse({ ...parsed, token: `iflk_${'t'.repeat(40)}` }).success).toBe(false);
    });
});
