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
 * ## TWO GRANTS, and a safety argument that expired (#3467)
 *
 * This module supported only the refresh grant, on a measurement recorded here
 * as a reason: the resource's service principal exposed `appRoles: []` — zero
 * application permissions — so "client credentials cannot work against it
 * however the app registration is configured".
 *
 * A LATER PROVING RUN MEASURED THE OPPOSITE, and both measurements are real
 * because they are about DIFFERENT resources. Neither is retracted:
 *
 *   · 2026-10-?? — `api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4` (Microsoft MCP
 *     Server for Enterprise, this module's `ENTRA_MCP_SCOPE`): `appRoles: []`.
 *     App-only access to THAT resource is not configurable.
 *   · 2026-10-13 — the gateway at `https://mcp.svc.cloud.microsoft/enterprise`
 *     answered `initialize` with 200 to a CLIENT-CREDENTIALS token scoped
 *     `https://mcp.svc.cloud.microsoft/.default`. A
 *     `graph.microsoft.com/.default` token to the same endpoint is
 *     `401 InvalidAuthenticationToken — Invalid audience`, and
 *     `api://mcp.svc.cloud.microsoft/.default` is `AADSTS500011
 *     invalid_resource`.
 *
 * So the old sentence was true of the resource it was measured against and
 * false as a statement about this provider, which connects to arbitrary MCP
 * servers. An operator whose server wants app-only auth had one option left —
 * paste a bearer into `secrets.authorization` — and an Entra access token lives
 * about an hour, so the connection worked until lunchtime.
 *
 * ## The governance difference is kept, as a difference rather than a limit
 *
 * A delegated token carries a named person's privileges, so an agent reaching
 * through such a connection can never see more than the human it acts for: the
 * ceiling is a person, not an app. An app-only token has no such ceiling.
 *
 * That is a real distinction and it is why the two grants are a DISCRIMINATED
 * UNION with a required `kind` rather than "refresh token present or not". A
 * defaulted discriminant would let a caller that forgot to say which grant it
 * meant get one silently, and the grant decides whether a person bounds what
 * the token can reach.
 *
 * ## `offline_access` belongs to one of them only
 *
 * `ENTRA_MCP_SCOPE` carries it, and it must be: without it Entra returns an
 * access token and no refresh token, and the connection is back to lasting an
 * hour. The client-credentials grant has no user to stay offline on behalf of
 * and Entra refuses the scope outright, so an app-only credential takes NO
 * default scope at all — see `AppOnlyCredentials.scope` for why a default
 * would be worse than a required field here.
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

/**
 * An app-only credential: the client-credentials grant (#3467).
 *
 * No `refreshToken`, because there is no user session to refresh — the secret
 * IS the credential and a fresh token is one POST away whenever one is needed.
 */
export interface AppOnlyCredentials {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    /**
     * REQUIRED, unlike the delegated grant's, and the asymmetry is the point.
     *
     * `ENTRA_MCP_SCOPE` is a default that was measured against one specific
     * resource. The 2026-10-13 run showed exactly what a wrong audience costs:
     * the gateway answers `401 InvalidAuthenticationToken — Invalid audience`,
     * which reads as a credential problem and is not one. A default here would
     * aim every app-only connection at a resource most of them have nothing to
     * do with, and the failure names neither the default nor the field that
     * would have fixed it.
     *
     * An operator configuring app-only auth knows their server's audience —
     * it is the one thing they must know — so it is asked for rather than
     * guessed.
     */
    scope: string;
}

/**
 * Which grant a connection is configured for.
 *
 * `kind` is REQUIRED on both arms. See the header: the grant decides whether a
 * named person bounds what the token can reach, and that is not a thing to
 * default.
 */
export type McpCredentials =
    | ({ kind: 'delegated' } & RefreshCredentials)
    | ({ kind: 'app-only' } & AppOnlyCredentials);

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
 * Exchange a client secret for an app-only access token (#3467).
 *
 * The SAME `postToTokenEndpoint`, so the two grants cannot disagree about what
 * a refusal looks like or about which half of Entra's answer is safe to
 * surface — the code, never the description.
 *
 * `rotatedRefreshToken` is always null, and it is returned rather than omitted
 * so both grants share one result shape. There is nothing to rotate: the
 * client-credentials grant issues no refresh token, because there is no user
 * session to resume.
 */
export async function mintAppOnlyToken(creds: AppOnlyCredentials): Promise<MintedToken> {
    if (!GUID.test(creds.tenantId)) {
        throw new McpTokenError('tenantId must be a GUID');
    }
    if (!creds.clientId || !creds.clientSecret) {
        throw new McpTokenError('clientId and clientSecret are both required');
    }
    // ASKED FOR, never defaulted — see `AppOnlyCredentials.scope`. Checked
    // here as well as at the resolver, because this function is exported and a
    // second caller must not be able to reach Entra with an empty audience.
    if (!creds.scope.trim()) {
        throw new McpTokenError(
            'scope is required for an app-only credential — it names the audience the '
                + 'token is for, and a token minted for the wrong one is refused as '
                + 'an invalid audience rather than as a bad secret',
        );
    }
    // `offline_access` REFUSED rather than stripped. Stripping would quietly
    // accept a scope an operator copied from the delegated flow and send
    // something other than what they typed; Entra refuses it anyway, and the
    // refusal arrives as an AADSTS code that says nothing about which field to
    // change. The grant has no user to stay offline on behalf of.
    if (/\boffline_access\b/.test(creds.scope)) {
        throw new McpTokenError(
            'offline_access cannot be requested with the client-credentials grant — '
                + 'it asks for a refresh token on a user\'s behalf and there is no user. '
                + 'Use the resource\'s own scope, e.g. https://example/.default',
        );
    }

    const payload = await postToTokenEndpoint(creds.tenantId, {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'client_credentials',
        scope: creds.scope.trim(),
    });

    if (!payload.access_token) {
        throw new McpTokenError('token endpoint returned no access_token');
    }

    return {
        accessToken: payload.access_token,
        expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
        rotatedRefreshToken: null,
    };
}

/** Mint by whichever grant the credential names. */
export async function mintToken(creds: McpCredentials): Promise<MintedToken> {
    return creds.kind === 'app-only' ? mintAppOnlyToken(creds) : mintAccessToken(creds);
}

/**
 * WHICH CREDENTIAL A CONNECTION IS CONFIGURED WITH, from its config + secrets.
 *
 * ONE resolver, and that is a fix rather than a tidy-up (#3467). The shape
 * checks lived in two places — `authorizationFor` here and
 * `mcp-server-provider.freshAuthorization` — and that function's docblock
 * claimed "the shape checks are the same and live in one place, so the two
 * cannot disagree about what 'configured for OAuth' means". They were two
 * copies, and they had already drifted: one said `OAuth`, the other said
 * `Entra`, so an operator met a different sentence depending on whether they
 * pressed Test or ran an agent. With a second grant to resolve, two copies
 * would be two answers to "which grant is this".
 *
 * Returns null when nothing OAuth-ish is configured — the caller then falls
 * back to the static header. Throws when a credential is PARTIAL, because a
 * half-configured connection that quietly used a stale pasted token would work
 * until that token died and then look like a server problem.
 */
export function resolveMcpCredentials(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
): McpCredentials | null {
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

    const tenantId = str(config.tenantId);
    const clientId = str(config.clientId);
    const scope = str(config.scope);
    const clientSecret = str(secrets.clientSecret);
    const refreshToken = str(secrets.refreshToken);

    // `scope` is deliberately NOT in this test. It is a property of the SERVER
    // rather than of the grant, so a connection can carry one while being
    // authenticated by a static header — and treating it as a sign of OAuth
    // would turn "I told it my server's audience" into "this connection is
    // half-configured for Entra".
    if (!(tenantId || clientId || clientSecret || refreshToken)) return null;

    // THE COMMON THREE FIRST, so the message names the real gap. Checking all
    // four at once reported "tenantId, clientId, clientSecret and refreshToken
    // are all required together" to an operator who had deliberately supplied
    // three of them for an app-only connection — the message was both true of
    // the old code and the wrong thing to tell them (#3467).
    if (!tenantId || !clientId || !clientSecret) {
        throw new McpTokenError(
            'this connection is partly configured for Entra — tenantId, clientId and '
                + 'clientSecret are required for either grant, plus a refreshToken for '
                + 'delegated access or a scope for app-only access',
        );
    }

    // THE REFRESH TOKEN SELECTS THE GRANT, because it is the field only one of
    // them can have. A connection carrying both a refresh token and a scope is
    // delegated: the scope then names the same audience the delegated flow
    // asks for, which is what `ENTRA_MCP_SCOPE` defaults to.
    if (refreshToken) {
        return {
            kind: 'delegated',
            tenantId,
            clientId,
            clientSecret,
            refreshToken,
            ...(scope ? { scope } : {}),
        };
    }

    if (!scope) {
        throw new McpTokenError(
            'an app-only connection needs a scope — it names the audience the token is '
                + 'for, and the wrong audience is refused as an invalid token rather than '
                + 'as a bad secret. Supply a refreshToken instead for delegated access, '
                + 'where a named person bounds what the token can reach',
        );
    }
    return { kind: 'app-only', tenantId, clientId, clientSecret, scope };
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
    creds: McpCredentials,
    onRotated?: (refreshToken: string) => Promise<void>,
): Promise<string> {
    const hit = cache.get(connectionId);
    if (hit && hit.expiresAt - RENEW_MARGIN_MS > Date.now()) {
        return `Bearer ${hit.accessToken}`;
    }

    const minted = await mintToken(creds);
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
 *
 * THAT PRECEDENCE IS NOW ONLY REACHABLE FOR ROWS THAT PREDATE #3340.
 * `mcp-server-provider.validateConnection` refuses to save both together and
 * #3330's mint refuses to add a static token to an OAuth connection, because
 * the silent half of this rule turned out to be expensive: the grant endpoint
 * (#3323) authenticates by comparing the presented bearer against
 * `secrets.authorization`, so for a connection carrying both, the dispatch
 * sends a minted token while the endpoint compares the static one. Two
 * unrelated credentials, both sides correct, `AUTHZ_DENIED` in the trail, and
 * nothing naming the cause.
 *
 * The precedence is kept rather than reversed — reversing it would make a
 * migrated connection start sending a dead pasted token — but it is no longer
 * the only thing standing between an operator and that failure:
 * `authenticateGrantCaller` refuses such a row by name
 * (`oauth_shadows_static`) instead of reporting a mismatch.
 */
export async function authorizationFor(
    connectionId: string,
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
    onRotated?: (refreshToken: string) => Promise<void>,
): Promise<string | undefined> {
    // SHAPE RESOLVED IN ONE PLACE (#3467). This function used to spell the
    // field checks itself, as did the provider's validation path; see
    // `resolveMcpCredentials` for what the two copies cost.
    const credentials = resolveMcpCredentials(config, secrets);
    if (credentials) {
        return authorizationForConnection(connectionId, credentials, onRotated);
    }

    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
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
