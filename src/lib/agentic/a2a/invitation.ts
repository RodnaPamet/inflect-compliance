/**
 * The peer invitation's wire shapes (#3752; owner decisions 2026-11-11). Pure:
 * no I/O, no Prisma.
 *
 * ## The code
 *
 * One string the inviting workspace hands over: its card URL, `#`, then a
 * single-use `iflinv_` secret. The card URL is the inviter's A2A identity; the
 * fragment is never sent by an HTTP client, so pasting the whole string into a
 * browser leaks nothing to the inviter's host. The secret is stored as SHA-256
 * only, as every Inflect bearer is.
 *
 * ## The acceptance
 *
 * The accepting workspace POSTs a small JSON body to the inviter, and signs the
 * exact body bytes with ITS OWN A2A key. The inviter fetches the card the body
 * names and verifies the signature against the key that card names. So the
 * code alone is not enough: a person who intercepted it still cannot make the
 * inviter register a card whose key they do not hold, and the card the
 * acceptance names is the acceptor's own.
 *
 * Where the acceptance is sent is NOT in the code. It is read from the
 * inviter's card as the accepting person reviewed and pinned it: the card's
 * own `url` (its A2A endpoint) plus `/invitations`. A code cannot redirect the
 * acceptance, and its token, anywhere else.
 */
import { createHash, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

import { ed25519PublicKeyFromMaterial } from '@/lib/mcp/receipt-verification';

export const PEER_INVITATION_PREFIX = 'iflinv_';
export const PEER_INVITATION_ACCEPT_VERSION = 'inflect-a2a-invitation-accept/1';
/** The header carrying the acceptor's signature over the exact body bytes. */
export const PEER_INVITATION_SIGNATURE_HEADER = 'x-inflect-invitation-signature';

/** How long an invitation is good for. A code is a capability, so it expires. */
export const PEER_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How old an acceptance may be when it arrives: the signature binds the time. */
export const PEER_INVITATION_ACCEPT_MAX_AGE_MS = 5 * 60 * 1000;

const DISPLAY_PREFIX_CHARS = 14;

export function hashPeerInvitationCode(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function mintPeerInvitationCode(): { code: string; codeHash: string; codePrefix: string } {
    const code = `${PEER_INVITATION_PREFIX}${randomBytes(32).toString('base64url')}`;
    return { code, codeHash: hashPeerInvitationCode(code), codePrefix: code.slice(0, DISPLAY_PREFIX_CHARS) };
}

/** The one string handed to the other workspace. */
export function formatPeerInvitation(cardUrl: string, code: string): string {
    return `${cardUrl}#${code}`;
}

/**
 * Split a pasted invitation into the inviter's card URL and the code. `null`
 * for anything that is not exactly that shape: an https URL with no
 * credentials, and a fragment that is one `iflinv_` code and nothing else.
 */
export function parsePeerInvitation(text: string): { cardUrl: string; code: string } | null {
    const trimmed = text.trim();
    const hash = trimmed.lastIndexOf('#');
    if (hash <= 0) return null;
    const code = trimmed.slice(hash + 1);
    if (!/^iflinv_[A-Za-z0-9_-]{43}$/.test(code)) return null;
    let url: URL;
    try {
        url = new URL(trimmed.slice(0, hash));
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return { cardUrl: url.href, code };
}

/** Where an acceptance is sent: the pinned card's own endpoint, plus `/invitations`. */
export function peerInvitationAcceptUrl(cardEndpoint: string): string | null {
    let url: URL;
    try {
        url = new URL(cardEndpoint);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/invitations`;
    return url.href;
}

export const PeerInvitationAcceptBodySchema = z
    .object({
        v: z.literal(PEER_INVITATION_ACCEPT_VERSION),
        code: z.string().regex(/^iflinv_[A-Za-z0-9_-]{43}$/),
        /** The ACCEPTOR's card URL: who the inviter registers. */
        cardUrl: z.string().url().max(2048),
        /** The bearer the acceptor issued the inviter, sent verbatim back to it. */
        token: z.string().regex(/^iflp_[A-Za-z0-9_-]{20,128}$/),
        issuedAt: z.string().datetime(),
    })
    .strict();

export type PeerInvitationAcceptBody = z.infer<typeof PeerInvitationAcceptBodySchema>;

/** The acceptor's signature over the exact body bytes, Ed25519, hex. */
export function signPeerInvitationAcceptance(body: string, privateKey: KeyObject): string {
    return cryptoSign(null, Buffer.from(body, 'utf8'), privateKey).toString('hex');
}

export function verifyPeerInvitationAcceptance(body: string, signatureHex: string | null, publicKey: string): boolean {
    if (!signatureHex || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    const key = ed25519PublicKeyFromMaterial(publicKey);
    if (!key) return false;
    try {
        return cryptoVerify(null, Buffer.from(body, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
    } catch {
        return false;
    }
}

/** The inviter's answer: the bearer it issued the acceptor, nothing else. */
export const PeerInvitationAcceptAnswerSchema = z
    .object({
        v: z.literal(PEER_INVITATION_ACCEPT_VERSION),
        token: z.string().regex(/^iflp_[A-Za-z0-9_-]{20,128}$/),
    })
    .strict();
