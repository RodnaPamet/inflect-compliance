/**
 * The inbound A2A bearer a peer presents (#3679; threat-model R5, I2 S).
 *
 * Its own prefix, `iflp_`, and deliberately not `iflk_`: the edge lets an
 * `iflk_` bearer on `/api/t/**` fall through to `verifyApiKey`
 * (`matchTenantApiKeyRequest`), and that carve-out also skips the admin-role and
 * MFA gates. A peer credential must never be mistaken for a tenant API key by
 * that recogniser or by the key verifier, so it is not one, by construction.
 *
 * Stored as SHA-256 only, as `TenantApiKey.keyHash` is; compared in constant
 * time. Pure: no I/O.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PEER_INBOUND_TOKEN_PREFIX = 'iflp_';

/** Characters of the token kept in the clear, for an operator to recognise it. */
const DISPLAY_PREFIX_CHARS = 12;

export function hashPeerInboundToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function mintPeerInboundToken(): { token: string; keyHash: string; keyPrefix: string } {
    const token = `${PEER_INBOUND_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    return { token, keyHash: hashPeerInboundToken(token), keyPrefix: token.slice(0, DISPLAY_PREFIX_CHARS) };
}

/** The bearer from an `Authorization` header, only when it carries this prefix. */
export function peerBearerFrom(authorization: string | null | undefined): string | null {
    if (!authorization) return null;
    const m = /^Bearer\s+(\S+)$/.exec(authorization.trim());
    if (!m || !m[1].startsWith(PEER_INBOUND_TOKEN_PREFIX) || m[1].length > 256) return null;
    return m[1];
}

/** Constant-time comparison of a presented token with a stored hash. */
export function peerTokenMatches(token: string, storedHash: string): boolean {
    const a = Buffer.from(hashPeerInboundToken(token), 'hex');
    const b = Buffer.from(/^[0-9a-f]{64}$/.test(storedHash) ? storedHash : '0'.repeat(64), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}
