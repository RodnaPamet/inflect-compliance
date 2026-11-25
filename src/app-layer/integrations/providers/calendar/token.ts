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
import { createHash, randomBytes } from 'crypto';
import { env } from '@/env';
import { fetchOAuthToken } from '../../oauth-token-fetch';
import { IntegrationTerminalError, resilientFetch } from '../../http-resilience';
import { readEntraError, type EntraErrorReading } from './entra-errors';

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

/**
 * Whether this deployment has a Microsoft app registration to send an
 * administrator to. The env schema requires both values in production, but a
 * deployment copied from an example file carries its placeholder
 * (`REPLACE_ME_…`, `your-…`), and `/adminconsent` with a placeholder client id
 * fails at Microsoft with an error that names nothing the administrator can
 * fix. The consent card says "not configured" instead of offering that.
 */
export function microsoftCalendarClientConfigured(override?: Partial<MsEnv>): boolean {
    const e = msEnv(override);
    const real = (v: string | undefined) => {
        const t = (v ?? '').trim();
        return t.length > 0 && !/^REPLACE_ME/i.test(t) && !/^your-/i.test(t);
    };
    return real(e.clientId) && real(e.clientSecret);
}

function msAuthorityBase(tenantId: string): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`;
}

// ─── PKCE (RFC 7636) ─────────────────────────────────────────────────

/**
 * A fresh PKCE pair for ONE authorization round trip.
 *
 * S256 only. `plain` sends the verifier itself as the challenge, so a code
 * intercepted together with the authorize URL is exchangeable — no protection
 * at all. Both providers accept S256 from a confidential web client alongside
 * its client secret.
 *
 * 32 random bytes → a 43-character base64url verifier, inside RFC 7636's
 * 43..128 range and from its unreserved alphabet.
 *
 * The VERIFIER never goes in a URL. The connect route seals it into the flow
 * cookie (`oauth-flow.ts`) and only the challenge travels to the provider; the
 * callback reads the verifier back from that cookie and sends it on the token
 * POST, where the provider checks it against the challenge it was given.
 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    return { codeVerifier, codeChallenge: pkceChallengeFor(codeVerifier) };
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))` — RFC 7636 §4.2. */
export function pkceChallengeFor(codeVerifier: string): string {
    return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/** RFC 7636 §4.1: 43..128 characters from the unreserved set. */
const PKCE_VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isPkceVerifier(value: unknown): value is string {
    return typeof value === 'string' && PKCE_VERIFIER_SHAPE.test(value);
}

/**
 * The code exchange returned no refresh token.
 *
 * A TYPED error rather than a message, because the callback must tell the user
 * something different for it ("reconnect and grant offline access") than for a
 * failed exchange, and matching on prose is how that distinction rots.
 */
export class CalendarNoRefreshTokenError extends Error {
    constructor() {
        super('Calendar consent did not return a refresh token — reconnect and grant offline access');
        this.name = 'CalendarNoRefreshTokenError';
    }
}

/**
 * The provider refused the authorization-code exchange.
 *
 * Carries what the token endpoint's answer SAYS, read the way every Entra
 * answer is read (`readEntraError`): the OAuth `error` code and the AADSTS
 * number at the start of `error_description` — or, when the description has
 * none, the first of Entra's numeric `error_codes` — and nothing else of the
 * body. Before #5957 the body was not read at all, so an organisation grant
 * removed in the Entra portal that surfaced HERE (`AADSTS65001` on the
 * exchange) reported `connect_failed` instead of `consent_required`.
 *
 * `status` is the HTTP status (null when the request never got an answer);
 * `reading` is null when the answer had no readable error body. The message
 * names the status only: a body can echo the code back.
 */
export class CalendarCodeExchangeError extends Error {
    readonly status: number | null;
    readonly reading: EntraErrorReading | null;

    constructor(status: number | null, reading: EntraErrorReading | null) {
        super(`Calendar code exchange refused (HTTP ${status ?? 'none'})`);
        this.name = 'CalendarCodeExchangeError';
        this.status = status;
        this.reading = reading;
    }
}

/** An Entra numeric error code as Entra lists it in `error_codes`. */
const ENTRA_ERROR_NUMBER = /^\d{4,7}$/;

/** Read a token endpoint's error body: codes only, never prose. Never throws. */
async function readTokenRefusal(res: Response): Promise<EntraErrorReading | null> {
    try {
        const contentType = res.headers?.get?.('content-type') ?? '';
        if (!contentType.toLowerCase().includes('json')) return null;
        const body = (await res.json()) as { error?: unknown; error_description?: unknown; error_codes?: unknown };
        const reading = readEntraError(
            typeof body.error === 'string' ? body.error : null,
            typeof body.error_description === 'string' ? body.error_description : null,
            'user',
        );
        if (reading.aadstsCode === null && Array.isArray(body.error_codes)) {
            const first = String(body.error_codes[0] ?? '');
            if (ENTRA_ERROR_NUMBER.test(first)) {
                return readEntraError(reading.errorCode, `AADSTS${first}`, 'user');
            }
        }
        return reading;
    } catch {
        return null;
    }
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
    /**
     * `pkceChallengeFor(verifier)`. REQUIRED, not optional: an authorize URL
     * without it is the unprotected flow, and making it optional is how one
     * provider quietly ends up without it.
     */
    codeChallenge: string;
    entraTenantId?: string;
    env?: Partial<MsEnv>;
}): string {
    if (!opts.codeChallenge) throw new Error('Calendar authorize URL requires a PKCE code challenge');
    const pkce = { code_challenge: opts.codeChallenge, code_challenge_method: 'S256' };
    if (opts.provider === 'google-calendar') {
        const params = new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            redirect_uri: opts.redirectUri,
            response_type: 'code',
            scope: GOOGLE_CALENDAR_SCOPES.join(' '),
            state: opts.state,
            ...pkce,
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
        ...pkce,
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
        /** The verifier whose challenge went on the authorize URL. REQUIRED. */
        codeVerifier: string;
        entraTenantId?: string;
        env?: Partial<MsEnv>;
    },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<CalendarToken> {
    // Refused BEFORE any request: an exchange without a verifier is the one
    // the provider would refuse anyway, and sending the code without it spends
    // a single-use code for nothing.
    if (!isPkceVerifier(opts.codeVerifier)) {
        throw new Error('Calendar code exchange requires the PKCE code verifier');
    }
    const nowMs = deps.now ? deps.now() : Date.now();
    // The token endpoint's refusal is read on the way past, before
    // `fetchOAuthToken` turns a `400 invalid_grant` into a bare
    // `IntegrationAuthError`: the AADSTS number in it decides the callback's
    // outcome. `clone()`, so the body is still there for the reader after us.
    const inner = deps.fetchImpl ?? resilientFetch;
    let refusal: { status: number; reading: EntraErrorReading | null } | null = null;
    const reading: typeof fetch = async (input, init) => {
        const res = await inner(input, init);
        if (!res.ok) refusal = { status: res.status, reading: await readTokenRefusal(res.clone()) };
        return res;
    };
    let data: TokenResponse;
    try {
        data = await postToken(
            tokenEndpoint(opts.provider, opts.env, opts.entraTenantId),
            {
                ...clientCredentials(opts.provider, opts.env),
                grant_type: 'authorization_code',
                code: opts.code,
                redirect_uri: opts.redirectUri,
                code_verifier: opts.codeVerifier,
            },
            reading,
            'code exchange',
        );
    } catch (err) {
        const seen = refusal as { status: number; reading: EntraErrorReading | null } | null;
        if (seen) throw new CalendarCodeExchangeError(seen.status, seen.reading);
        // A 401/403 is thrown by the resilient layer before a body can be read.
        throw new CalendarCodeExchangeError(err instanceof IntegrationTerminalError ? err.status : null, null);
    }
    if (!data.refresh_token) {
        // Without one the connection works until the first expiry and then
        // dies silently overnight. Fail at consent, while the user is present
        // and can re-run it.
        throw new CalendarNoRefreshTokenError();
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

// ─── Revocation (disconnect) ─────────────────────────────────────────

const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

/**
 * Revoke a Google grant at the provider, after a disconnect has removed the
 * pushed events (#5937 step 2).
 *
 * The REFRESH token is revoked: Google revokes the grant behind it, so the
 * access tokens minted from it stop working too. Microsoft has no per-token
 * revocation for a delegated grant, so an Outlook disconnect only destroys the
 * stored token and there is no Microsoft twin of this function.
 *
 * Best effort and NEVER THROWS: the local token is destroyed whatever Google
 * answers, and a disconnect the person asked for must not fail because
 * Google's revocation endpoint had a bad minute. Returns whether Google
 * confirmed, for the caller's log line. Google answers 200 on success and 400
 * for a token it no longer knows (already revoked), which is also "revoked".
 */
export async function revokeGoogleCalendarToken(
    refreshToken: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<'revoked' | 'not-confirmed'> {
    if (!refreshToken) return 'not-confirmed';
    try {
        const res = await fetchOAuthToken(
            GOOGLE_REVOKE,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: refreshToken }),
            },
            deps.fetchImpl,
        );
        return res.ok || res.status === 400 ? 'revoked' : 'not-confirmed';
    } catch (err) {
        // `fetchOAuthToken` raises a 400 `invalid_grant` as IntegrationAuthError:
        // a token Google no longer honours is a revoked one.
        if ((err as { name?: string } | null)?.name === 'IntegrationAuthError') return 'revoked';
        return 'not-confirmed';
    }
}
