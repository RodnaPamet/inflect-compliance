/**
 * Workday OAuth2 token lifecycle.
 *
 * Structurally this is `providers/sharepoint/token.ts` — build an authorize
 * URL, exchange the code for the first pair, resolve a still-valid access
 * token with refresh-on-expiry and persist the rotation — with everything
 * dependency-injectable so the token math is unit-testable with no env, no
 * network and no DB. That module is the precedent; this is not a new pattern.
 *
 * ONE STRUCTURAL DIFFERENCE, and it is the reason this is not a thin wrapper.
 * SharePoint talks to a single global identity provider, so its client id,
 * secret and tenant come from `env` (MICROSOFT_CLIENT_ID and friends). Workday
 * does not have that: every customer runs their own host and tenant, and the
 * OAuth2 client is registered inside THAT tenant. So all four of host, tenant,
 * clientId and clientSecret are per-connection, and there is no env fallback to
 * reach for. Passing them explicitly is not ceremony — an env default here
 * would be wrong for every connection but the first.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: classify credential failure. Workday, like
 * every OAuth2 provider, signals a revoked or invalid grant with HTTP 400 and an
 * `error` body (RFC 6749 §5.2 — `invalid_grant`, `invalid_client`), not 401.
 * `resilientFetch` classifies by status and 400 is in none of its sets, so a
 * revoked Workday grant surfaces as a generic failure and does NOT mark the
 * connection. That is a known, shared gap — the same one the Google DWD and
 * Entra token exchanges have — and closing it means classifying an OAuth error
 * BODY, which is a separate design question that should be solved once for all
 * providers rather than three times badly.
 *
 * @module integrations/providers/workday/token
 */
import { resilientFetch } from '../../http-resilience';

/**
 * Scopes requested from Workday.
 *
 * Explicit constant, mirroring SHAREPOINT_SCOPES, so the grant is reviewable in
 * one place rather than inline at the request. Workday scopes are coarse: the
 * roster read is covered by the Staffing functional area, exposed to OAuth2 as
 * the `staffing` scope on the API client.
 */
export const WORKDAY_SCOPES = ['staffing'] as const;

/** Refresh this many seconds BEFORE nominal expiry. */
const EXPIRY_SKEW_SECONDS = 60;

/**
 * The shape persisted (encrypted) in `IntegrationConnection.secretEncrypted`.
 * Identical to SharePointSecret by design — same lifecycle, same fields.
 */
export interface WorkdaySecret {
    accessToken: string;
    refreshToken: string;
    /** Unix seconds. */
    expiresAt: number;
}

/**
 * Per-connection OAuth2 client identity. All four are required and none has an
 * env default — see the module note.
 */
export interface WorkdayOAuthClient {
    /** e.g. `wd2-impl-services1.workday.com` — no scheme, no trailing slash. */
    host: string;
    /** The Workday tenant name, e.g. `acme_preview`. */
    tenant: string;
    clientId: string;
    clientSecret: string;
}

/**
 * Workday's OAuth2 endpoints are tenant-scoped paths under the customer host.
 * Built here rather than at each call site so a malformed host fails once, and
 * so the `ccx/oauth2/<tenant>` shape is stated exactly once.
 */
function tokenEndpoint(client: WorkdayOAuthClient): string {
    const host = client.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!host) throw new Error('Workday host is required');
    if (!client.tenant) throw new Error('Workday tenant is required');
    return `https://${host}/ccx/oauth2/${encodeURIComponent(client.tenant)}/token`;
}

function authorizeEndpoint(client: WorkdayOAuthClient): string {
    const host = client.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!host) throw new Error('Workday host is required');
    if (!client.tenant) throw new Error('Workday tenant is required');
    return `https://${host}/ccx/oauth2/${encodeURIComponent(client.tenant)}/authorize`;
}

/**
 * Build the Workday authorization URL for the consent redirect.
 *
 * No `prompt=consent` equivalent: Workday's consent is granted once when the
 * API client is registered in the tenant, so forcing a re-prompt is neither
 * available nor meaningful here.
 */
export function buildWorkdayAuthorizeUrl(opts: {
    client: WorkdayOAuthClient;
    redirectUri: string;
    state: string;
}): string {
    const params = new URLSearchParams({
        client_id: opts.client.clientId,
        response_type: 'code',
        redirect_uri: opts.redirectUri,
        scope: WORKDAY_SCOPES.join(' '),
        state: opts.state,
    });
    return `${authorizeEndpoint(opts.client)}?${params.toString()}`;
}

/** Shared POST to the tenant token endpoint. */
async function postToken(
    client: WorkdayOAuthClient,
    body: Record<string, string>,
    fetchImpl: typeof fetch,
    label: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const res = await fetchImpl(tokenEndpoint(client), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            // Workday accepts client credentials in the Basic header; sending
            // them there rather than in the body keeps the secret out of any
            // request-body logging a proxy might do.
            Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams(body),
    });
    if (!res.ok) throw new Error(`Workday ${label} failed: ${res.status}`);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

/** Exchange an authorization code for the first Workday token pair. */
export async function exchangeCodeForWorkdayToken(
    opts: { client: WorkdayOAuthClient; code: string; redirectUri: string },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<WorkdaySecret> {
    const fetchImpl = deps.fetchImpl ?? resilientFetch;
    const nowMs = deps.now ? deps.now() : Date.now();
    const data = await postToken(
        opts.client,
        { grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri },
        fetchImpl,
        'code exchange',
    );
    if (!data.refresh_token) {
        // Without one, the connection works until the first expiry and then
        // dies silently at 04:00 some morning. Fail at consent instead.
        throw new Error('Workday consent did not return a refresh token — the API client must allow offline access');
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(nowMs / 1000) + data.expires_in,
    };
}

/** Exchange a refresh token for a new pair. */
export async function refreshWorkdayToken(
    opts: { client: WorkdayOAuthClient; refreshToken: string },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<WorkdaySecret> {
    const fetchImpl = deps.fetchImpl ?? resilientFetch;
    const nowMs = deps.now ? deps.now() : Date.now();
    const data = await postToken(
        opts.client,
        { grant_type: 'refresh_token', refresh_token: opts.refreshToken },
        fetchImpl,
        'token refresh',
    );
    return {
        accessToken: data.access_token,
        // Workday MAY rotate the refresh token — keep the current one if it
        // does not. Overwriting with undefined here un-authenticates the
        // connection on the NEXT run, which reads as an unrelated failure a
        // day later. Same trap SharePoint's `?? current.refreshToken` avoids.
        refreshToken: data.refresh_token ?? opts.refreshToken,
        expiresAt: Math.floor(nowMs / 1000) + data.expires_in,
    };
}

/**
 * Return a still-valid access token, refreshing and persisting the rotated
 * pair when the current one is within the expiry skew.
 *
 * Returns `rotated: null` when nothing changed, so the caller can skip a write
 * rather than re-encrypting an identical secret on every sync.
 */
export async function resolveWorkdayAccessToken(
    current: WorkdaySecret,
    opts: { client: WorkdayOAuthClient },
    deps: {
        now?: () => number;
        refresh?: (refreshToken: string) => Promise<WorkdaySecret>;
        persist?: (secret: WorkdaySecret) => Promise<void>;
        fetchImpl?: typeof fetch;
    } = {},
): Promise<{ accessToken: string; rotated: WorkdaySecret | null }> {
    const nowSeconds = (deps.now ? deps.now() : Date.now()) / 1000;
    if (nowSeconds < current.expiresAt - EXPIRY_SKEW_SECONDS) {
        return { accessToken: current.accessToken, rotated: null };
    }

    const rotated = deps.refresh
        ? await deps.refresh(current.refreshToken)
        : await refreshWorkdayToken(
              { client: opts.client, refreshToken: current.refreshToken },
              { fetchImpl: deps.fetchImpl, now: deps.now },
          );

    if (deps.persist) await deps.persist(rotated);
    return { accessToken: rotated.accessToken, rotated };
}
