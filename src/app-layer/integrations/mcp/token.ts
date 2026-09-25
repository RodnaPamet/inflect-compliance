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
export async function mintAccessToken(creds: RefreshCredentials): Promise<MintedToken> {
    if (!GUID.test(creds.tenantId)) {
        throw new McpTokenError('tenantId must be a GUID');
    }
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
        throw new McpTokenError('clientId, clientSecret and refreshToken are all required');
    }

    const body = new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        scope: creds.scope ?? ENTRA_MCP_SCOPE,
    });

    const res = await safeFetch(`${LOGIN_HOST}/${creds.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    } as RequestInit);

    const text = await res.text();
    let payload: {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        error?: string;
        error_description?: string;
    };
    try {
        payload = JSON.parse(text) as typeof payload;
    } catch {
        // The body is never quoted: a token response is the one payload in this
        // module that is a credential in its entirety.
        throw new McpTokenError(`token endpoint returned a non-JSON body (HTTP ${res.status})`);
    }

    if (!res.ok || payload.error) {
        // The CODE, never the description — Entra's error_description can echo
        // request parameters back, and this string reaches logs.
        throw new McpTokenError(
            `token endpoint refused the refresh: ${payload.error ?? `HTTP ${res.status}`}`,
        );
    }
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
