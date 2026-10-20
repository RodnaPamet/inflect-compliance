import crypto from 'node:crypto';

import { flueEnvEnabled } from '@/lib/agentic/agent-driver';

/**
 * Credentials and gating for a HOST CONSUMER — a host that calls Inflect as a
 * CLIENT rather than as a peer agent (#3861, ADR 0003).
 *
 * Nothing here touches the peer path. A peer authenticates with an `iflp_`
 * credential and a signed Ed25519 receipt; a host consumer has neither, and the
 * separation is the whole point of admitting it as its own principal rather
 * than as a `PeerAgent` with the receipt waived.
 */

/**
 * The client id's prefix, as `iflk_` is for an API key and `iflp_` for a peer
 * credential. A distinct prefix so a credential found in a log or a support
 * ticket says which kind it is without a lookup.
 */
export const HOST_CONSUMER_CLIENT_PREFIX = 'ifhc_';

/** 24 bytes of entropy, hex-encoded, as `generateApiKey` uses. */
const SECRET_RANDOM_BYTES = 24;
const CLIENT_ID_RANDOM_BYTES = 12;
/** Enough of the secret to tell two apart in a list, and no more. */
const SECRET_PREFIX_DISPLAY_LENGTH = 8;

export interface HostConsumerCredentials {
    /** Public. Travels in the token request and onto every evidence row. */
    readonly clientId: string;
    /** Shown ONCE at creation and never stored. */
    readonly secretPlaintext: string;
    /** SHA-256 hex of the secret — what the row holds. */
    readonly secretHash: string;
    /** The leading characters, for display. */
    readonly secretPrefix: string;
}

/**
 * Mint a client id and secret.
 *
 * SHA-256 rather than a password hash for the same reason `hashApiKey` gives:
 * the secret is 24 random bytes, so there is no dictionary to stretch against.
 */
export function generateHostConsumerCredentials(): HostConsumerCredentials {
    const clientId = `${HOST_CONSUMER_CLIENT_PREFIX}${crypto.randomBytes(CLIENT_ID_RANDOM_BYTES).toString('hex')}`;
    const secretPlaintext = crypto.randomBytes(SECRET_RANDOM_BYTES).toString('hex');
    return {
        clientId,
        secretPlaintext,
        secretHash: hashHostConsumerSecret(secretPlaintext),
        secretPrefix: secretPlaintext.slice(0, SECRET_PREFIX_DISPLAY_LENGTH),
    };
}

/** SHA-256 hex. The only form the database ever sees. */
export function hashHostConsumerSecret(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Compare a presented secret against a stored hash in constant time.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak, so
 * the hashes are compared — both are always 64 hex characters, whatever the
 * presented secret was.
 */
export function hostConsumerSecretMatches(presented: string, storedHash: string): boolean {
    const a = Buffer.from(hashHostConsumerSecret(presented), 'utf8');
    const b = Buffer.from(storedHash, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * BOTH gates, in one place, so no call site can satisfy one and forget the
 * other.
 *
 * The deployment flag crosses a deployment; the tenant column crosses a tenant.
 * One deployment serving tenants that have decided differently about admitting
 * a third-party host is the normal case, and the tenant's decision is the one
 * that carries the weaker receipt guarantee (ADR 0003), so neither alone is
 * enough.
 *
 * Takes the raw env value rather than reading `env` itself, so a test can state
 * both terms and a reader can see there are exactly two.
 */
export function hostConsumersAdmitted(opts: {
    readonly envValue: string | null | undefined;
    readonly tenantEnabled: boolean | null | undefined;
}): boolean {
    return flueEnvEnabled(opts.envValue) && opts.tenantEnabled === true;
}
