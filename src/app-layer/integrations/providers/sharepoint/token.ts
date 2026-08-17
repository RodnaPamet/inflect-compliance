/**
 * SharePoint delegated-token lifecycle (SP-1).
 *
 * The SharePoint integration stores its OWN delegated access + refresh token in
 * `IntegrationConnection.secretEncrypted` — separate from the NextAuth session
 * token (different scopes, different lifecycle, same refresh mechanism). This
 * module owns:
 *   - building the Entra authorize URL for the admin consent redirect,
 *   - exchanging the returned auth code for the first token pair,
 *   - resolving a still-valid access token (refresh-on-expiry + persist).
 *
 * Everything is dependency-injectable (`fetchImpl`, `now`, `refresh`, `persist`)
 * so the token math is unit-testable without env, network, or a DB.
 *
 * @module integrations/providers/sharepoint/token
 */
import { env } from '@/env';
import { refreshMicrosoftToken, isTokenExpired, type TokenRefreshResult } from '@/lib/auth/refresh';
import { boundedFetch } from '../../bounded-fetch';

/** Delegated Graph scopes SharePoint needs (beyond the auth-only sign-in set). */
export const SHAREPOINT_SCOPES = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'https://graph.microsoft.com/Sites.Read.All',
    'https://graph.microsoft.com/Files.Read.All',
    'https://graph.microsoft.com/Files.ReadWrite.All',
];

/** The shape persisted (encrypted) in `IntegrationConnection.secretEncrypted`. */
export interface SharePointSecret {
    accessToken: string;
    refreshToken: string;
    /** Unix seconds. */
    expiresAt: number;
}

interface MsEnv {
    clientId: string;
    clientSecret: string;
    tenantId: string;
}

function msEnv(override?: Partial<MsEnv>): MsEnv {
    return {
        clientId: override?.clientId ?? env.MICROSOFT_CLIENT_ID,
        clientSecret: override?.clientSecret ?? env.MICROSOFT_CLIENT_SECRET,
        tenantId: override?.tenantId ?? env.MICROSOFT_TENANT_ID,
    };
}

/**
 * Build the Entra authorization URL for the SharePoint consent redirect.
 * `prompt=consent` forces the consent screen so the admin grants the extra
 * Graph scopes even if they've signed in before.
 */
export function buildSharePointAuthorizeUrl(opts: {
    redirectUri: string;
    state: string;
    env?: Partial<MsEnv>;
}): string {
    const { clientId, tenantId } = msEnv(opts.env);
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: opts.redirectUri,
        response_mode: 'query',
        scope: SHAREPOINT_SCOPES.join(' '),
        state: opts.state,
        prompt: 'consent',
    });
    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for the first SharePoint token pair.
 * Mirrors `refreshMicrosoftToken` but with the `authorization_code` grant.
 */
export async function exchangeCodeForSharePointToken(
    opts: { code: string; redirectUri: string },
    deps: { fetchImpl?: typeof fetch; env?: Partial<MsEnv> } = {},
): Promise<SharePointSecret> {
    const { clientId, clientSecret, tenantId } = msEnv(deps.env);
    const fetchImpl = deps.fetchImpl ?? boundedFetch;
    const res = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: opts.code,
            redirect_uri: opts.redirectUri,
            scope: SHAREPOINT_SCOPES.join(' '),
        }),
    });
    if (!res.ok) throw new Error(`SharePoint code exchange failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) {
        throw new Error('SharePoint consent did not return a refresh token (offline_access missing?)');
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    };
}

/**
 * Return a still-valid access token for a connection, refreshing + persisting
 * the rotated token pair when the current one is within the expiry skew.
 */
export async function resolveSharePointAccessToken(
    current: SharePointSecret,
    deps: {
        now?: () => number;
        refresh?: (refreshToken: string) => Promise<TokenRefreshResult>;
        persist?: (secret: SharePointSecret) => Promise<void>;
    } = {},
): Promise<{ accessToken: string; rotated: SharePointSecret | null }> {
    const expired = deps.now
        ? deps.now() / 1000 >= current.expiresAt - 60
        : isTokenExpired(current.expiresAt);
    if (!expired) return { accessToken: current.accessToken, rotated: null };

    const refreshed = await (deps.refresh ?? refreshMicrosoftToken)(current.refreshToken);
    const rotated: SharePointSecret = {
        accessToken: refreshed.accessToken,
        // Microsoft MAY rotate the refresh token — keep the old one if not.
        refreshToken: refreshed.refreshToken ?? current.refreshToken,
        expiresAt: refreshed.expiresAt,
    };
    if (deps.persist) await deps.persist(rotated);
    return { accessToken: rotated.accessToken, rotated };
}
