import { z } from 'zod';
import { randomBytes, createHash } from 'crypto';
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import type { OidcConfig } from '@/app-layer/schemas/sso-config.schemas';
import { safeFetch } from '@/app-layer/automation/webhook-safety';

/**
 * Lightweight OIDC client for tenant-scoped enterprise SSO.
 *
 * This module handles:
 * - OpenID Connect Discovery (well-known endpoint)
 * - Authorization URL construction with PKCE
 * - Token exchange (authorization_code → id_token + access_token)
 * - ID token verification against the IdP's published keys (`verifyIdToken`)
 *
 * Uses `jose` for the one part that must not be hand-written: verifying the ID
 * token's signature.
 *
 * Every request to the identity provider goes through `safeFetch`, the SSRF
 * guard: https only, every resolved address public, the connection pinned to
 * the addresses checked, redirects refused. A workspace administrator types
 * the issuer, and the discovery document it serves names the token endpoint
 * and the key set, so all three URLs are chosen by somebody outside this
 * deployment; without the guard, an issuer whose document says
 * `"token_endpoint": "https://169.254.169.254/…"` turns a sign-in into a
 * request from this server to wherever it likes. A self-hosted install whose
 * identity provider is on its own network reaches it through the deployment's
 * `EGRESS_PRIVATE_CIDR_ALLOWLIST` (`@/lib/security/egress-allowlist`), which
 * no tenant can set, and inside which cloud metadata and loopback stay refused.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface OidcDiscoveryDocument {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint?: string;
    jwks_uri: string;
}

export interface OidcTokenResponse {
    id_token: string;
    access_token: string;
    token_type: string;
    expires_in?: number;
    refresh_token?: string;
}

export interface OidcUserClaims {
    sub: string;          // Subject identifier (unique per IdP)
    email?: string;
    email_verified?: boolean;
    name?: string;
    given_name?: string;
    family_name?: string;
}

export interface OidcStatePayload {
    tenantSlug: string;
    providerId: string;
    codeVerifier: string;
    nonce: string;
    returnTo?: string;
}

// ─── Discovery ───────────────────────────────────────────────────────

const discoveryCache = new Map<string, { doc: OidcDiscoveryDocument; expiresAt: number }>();

/**
 * Fetch OIDC discovery document from issuer's well-known endpoint.
 * Caches results for 1 hour.
 */
export async function discoverOidc(config: OidcConfig): Promise<OidcDiscoveryDocument> {
    const discoveryUrl = config.discoveryUrl
        ?? `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

    const cached = discoveryCache.get(discoveryUrl);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.doc;
    }

    const res = await safeFetch(discoveryUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
        throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
    }

    const doc = await res.json() as OidcDiscoveryDocument;

    // Basic validation. `jwks_uri` is required too: it is where the keys that
    // sign the ID token are published, and a sign-in that cannot reach them
    // cannot complete, so it is refused here, at the start, rather than after
    // the person has been to their identity provider and back.
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
        throw new Error('OIDC discovery document missing required fields');
    }

    discoveryCache.set(discoveryUrl, {
        doc,
        expiresAt: Date.now() + 3600_000, // 1 hour
    });

    return doc;
}

// ─── PKCE ────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

export function generateNonce(): string {
    return randomBytes(16).toString('base64url');
}

// ─── State Encoding ──────────────────────────────────────────────────

/**
 * Encode state payload as a base64url JSON string.
 * This is passed through the IdP redirect and validated on callback.
 */
export function encodeState(payload: OidcStatePayload): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeState(state: string): OidcStatePayload | null {
    try {
        const json = Buffer.from(state, 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        if (!parsed.tenantSlug || !parsed.providerId || !parsed.codeVerifier || !parsed.nonce) {
            return null;
        }
        return parsed as OidcStatePayload;
    } catch {
        return null;
    }
}

// ─── Authorization URL ───────────────────────────────────────────────

export function buildAuthorizationUrl(
    discovery: OidcDiscoveryDocument,
    config: OidcConfig,
    callbackUrl: string,
    state: string,
    codeChallenge: string,
    nonce: string
): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: callbackUrl,
        scope: config.scopes.join(' '),
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    return `${discovery.authorization_endpoint}?${params.toString()}`;
}

// ─── Token Exchange ──────────────────────────────────────────────────

export async function exchangeCodeForTokens(
    discovery: OidcDiscoveryDocument,
    config: OidcConfig,
    code: string,
    callbackUrl: string,
    codeVerifier: string
): Promise<OidcTokenResponse> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: codeVerifier,
    });

    const res = await safeFetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
        const errorBody = await res.text().catch(() => 'unknown');
        throw new Error(`OIDC token exchange failed: ${res.status} ${errorBody}`);
    }

    const tokens = await res.json() as OidcTokenResponse;

    if (!tokens.id_token) {
        throw new Error('OIDC token response missing id_token');
    }

    return tokens;
}

// ─── ID Token Verification ───────────────────────────────────────────

/**
 * The algorithms an ID token may be signed with: asymmetric ones only.
 *
 * Never `none`, and never an HMAC (`HS*`). OIDC allows an HMAC keyed with the
 * client secret, but a secret the IdP and this app share is not a key that
 * only the IdP holds, and no IdP this product supports needs it.
 */
export const ID_TOKEN_SIGNING_ALGORITHMS = [
    'RS256', 'RS384', 'RS512',
    'PS256', 'PS384', 'PS512',
    'ES256', 'ES384', 'ES512',
    'EdDSA',
] as const;

/** Clock skew tolerated between this server and the IdP, in seconds. */
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Why an ID token was refused. The callback logs it and shows the person one
 * generic message: which check failed is for the administrator, not for
 * whoever is holding the token.
 */
export type IdTokenRefusal =
    | 'malformed'
    | 'signature'
    | 'keys_unavailable'
    | 'issuer'
    | 'audience'
    | 'expired'
    | 'nonce'
    | 'claims';

export class IdTokenRefusedError extends Error {
    constructor(
        readonly reason: IdTokenRefusal,
        detail: string,
    ) {
        super(`ID token refused (${reason}): ${detail}`);
        this.name = 'IdTokenRefusedError';
    }
}

/**
 * The claims this app reads. Everything else the IdP sends is dropped, so an
 * IdP-supplied `is_admin` or `groups` never reaches a caller as something it
 * might trust.
 */
const IdTokenClaimsSchema = z.object({
    sub: z.string().min(1),
    email: z.string().email().optional(),
    email_verified: z.boolean().optional(),
    name: z.string().optional(),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
});

/**
 * One key set per `jwks_uri`. `createRemoteJWKSet` caches the keys it fetched
 * (10 minutes) and fetches again when a token names a key it does not hold, at
 * most every 30 seconds, which is how an IdP's key rotation is picked up.
 *
 * It fetches through `safeFetch` (`[customFetch]`), not its default global
 * `fetch`: the key-set URL comes from the IdP's discovery document like the
 * token endpoint does. A refusal there reaches `refusalOf` as an error that is
 * not one of jose's, so it reads as `keys_unavailable`.
 */
const signingKeysCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function signingKeysFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    let keys = signingKeysCache.get(jwksUri);
    if (!keys) {
        keys = createRemoteJWKSet(new URL(jwksUri), {
            timeoutDuration: 10_000,
            [customFetch]: (url, init) => safeFetch(url, init),
        });
        signingKeysCache.set(jwksUri, keys);
    }
    return keys;
}

function refusalOf(err: unknown): IdTokenRefusal {
    if (err instanceof joseErrors.JWTExpired) return 'expired';
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
        if (err.claim === 'iss') return 'issuer';
        if (err.claim === 'aud') return 'audience';
        if (err.claim === 'nbf') return 'expired';
        return 'claims';
    }
    if (
        err instanceof joseErrors.JWSSignatureVerificationFailed ||
        err instanceof joseErrors.JWKSNoMatchingKey ||
        err instanceof joseErrors.JWKSMultipleMatchingKeys ||
        err instanceof joseErrors.JOSEAlgNotAllowed ||
        err instanceof joseErrors.JOSENotSupported
    ) {
        return 'signature';
    }
    if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return 'malformed';
    // Anything else happened while fetching the key set: a timeout, a non-200
    // answer, a body that is not a key set, a network error.
    return 'keys_unavailable';
}

/**
 * Verify an ID token from the token endpoint, and return the claims this app
 * reads from it.
 *
 * Every check OpenID Connect Core 1.0 §3.1.3.7 lists for this flow:
 *   - the signature, by a key the IdP publishes at its `jwks_uri`, with an
 *     algorithm from `ID_TOKEN_SIGNING_ALGORITHMS`;
 *   - `iss` is exactly the issuer the discovery document names;
 *   - `aud` contains this provider's client id, and `azp`, when present (and
 *     it must be when there is more than one audience), is that client id;
 *   - `exp` has not passed and `iat` is present, with
 *     `ID_TOKEN_CLOCK_TOLERANCE_SECONDS` of skew either way;
 *   - `nonce` is the one this browser's flow sent.
 *
 * The issuer check is what keeps a provider to ONE directory. Microsoft's
 * multi-tenant endpoints (`common`, `organizations`) publish an issuer with a
 * literal `{tenantid}` placeholder, which no real token's `iss` equals, so a
 * provider configured with one of them is refused rather than accepting
 * sign-ins from every Microsoft tenant in the world.
 *
 * Throws `IdTokenRefusedError`; never returns claims it did not verify.
 */
export async function verifyIdToken(
    idToken: string,
    expected: { discovery: OidcDiscoveryDocument; clientId: string; nonce: string },
): Promise<OidcUserClaims> {
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(idToken, signingKeysFor(expected.discovery.jwks_uri), {
            algorithms: [...ID_TOKEN_SIGNING_ALGORITHMS],
            issuer: expected.discovery.issuer,
            audience: expected.clientId,
            requiredClaims: ['exp', 'iat', 'sub'],
            clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
        }));
    } catch (err) {
        throw new IdTokenRefusedError(refusalOf(err), err instanceof Error ? err.message : String(err));
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const azp = payload.azp;
    if (azp !== undefined ? azp !== expected.clientId : audiences.length > 1) {
        throw new IdTokenRefusedError('audience', 'the token was issued to another client (azp)');
    }

    if (typeof payload.nonce !== 'string' || payload.nonce !== expected.nonce) {
        throw new IdTokenRefusedError('nonce', 'the nonce is not the one this sign-in sent');
    }

    const claims = IdTokenClaimsSchema.safeParse(payload);
    if (!claims.success) {
        throw new IdTokenRefusedError('claims', claims.error.issues.map((i) => i.path.join('.')).join(', '));
    }
    return claims.data;
}

// ─── Test Helpers ────────────────────────────────────────────────────

/** @internal — exposed for testing only */
export function _clearDiscoveryCache(): void {
    discoveryCache.clear();
    signingKeysCache.clear();
}
