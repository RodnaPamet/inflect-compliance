/**
 * Token refresh module for OAuth providers.
 * Handles automatic token refresh for Google and Microsoft Entra ID.
 * NEVER logs secrets or tokens.
 */
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
// These are OAuth token exchanges like any other in the codebase, so they get
// the same egress treatment: a deadline, 429/Retry-After handling, and — the
// part that was silently missing — 401/403 classified as IntegrationAuthError
// rather than an anonymous `Error`. See the note on `refreshMicrosoftToken`.
import { resilientFetch } from '@/app-layer/integrations/http-resilience';

export interface TokenRefreshResult {
    accessToken: string;
    refreshToken?: string; // Only present if rotated
    expiresAt: number;     // Unix timestamp in seconds
}

const SKEW_SECONDS = 60; // Refresh 60s before actual expiry

/**
 * Check if a token is expired or about to expire.
 */
export function isTokenExpired(expiresAt: number): boolean {
    return Date.now() / 1000 >= expiresAt - SKEW_SECONDS;
}

/**
 * Refresh a Google OAuth access token.
 * @see https://developers.google.com/identity/protocols/oauth2/web-server#offline
 */
export async function refreshGoogleToken(
    refreshToken: string,
    doFetch: typeof fetch = resilientFetch,
): Promise<TokenRefreshResult> {
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;

    logger.info('Refreshing Google access token', { component: 'auth' });

    const response = await doFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }),
    });

    if (!response.ok) {
        logger.error('Google token refresh failed', { component: 'auth', statusCode: response.status });
        throw new Error(`Google token refresh failed: ${response.status}`);
    }

    const data = await response.json();

    return {
        accessToken: data.access_token,
        // Google does not always rotate refresh tokens
        refreshToken: data.refresh_token ?? undefined,
        expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
    };
}

/**
 * Refresh a Microsoft Entra ID access token.
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token
 */
export async function refreshMicrosoftToken(
    refreshToken: string,
    doFetch: typeof fetch = resilientFetch,
): Promise<TokenRefreshResult> {
    const clientId = env.MICROSOFT_CLIENT_ID;
    const clientSecret = env.MICROSOFT_CLIENT_SECRET;
    const tenantId = env.MICROSOFT_TENANT_ID;

    logger.info('Refreshing Microsoft access token', { component: 'auth' });

    const response = await doFetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                scope: 'openid profile email offline_access',
            }),
        }
    );

    if (!response.ok) {
        logger.error('Microsoft token refresh failed', { component: 'auth', statusCode: response.status });
        throw new Error(`Microsoft token refresh failed: ${response.status}`);
    }

    const data = await response.json();

    return {
        accessToken: data.access_token,
        // Microsoft MAY rotate refresh tokens
        refreshToken: data.refresh_token ?? undefined,
        expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
    };
}

/**
 * Refresh an access token based on the provider.
 */
export async function refreshAccessToken(
    provider: string,
    refreshToken: string,
    doFetch: typeof fetch = resilientFetch,
): Promise<TokenRefreshResult> {
    switch (provider) {
        case 'google':
            return refreshGoogleToken(refreshToken, doFetch);
        case 'microsoft-entra-id':
            return refreshMicrosoftToken(refreshToken, doFetch);
        default:
            throw new Error(`Token refresh not supported for provider: ${provider}`);
    }
}
