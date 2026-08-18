/**
 * OAuth2 token lifecycle for the per-user calendar push — Google and Microsoft.
 *
 * ═══ TWO PROVIDERS, DELIBERATELY ASYMMETRIC CONSENT ═══
 *
 * GOOGLE: the user consents. Normal authorization-code flow with a consent
 * screen.
 *
 * MICROSOFT: a TENANT ADMIN consents once, for everyone, via `/adminconsent`.
 * Users are then never prompted — but they still sign in, and each still gets
 * their OWN delegated token. That is the fact the whole design rests on and it
 * is worth stating precisely, because "admin consent" sounds like it replaces
 * the per-user flow and does not: delegated permissions are by definition "on
 * behalf of a signed-in user", so admin consent removes the PROMPT, not the
 * FLOW. `consentType: AllPrincipals` is a pre-grant, not an impersonation.
 *
 * So both providers share the same per-user token machinery below. Only the
 * consent step differs, and only for Microsoft.
 *
 * ═══ SHAPE BORROWED FROM workday/token.ts, CREDENTIALS FROM sharepoint ═══
 *
 * From Workday: a named expiry skew, `now` injected into both exchange and
 * refresh, a dedicated refresher carrying the `?? current` rotation guard, one
 * shared `postToken` so the two grant types cannot drift, and a `rotated: null`
 * contract so a caller can skip a write.
 *
 * From SharePoint: credentials come from `env` with a per-call override.
 * Workday's per-connection credential model is right for Workday, where every
 * customer registers their own OAuth client, and wrong here, where one
 * registered app serves every tenant.
 *
 * ═══ WHAT THIS DOES NOT REUSE, AND WHY ═══
 *
 * `refreshMicrosoftToken` in `@/lib/auth/refresh` looks like exactly this
 * function and must not be used. It hardcodes the SIGN-IN scope set
 * (`openid profile email offline_access`) on the refresh grant. Refreshing a
 * calendar token through it would return a token without `Calendars.ReadWrite`
 * — roughly an hour after consent, with every subsequent write failing 403 in
 * a way indistinguishable from revoked consent.
 *
 * @module integrations/providers/calendar/token
 */
import { env } from '@/env';
import { fetchOAuthToken } from '../../oauth-token-fetch';

/**
 * Minimum scopes. Explicit constants rather than inline strings so the grant is
 * reviewable in one place — and so a widening is a visible diff.
 *
 * `calendar.events` NOT `calendar`: the narrower scope is what Google's
 * verification asks us to justify, and asking for full calendar access when we
 * only write events is the thing that turns a 10-day review into a rejection.
 */
export const GOOGLE_CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'] as const;

/**
 * `offline_access` is what yields a refresh token; without it the connection
 * dies at the first expiry. `Calendars.ReadWrite` is delegated, so it needs no
 * admin consent AS A PERMISSION — but a tenant's consent policy may still
 * require it, which is why the admin-consent flow exists.
 */
export const MICROSOFT_CALENDAR_SCOPES = ['offline_access', 'Calendars.ReadWrite'] as const;

/** Refresh this many seconds BEFORE nominal expiry. */
const EXPIRY_SKEW_SECONDS = 60;

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export type CalendarProvider = 'google-calendar' | 'outlook-calendar';

/** The shape persisted (encrypted) in UserCalendarConnection.tokenEncrypted. */
export interface CalendarToken {
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

function msAuthorityBase(tenantId: string): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`;
}

// ─── Consent URLs ────────────────────────────────────────────────────

/**
 * Where a TENANT ADMIN goes to authorise this app for their whole tenant.
 *
 * A different endpoint from the per-user authorize URL, with a different
 * response: on success Entra redirects back with `admin_consent=True&tenant=…`
 * and NO authorization code. A callback that expects a code will read that as a
 * failure.
 *
 * `state` is required and must be verified on return — this is a
 * tenant-privileged operation, and without it any site could initiate one.
 *
 * NOTE the documented caveat: granting tenant-wide consent MAY REVOKE
 * permissions already granted tenant-wide for the same app. Re-running it is
 * not the no-op the button implies.
 */
export function buildMicrosoftAdminConsentUrl(opts: {
    redirectUri: string;
    state: string;
    /** The customer's Entra tenant, or `organizations` to use the signer's. */
    entraTenantId?: string;
    env?: Partial<MsEnv>;
}): string {
    const e = msEnv(opts.env);
    const params = new URLSearchParams({
        client_id: e.clientId,
        redirect_uri: opts.redirectUri,
        state: opts.state,
        // Named scopes are NOT sent here. /adminconsent grants everything the
        // app registration declares, so the registration is the source of
        // truth — passing a scope list would imply a narrowing that does not
        // happen.
    });
    return `${msAuthorityBase(opts.entraTenantId ?? 'organizations')}/adminconsent?${params.toString()}`;
}

/**
 * Where a USER goes to connect their own calendar.
 *
 * For Microsoft this normally shows no consent screen, because the admin
 * already consented; the user still signs in and still receives their own
 * delegated token. If the admin has NOT consented, Entra answers AADSTS65001 —
 * which the callback must render as "your administrator has not authorised this
 * yet", not as a generic failure.
 */
export function buildCalendarAuthorizeUrl(opts: {
    provider: CalendarProvider;
    redirectUri: string;
    state: string;
    entraTenantId?: string;
    env?: Partial<MsEnv>;
}): string {
    if (opts.provider === 'google-calendar') {
        const params = new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            redirect_uri: opts.redirectUri,
            response_type: 'code',
            scope: GOOGLE_CALENDAR_SCOPES.join(' '),
            state: opts.state,
            // BOTH are required to get a refresh token from Google, and
            // omitting either is the classic way to ship a connection that
            // works until the first expiry. `access_type=offline` asks for one;
            // `prompt=consent` forces it to be RE-ISSUED — Google returns a
            // refresh token only on the FIRST consent otherwise, so a user who
            // reconnects gets none and the connection silently cannot refresh.
            access_type: 'offline',
            prompt: 'consent',
        });
        return `${GOOGLE_AUTH}?${params.toString()}`;
    }

    const e = msEnv(opts.env);
    const params = new URLSearchParams({
        client_id: e.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: MICROSOFT_CALENDAR_SCOPES.join(' '),
        state: opts.state,
        // No `prompt=consent`. The admin has consented for the tenant; forcing
        // a prompt would show every user a consent screen the design exists to
        // remove, and on a tenant with user consent disabled it would fail.
    });
    return `${msAuthorityBase(opts.entraTenantId ?? e.tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
}

// ─── Token exchange + refresh ────────────────────────────────────────

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}

/**
 * Shared POST, so the code-exchange and refresh grants cannot drift apart.
 *
 * Goes through `fetchOAuthToken` rather than `resilientFetch` FROM THE FIRST
 * COMMIT. That wrapper turns a `400` carrying `invalid_grant` /
 * `invalid_client` / `unauthorized_client` into an `IntegrationAuthError`, and
 * a withdrawn calendar consent is exactly a `400 invalid_grant` on refresh.
 * Without it, revocation reaches the caller as a generic failure and the
 * terminal-consent handling never fires — the connection keeps its dead token
 * and keeps being scheduled, failing quietly every night. Both existing token
 * modules in this repo had to be retrofitted with it; this one is not repeating
 * that.
 */
async function postToken(
    url: string,
    body: Record<string, string>,
    fetchImpl: typeof fetch | undefined,
    label: string,
): Promise<TokenResponse> {
    const res = await fetchOAuthToken(
        url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body),
        },
        fetchImpl,
    );
    if (!res.ok) throw new Error(`Calendar ${label} failed: ${res.status}`);
    return (await res.json()) as TokenResponse;
}

function tokenEndpoint(provider: CalendarProvider, msOverride?: Partial<MsEnv>, entraTenantId?: string): string {
    if (provider === 'google-calendar') return GOOGLE_TOKEN;
    const e = msEnv(msOverride);
    return `${msAuthorityBase(entraTenantId ?? e.tenantId)}/oauth2/v2.0/token`;
}

function clientCredentials(provider: CalendarProvider, msOverride?: Partial<MsEnv>): { client_id: string; client_secret: string } {
    if (provider === 'google-calendar') {
        return { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET };
    }
    const e = msEnv(msOverride);
    return { client_id: e.clientId, client_secret: e.clientSecret };
}

/** Exchange an authorization code for the first token pair. */
export async function exchangeCalendarCode(
    opts: {
        provider: CalendarProvider;
        code: string;
        redirectUri: string;
        entraTenantId?: string;
        env?: Partial<MsEnv>;
    },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<CalendarToken> {
    const nowMs = deps.now ? deps.now() : Date.now();
    const data = await postToken(
        tokenEndpoint(opts.provider, opts.env, opts.entraTenantId),
        {
            ...clientCredentials(opts.provider, opts.env),
            grant_type: 'authorization_code',
            code: opts.code,
            redirect_uri: opts.redirectUri,
        },
        deps.fetchImpl,
        'code exchange',
    );
    if (!data.refresh_token) {
        // Without one the connection works until the first expiry and then
        // dies silently overnight. Fail at consent, while the user is present
        // and can re-run it.
        throw new Error(
            'Calendar consent did not return a refresh token — reconnect and grant offline access',
        );
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(nowMs / 1000) + data.expires_in,
    };
}

/** Exchange a refresh token for a new pair. */
export async function refreshCalendarToken(
    opts: {
        provider: CalendarProvider;
        refreshToken: string;
        entraTenantId?: string;
        env?: Partial<MsEnv>;
    },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<CalendarToken> {
    const nowMs = deps.now ? deps.now() : Date.now();
    const data = await postToken(
        tokenEndpoint(opts.provider, opts.env, opts.entraTenantId),
        {
            ...clientCredentials(opts.provider, opts.env),
            grant_type: 'refresh_token',
            refresh_token: opts.refreshToken,
            // The SAME scopes as the original grant. Omitting them lets the
            // provider decide, and the sign-in refresher in @/lib/auth/refresh
            // decides wrongly — it sends the sign-in scope set, which would
            // return a token WITHOUT Calendars.ReadWrite about an hour after
            // consent, failing every write in a way that looks like revocation.
            scope:
                opts.provider === 'google-calendar'
                    ? GOOGLE_CALENDAR_SCOPES.join(' ')
                    : MICROSOFT_CALENDAR_SCOPES.join(' '),
        },
        deps.fetchImpl,
        'token refresh',
    );
    return {
        accessToken: data.access_token,
        // Google does NOT return a refresh token on refresh; Microsoft rotates
        // it. Overwriting with undefined un-authenticates the connection on the
        // NEXT run, which surfaces a day later as an unrelated failure.
        refreshToken: data.refresh_token ?? opts.refreshToken,
        expiresAt: Math.floor(nowMs / 1000) + data.expires_in,
    };
}

/**
 * Return a still-valid access token, refreshing and persisting when the current
 * one is inside the expiry skew.
 *
 * `rotated: null` when nothing changed, so the caller can skip re-encrypting an
 * identical secret on every push run.
 */
export async function resolveCalendarAccessToken(
    current: CalendarToken,
    opts: { provider: CalendarProvider; entraTenantId?: string; env?: Partial<MsEnv> },
    deps: {
        now?: () => number;
        refresh?: (refreshToken: string) => Promise<CalendarToken>;
        persist?: (token: CalendarToken) => Promise<void>;
        fetchImpl?: typeof fetch;
    } = {},
): Promise<{ accessToken: string; rotated: CalendarToken | null }> {
    const nowSeconds = (deps.now ? deps.now() : Date.now()) / 1000;
    if (nowSeconds < current.expiresAt - EXPIRY_SKEW_SECONDS) {
        return { accessToken: current.accessToken, rotated: null };
    }

    const rotated = deps.refresh
        ? await deps.refresh(current.refreshToken)
        : await refreshCalendarToken(
              {
                  provider: opts.provider,
                  refreshToken: current.refreshToken,
                  entraTenantId: opts.entraTenantId,
                  env: opts.env,
              },
              { fetchImpl: deps.fetchImpl, now: deps.now },
          );

    // Persist AT ROTATION, before the caller does anything else with the token.
    // Microsoft rotates refresh tokens and invalidates the predecessor, so a
    // failure after this point must not take the new one with it.
    if (deps.persist) await deps.persist(rotated);
    return { accessToken: rotated.accessToken, rotated };
}
