import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

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

// ─── The access token ─────────────────────────────────────────────────────
//
// A short-lived signed JWT, not a stored opaque token. Owner decision,
// 2026-10-20, recorded in ADR 0003.
//
// Why stateless is acceptable here, and it rests on ONE property: admission
// re-reads the consumer's status, `revokedAt` and its kill switch UNCACHED on
// every single request. So revoking or killing a consumer stops its live tokens
// immediately, which is the thing a stored-token table would otherwise buy. The
// `jti` is still recorded on every evidence row, so a call can be attributed to
// the exact token that made it even though the token itself is not kept.
//
// What this does NOT give us, stated so nobody has to infer it: there is no way
// to revoke ONE token while leaving the consumer live, and no enumeration of
// outstanding tokens. If either is ever needed, the change is a table, not a
// patch here.

/** HS256. The secret is deployment-wide and lives only in the environment. */
const TOKEN_ALGORITHM = 'HS256' as const;

/**
 * Fifteen minutes.
 *
 * Short because the only revocation is at the consumer, so a token's lifetime
 * is the window in which a leaked one is useful. Not shorter, because SAP's
 * destination caches the token and a very short TTL turns one question into a
 * token request per turn. J5's pilot is what should confirm this against
 * Joule's real behaviour rather than my arithmetic.
 */
export const HOST_CONSUMER_TOKEN_TTL_SECONDS = 15 * 60;

export const HOST_CONSUMER_TOKEN_ISSUER = 'inflect-a2a-host-consumer';

/** The claims a verified token yields. Narrow on purpose. */
export interface HostConsumerTokenClaims {
    readonly tenantId: string;
    readonly hostConsumerId: string;
    readonly receivingAgentId: string;
    readonly workflowKeys: readonly string[];
    readonly jti: string;
}

export type HostConsumerTokenRefusal =
    /** The deployment holds no signing secret — fail closed, never unsigned. */
    | 'TOKEN_SECRET_NOT_CONFIGURED'
    | 'TOKEN_MALFORMED'
    | 'TOKEN_EXPIRED'
    | 'TOKEN_BAD_SIGNATURE'
    | 'TOKEN_WRONG_ISSUER'
    | 'TOKEN_CLAIMS_INCOMPLETE';

export type HostConsumerTokenVerdict =
    | { readonly ok: true; readonly claims: HostConsumerTokenClaims }
    | { readonly ok: false; readonly reason: HostConsumerTokenRefusal };

/**
 * Mint a token, or refuse because the deployment cannot sign one.
 *
 * REFUSES rather than falling back, for the reason `resolveFlueModel` gives:
 * an unsigned or weakly-signed bearer is worse than no integration, and a
 * caller that silently got one would have no way to know.
 */
export function mintHostConsumerToken(
    claims: Omit<HostConsumerTokenClaims, 'jti'>,
    opts: { readonly secret: string | null | undefined; readonly nowMs?: number },
): { readonly ok: true; readonly token: string; readonly jti: string; readonly expiresInSeconds: number } | { readonly ok: false; readonly reason: 'TOKEN_SECRET_NOT_CONFIGURED' } {
    if (!opts.secret) return { ok: false, reason: 'TOKEN_SECRET_NOT_CONFIGURED' };
    const jti = crypto.randomUUID();
    const iat = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const token = jwt.sign(
        {
            tenantId: claims.tenantId,
            hostConsumerId: claims.hostConsumerId,
            receivingAgentId: claims.receivingAgentId,
            workflowKeys: [...claims.workflowKeys],
            jti,
            iat,
            exp: iat + HOST_CONSUMER_TOKEN_TTL_SECONDS,
            iss: HOST_CONSUMER_TOKEN_ISSUER,
        },
        opts.secret,
        { algorithm: TOKEN_ALGORITHM },
    );
    return { ok: true, token, jti, expiresInSeconds: HOST_CONSUMER_TOKEN_TTL_SECONDS };
}

/**
 * Verify a presented bearer and return its claims, or a named refusal.
 *
 * `algorithms` is pinned to HS256, and the honest note is that NO TEST HERE
 * PROVES IT. Removing the pin leaves all 26 tests green — measured, not
 * assumed, by removing it.
 *
 * The reason is that the pin's classic target does not apply to us. The
 * algorithm-confusion attack needs a server verifying with a PUBLIC key, so an
 * attacker can switch RS256 to HS256 and sign with that public key as the HMAC
 * secret. This verify holds a symmetric secret only, and `jsonwebtoken` already
 * refuses an unsigned token whenever a secret is supplied — so `alg: none` is
 * refused with or without the pin, and the `alg: none` test below passes for
 * that reason rather than because of the pin.
 *
 * The pin stays: it is correct, it costs nothing, and it keeps this verify
 * correct if the key ever becomes asymmetric. But it is HYGIENE WITH NO
 * BEHAVIOURAL GUARD, and saying so is better than a comment implying a test
 * stands behind it. If the key ever does become asymmetric, that is the moment
 * to add the RS256-to-HS256 test, which would then discriminate.
 */
export function verifyHostConsumerToken(
    presented: string,
    opts: { readonly secret: string | null | undefined; readonly nowMs?: number },
): HostConsumerTokenVerdict {
    if (!opts.secret) return { ok: false, reason: 'TOKEN_SECRET_NOT_CONFIGURED' };
    let decoded: unknown;
    try {
        decoded = jwt.verify(presented, opts.secret, {
            algorithms: [TOKEN_ALGORITHM],
            issuer: HOST_CONSUMER_TOKEN_ISSUER,
            clockTimestamp: opts.nowMs === undefined ? undefined : Math.floor(opts.nowMs / 1000),
        });
    } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const message = err instanceof Error ? err.message : '';
        if (name === 'TokenExpiredError') return { ok: false, reason: 'TOKEN_EXPIRED' };
        if (message.includes('jwt issuer invalid')) return { ok: false, reason: 'TOKEN_WRONG_ISSUER' };
        if (name === 'JsonWebTokenError' && message.includes('signature')) {
            return { ok: false, reason: 'TOKEN_BAD_SIGNATURE' };
        }
        return { ok: false, reason: 'TOKEN_MALFORMED' };
    }
    if (typeof decoded !== 'object' || decoded === null) return { ok: false, reason: 'TOKEN_MALFORMED' };
    const c = decoded as Record<string, unknown>;
    const strings = ['tenantId', 'hostConsumerId', 'receivingAgentId', 'jti'] as const;
    if (strings.some((k) => typeof c[k] !== 'string' || (c[k] as string).length === 0)) {
        return { ok: false, reason: 'TOKEN_CLAIMS_INCOMPLETE' };
    }
    if (!Array.isArray(c.workflowKeys) || c.workflowKeys.some((k) => typeof k !== 'string')) {
        return { ok: false, reason: 'TOKEN_CLAIMS_INCOMPLETE' };
    }
    return {
        ok: true,
        claims: {
            tenantId: c.tenantId as string,
            hostConsumerId: c.hostConsumerId as string,
            receivingAgentId: c.receivingAgentId as string,
            workflowKeys: c.workflowKeys as string[],
            jti: c.jti as string,
        },
    };
}
