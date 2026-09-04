/**
 * RFC 8693 token exchange — short-lived, AUDIENCE-SCOPED credentials for MCP.
 *
 * ## The gap
 *
 * `TenantApiKey` is a long-lived bearer credential with no notion of what it is
 * FOR. A key minted so an agent could call `list_risks` is, byte for byte, a key
 * that calls `propose_controls`, reads every MCP resource, and works against any
 * MCP server that trusts this tenant's keys. Ambient authority with no audience
 * is the confused deputy's supply line: whatever the agent is talked into doing,
 * the credential in its hand is already sufficient for.
 *
 * ## The exchange
 *
 * `POST /api/mcp/token` takes the long-lived key as an RFC 8693 SUBJECT TOKEN
 * and returns a short-lived ACCESS TOKEN scoped to a named audience — a set of
 * tool names, or the resources surface. The funnel then refuses that token at
 * anything outside its audience. Minted for X, rejected at Y, ENFORCED at the
 * tool boundary rather than recorded in a log nobody reads.
 *
 * ## Four properties, and how each is made true rather than asserted
 *
 *   1. AUDIENCE-BOUND. The audience is inside the signed payload, so it cannot
 *      be edited by the holder, and `authorizeToolCall` compares the tool it is
 *      about to run against it. Requested audiences are ALSO intersected with
 *      the agent's tool grants at mint time, so exchange can never widen what
 *      deny-by-default exposure already allows — narrowing composes, and a token
 *      for a tool the agent was never granted is refused at issue rather than
 *      issued and refused later.
 *
 *   2. SERVER-BOUND. `res` pins the issuing server (`urn:inflect:mcp`). A token
 *      is not replayable against another MCP server even if that server shares
 *      this signing key, because it checks the field.
 *
 *   3. SHORT-LIVED, ON AN INJECTED CLOCK. Every expiry comparison in this module
 *      and in the funnel reads a `now()` the caller supplies. Real time is the
 *      default and is passed in exactly one place. A test can therefore prove an
 *      expiry without sleeping — and, more to the point, a test that CANNOT
 *      control the clock quietly stops testing the expiry at all.
 *
 *   4. NO UPSTREAM TOKEN IS EVER FORWARDED. `mintExchangedToken` does not take a
 *      token. It takes ids. It is structurally unable to embed, echo or forward
 *      the subject token, because it never receives one — the route verifies the
 *      subject token and passes what it LEARNED, not what it was given. The
 *      alternative (pass the key through and let the minter decide) is how a
 *      credential ends up copied into a payload that travels further than it.
 *
 * ## Why stateless, when a token table was the obvious alternative
 *
 * A row per token would give revocation for free. It is not needed: the token
 * names its issuing `TenantApiKey`, and per-key revocation is checked at every
 * tool boundary anyway (see `authorize.ts`), so a table would add a second
 * revocation mechanism answering a question the first already answers on the
 * same request. What it WOULD add is a tenant-scoped model, its RLS policies, a
 * retention classification and a growth surface for tokens that expire in
 * minutes. The signature and the injected clock carry the rest.
 *
 * ## Secrets
 *
 * The signing key is HKDF-derived from the master KEK (`deriveSubkey`) under its
 * own purpose string, so it is independent of the field-encryption and
 * lookup-hash keys and is never stored anywhere. Nothing reversible about a
 * token is persisted — there is no token at rest to encrypt.
 */
import crypto from 'crypto';

import { deriveSubkey } from '@/lib/security/encryption';
import { badRequest, unauthorized } from '@/lib/errors/types';

/** Distinguishable at a glance from `iflk_`, and never a valid API key. */
export const MCP_EXCHANGED_TOKEN_PREFIX = 'ifxt_';

/**
 * This MCP server's identifier, the RFC 8693 `resource`. A token carrying a
 * different value is refused even under a valid signature — which is what makes
 * "not replayable against another server" a check rather than a hope.
 */
export const MCP_SERVER_RESOURCE = 'urn:inflect:mcp';

/**
 * The audience value naming the MCP RESOURCES surface (`resources/list`,
 * `resources/read`). Resources have no entries in the grantable tool catalogue,
 * so they need a name of their own for a token to be scoped to — or away from —
 * them. A token minted for `list_risks` cannot read resources, and one minted
 * for resources cannot call a tool.
 */
export const MCP_RESOURCES_AUDIENCE = 'mcp:resources';

export const DEFAULT_TOKEN_TTL_SECONDS = 300;
export const MAX_TOKEN_TTL_SECONDS = 900;
export const MAX_AUDIENCE_ENTRIES = 32;

/** RFC 8693 §2.1 / §3 constants, spelled once. */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

const SIGNING_PURPOSE = 'inflect-mcp-token-exchange-v1';
const PAYLOAD_VERSION = 1;

/** Injected clock. Real time enters this module through this default only. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/**
 * The signed payload. Short keys because this travels in an Authorization
 * header on every tool call; long enough to be unambiguous when decoded.
 */
interface TokenPayload {
    /** Payload version — lets a future shape be distinguished, not guessed. */
    v: number;
    /** Tenant. */
    tid: string;
    /** The issuing `TenantApiKey.id` — what revocation is checked against. */
    kid: string;
    /** The registered agent, when the credential named a live ACTIVE one. */
    aid: string | null;
    /** Audience: tool names, and/or `mcp:resources`. Non-empty. */
    aud: string[];
    /** The MCP server this token is for. */
    res: string;
    /** Issued-at / expiry, epoch seconds. */
    iat: number;
    exp: number;
    /** Uniqueness, so two tokens minted in the same second differ. */
    jti: string;
}

export interface ExchangedTokenClaims {
    tenantId: string;
    apiKeyId: string;
    agentId: string | null;
    audience: readonly string[];
    issuedAt: Date;
    expiresAt: Date;
    tokenId: string;
}

export interface MintExchangedTokenInput {
    tenantId: string;
    /** The `TenantApiKey.id` the subject token resolved to — NOT the token. */
    apiKeyId: string;
    agentId: string | null;
    audience: readonly string[];
    ttlSeconds?: number;
    now?: Clock;
}

export interface MintedToken {
    token: string;
    expiresAt: Date;
    expiresInSeconds: number;
    audience: readonly string[];
}

function signingKey(): Buffer {
    return deriveSubkey(SIGNING_PURPOSE);
}

function b64u(buf: Buffer): string {
    return buf.toString('base64url');
}

function sign(encodedPayload: string): string {
    return b64u(crypto.createHmac('sha256', signingKey()).update(encodedPayload).digest());
}

/**
 * Mint a short-lived, audience-scoped token.
 *
 * Takes NO token — see property 4 in the header. Every field of the result is
 * derived from ids the caller has already verified, so nothing about the
 * long-lived credential can travel inside the short-lived one.
 */
export function mintExchangedToken(input: MintExchangedTokenInput): MintedToken {
    const audience = [...new Set(input.audience)];
    if (audience.length === 0) {
        throw badRequest('A token must name at least one audience.');
    }
    if (audience.length > MAX_AUDIENCE_ENTRIES) {
        throw badRequest(
            `A token may name at most ${MAX_AUDIENCE_ENTRIES} audiences.`,
        );
    }

    const ttl = input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TOKEN_TTL_SECONDS) {
        throw badRequest(
            `Token lifetime must be a whole number of seconds between 1 and ${MAX_TOKEN_TTL_SECONDS}.`,
        );
    }

    const issued = (input.now ?? systemClock)();
    const iat = Math.floor(issued.getTime() / 1000);
    const payload: TokenPayload = {
        v: PAYLOAD_VERSION,
        tid: input.tenantId,
        kid: input.apiKeyId,
        aid: input.agentId,
        aud: audience,
        res: MCP_SERVER_RESOURCE,
        iat,
        exp: iat + ttl,
        jti: crypto.randomBytes(9).toString('base64url'),
    };

    const encoded = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
    return {
        token: `${MCP_EXCHANGED_TOKEN_PREFIX}${encoded}.${sign(encoded)}`,
        expiresAt: new Date(payload.exp * 1000),
        expiresInSeconds: ttl,
        audience,
    };
}

/** Is this bearer token an exchanged token rather than a raw API key? */
export function isExchangedToken(token: string): boolean {
    return token.startsWith(MCP_EXCHANGED_TOKEN_PREFIX);
}

/**
 * Verify an exchanged token and return its claims.
 *
 * Throws `unauthorized` for every failure — a bad signature, a foreign server,
 * an unknown payload version, a malformed body and an expired token are ONE
 * outward answer, because distinguishing them for the holder is free
 * intelligence about the format. The reason is available to the caller through
 * the thrown message only in the coarse form below.
 *
 * The clock is injected. There is no `Date.now()` in this function.
 */
export function verifyExchangedToken(
    token: string,
    options: { now?: Clock } = {},
): ExchangedTokenClaims {
    const reject = (): never => {
        throw unauthorized('MCP token is invalid or has expired.');
    };

    if (!isExchangedToken(token)) reject();
    const body = token.slice(MCP_EXCHANGED_TOKEN_PREFIX.length);
    const dot = body.indexOf('.');
    if (dot <= 0 || dot === body.length - 1) reject();

    const encoded = body.slice(0, dot);
    const provided = body.slice(dot + 1);
    const expected = sign(encoded);

    // Constant-time, and length-checked first because `timingSafeEqual` throws
    // on a length mismatch rather than returning false.
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) reject();

    let payload: TokenPayload;
    try {
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        return reject();
    }

    if (payload?.v !== PAYLOAD_VERSION) reject();
    if (payload.res !== MCP_SERVER_RESOURCE) reject();
    if (typeof payload.tid !== 'string' || payload.tid.length === 0) reject();
    if (typeof payload.kid !== 'string' || payload.kid.length === 0) reject();
    if (!Array.isArray(payload.aud) || payload.aud.length === 0) reject();
    if (!payload.aud.every((a2) => typeof a2 === 'string' && a2.length > 0)) reject();
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) reject();

    const now = (options.now ?? systemClock)();
    if (!isTokenLive(new Date(payload.exp * 1000), now)) reject();

    return {
        tenantId: payload.tid,
        apiKeyId: payload.kid,
        agentId: payload.aid ?? null,
        audience: payload.aud,
        issuedAt: new Date(payload.iat * 1000),
        expiresAt: new Date(payload.exp * 1000),
        tokenId: payload.jti,
    };
}

/**
 * Is a token still live at `now`? Exported because the funnel re-asks it at
 * EVERY tool boundary, not only at authentication: a workflow run resolves its
 * invocation once and then executes many steps, so a token that expires
 * mid-run has to stop the next step rather than ride out the run.
 *
 * Expiry is exclusive at the boundary — a token whose `exp` equals `now` is
 * spent. The alternative admits one extra call at exactly the wrong second.
 */
export function isTokenLive(expiresAt: Date | null, now: Date): boolean {
    if (expiresAt === null) return true;
    return expiresAt.getTime() > now.getTime();
}

/**
 * Does a token's audience cover this target?
 *
 * There is no wildcard and there is deliberately no "empty means all": an empty
 * audience is refused at mint. A caller holding a raw API key has NO audience at
 * all, which is a different state (`null`) that the funnel handles separately —
 * see `authorize.ts`. Collapsing "no audience" into "every audience" here is
 * exactly the shape that turns an allowlist into a formality.
 */
export function audienceCovers(audience: readonly string[], target: string): boolean {
    return audience.includes(target);
}
