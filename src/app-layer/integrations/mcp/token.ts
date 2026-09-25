/**
 * Minting the access token an MCP connection presents, instead of storing one.
 *
 * ## Why a connection cannot just hold a token
 *
 * Microsoft's Entra MCP server accepts a bearer token that expires in about an
 * hour. A connection configured with one works, and then stops working the same
 * afternoon as a 401 somebody has to diagnose. So the durable thing to store is
 * what MINTS a token, not the token.
 *
 * ## Why the refresh grant, and not client credentials
 *
 * Measured against the live resource rather than inferred: its service
 * principal exposes `appRoles: []` — ZERO application permissions. Client
 * credentials cannot work against it however the app registration is
 * configured. Access is delegated, which means every token carries a named
 * person's privileges.
 *
 * That is a governance property worth stating rather than a limitation to work
 * around: an agent reaching Entra through this connection can never see more
 * than the human it acts for. The ceiling is a person, not an app.
 *
 * ## What is NOT stored
 *
 * The access token. It lives in memory, keyed by connection, until shortly
 * before it expires. Persisting it would put a live credential in a column for
 * the sake of saving a round trip that takes milliseconds.
 */
import { safeFetch } from '@/app-layer/automation/webhook-safety';

/** Microsoft's token endpoint host. Fixed — only the tenant segment varies. */
const LOGIN_HOST = 'https://login.microsoftonline.com';

/**
 * A tenant id is interpolated into the token URL, and it arrives from tenant
 * configuration. A GUID is the only shape Entra accepts there, so anything else
 * is refused rather than sent — an unvalidated segment in a URL we construct is
 * how a path turns into somewhere else.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Renew this long before expiry, so a call never races the clock. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

export class McpTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'McpTokenError';
    }
}

export interface RefreshCredentials {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** Defaults to the Entra MCP resource. */
    scope?: string;
}

export interface MintedToken {
    accessToken: string;
    expiresAt: number;
    /**
     * A NEW refresh token, when Entra rotated it. The caller must persist this
     * — dropping it strands the connection at the next expiry, and the failure
     * arrives hours later with nothing pointing back here.
     */
    rotatedRefreshToken: string | null;
}

/** The default resource: Microsoft MCP Server for Enterprise. */
export const ENTRA_MCP_SCOPE =
    'api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default offline_access';

/**
 * Exchange a refresh token for an access token.
 *
 * Throws `McpTokenError` with the provider's own `error` code when Entra
 * refuses — `invalid_grant` (the refresh token is spent or revoked) reads
 * differently from `invalid_client` (the secret is wrong), and an operator
 * needs to know which.
 */

interface TokenPayload {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
}

/**
 * One POST to Entra's token endpoint, for every grant type.
 *
 * Shared so the refresh exchange and the authorization-code exchange cannot
 * disagree about what a refusal looks like. The rule that matters is the same
 * for both: surface the error CODE and never the DESCRIPTION, because Entra's
 * `error_description` echoes request parameters and this string reaches logs.
 */
async function postToTokenEndpoint(
    tenantId: string,
    form: Record<string, string>,
): Promise<TokenPayload> {
    if (!GUID.test(tenantId)) {
        throw new McpTokenError('tenantId must be a GUID');
    }

    const res = await safeFetch(`${LOGIN_HOST}/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    } as RequestInit);

    const text = await res.text();
    let payload: TokenPayload;
    try {
        payload = JSON.parse(text) as TokenPayload;
    } catch {
        // The body is never quoted: a token response is a credential in its
        // entirety.
        throw new McpTokenError(`token endpoint returned a non-JSON body (HTTP ${res.status})`);
    }

    if (!res.ok || payload.error) {
        throw new McpTokenError(
            `token endpoint refused the ${form.grant_type}: ${payload.error ?? `HTTP ${res.status}`}`,
        );
    }
    return payload;
}

export async function mintAccessToken(creds: RefreshCredentials): Promise<MintedToken> {
    if (!GUID.test(creds.tenantId)) {
        throw new McpTokenError('tenantId must be a GUID');
    }
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
        throw new McpTokenError('clientId, clientSecret and refreshToken are all required');
    }

    const payload = await postToTokenEndpoint(creds.tenantId, {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        scope: creds.scope ?? ENTRA_MCP_SCOPE,
    });

    if (!payload.access_token) {
        throw new McpTokenError('token endpoint returned no access_token');
    }

    return {
        accessToken: payload.access_token,
        // `expires_in` is seconds and is advisory; treat a missing one as the
        // shortest plausible life rather than assuming an hour.
        expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
        rotatedRefreshToken: payload.refresh_token ?? null,
    };
}

/**
 * In-process cache of minted tokens, keyed by connection.
 *
 * Deliberately NOT a database column. A cached access token is a live
 * credential; keeping it in memory means it dies with the process and never
 * appears in a backup, a replica or a dump. The cost is one token mint per
 * process per hour, which is nothing.
 */
const cache = new Map<string, { accessToken: string; expiresAt: number }>();

/** Test seam — the cache is process-global and would otherwise leak between tests. */
export function _resetTokenCache(): void {
    cache.clear();
}

/**
 * The `Authorization` header value for a connection, minting and caching as
 * needed.
 *
 * `onRotated` is called when Entra hands back a new refresh token, so the
 * caller can persist it. It is a callback rather than a return value because
 * every caller must handle it and an ignored field is easy to write.
 */
export async function authorizationForConnection(
    connectionId: string,
    creds: RefreshCredentials,
    onRotated?: (refreshToken: string) => Promise<void>,
): Promise<string> {
    const hit = cache.get(connectionId);
    if (hit && hit.expiresAt - RENEW_MARGIN_MS > Date.now()) {
        return `Bearer ${hit.accessToken}`;
    }

    const minted = await mintAccessToken(creds);
    cache.set(connectionId, { accessToken: minted.accessToken, expiresAt: minted.expiresAt });

    if (minted.rotatedRefreshToken && onRotated) {
        await onRotated(minted.rotatedRefreshToken);
    }
    return `Bearer ${minted.accessToken}`;
}

/**
 * The `Authorization` header for a connection, whichever way it is configured.
 *
 * ONE resolver, used by `validateConnection` AND by the runtime that assembles
 * an agent's external tools. Two would be the shape where "Test connection"
 * succeeds and the agent fails — a green button over a broken path, which is
 * worse than not supporting the credential at all.
 *
 * Precedence is refresh-credentials first. A connection carrying both has been
 * migrated from a pasted token to a real flow, and the flow is the one that
 * still works tomorrow.
 */
export async function authorizationFor(
    connectionId: string,
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    onRotated?: (refreshToken: string) => Promise<void>,
): Promise<string | undefined> {
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

    const tenantId = str(config.tenantId);
    const clientId = str(config.clientId);
    const clientSecret = str(secrets.clientSecret);
    const refreshToken = str(secrets.refreshToken);

    if (tenantId || clientId || clientSecret || refreshToken) {
        // PARTIAL is refused rather than silently falling back to the static
        // header: a half-configured OAuth connection that quietly used a stale
        // pasted token would work until that token died and then look like a
        // server problem.
        if (!tenantId || !clientId || !clientSecret || !refreshToken) {
            throw new McpTokenError(
                'this connection is partly configured for OAuth — tenantId, clientId, ' +
                    'clientSecret and refreshToken are all required together',
            );
        }
        return authorizationForConnection(
            connectionId,
            { tenantId, clientId, clientSecret, refreshToken, scope: str(config.scope) || undefined },
            onRotated,
        );
    }

    const staticHeader = str(secrets.authorization);
    return staticHeader || undefined;
}

/**
 * The URL an administrator is sent to in order to authorize this deployment
 * against an external MCP server behind Entra.
 *
 * `offline_access` is the whole point: without it Entra returns an access token
 * and no refresh token, and the connection is back to working for an hour. The
 * resource's own `.default` requests exactly the delegated permissions an admin
 * has already consented to on the app registration — this flow cannot widen
 * what the tenant granted, it can only exercise it.
 *
 * `prompt=consent` is deliberate. Entra will silently return a token with no
 * refresh token if it believes consent is already in place, which produces a
 * connection that looks configured and dies in an hour. Asking every time costs
 * one extra click and removes that failure entirely.
 */
export function buildMcpAuthorizeUrl(input: {
    tenantId: string;
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
}): string {
    if (!GUID.test(input.tenantId)) {
        throw new McpTokenError('tenantId must be a GUID');
    }
    const q = new URLSearchParams({
        client_id: input.clientId,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        response_mode: 'query',
        scope: input.scope ?? ENTRA_MCP_SCOPE,
        state: input.state,
        prompt: 'consent',
    });
    return `${LOGIN_HOST}/${input.tenantId}/oauth2/v2.0/authorize?${q.toString()}`;
}

/**
 * Exchange the authorization code for a REFRESH token.
 *
 * The access token that comes back with it is discarded: it is minutes from
 * being stale by the time anyone uses the connection, and the refresh token is
 * the thing worth storing. Returning it would invite a caller to persist it.
 *
 * A response with no refresh token is an ERROR rather than a partial success.
 * Storing the access token instead would produce a connection that works
 * through the first test and fails silently an hour later, which is the exact
 * failure this whole flow exists to remove.
 */
export async function exchangeCodeForRefreshToken(input: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    scope?: string;
}): Promise<string> {
    const payload = await postToTokenEndpoint(input.tenantId, {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        scope: input.scope ?? ENTRA_MCP_SCOPE,
    });

    if (!payload.refresh_token) {
        throw new McpTokenError(
            'Entra returned no refresh token. The authorization must request ' +
                'offline_access, or consent was already in place and was not re-prompted.',
        );
    }
    return payload.refresh_token;
}
