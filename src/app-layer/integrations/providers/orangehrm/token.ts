/**
 * OrangeHRM OAuth2 token exchange — authorization code, with refresh rotation.
 *
 * ═══ WHY THIS IS NOT THE CLIENT-CREDENTIALS MODULE IT USED TO BE ═══
 *
 * It was, and the grant does not exist. #3594: OrangeHRM 5.x enables only
 * `AuthCodeGrant` and `RefreshTokenGrant` —
 * `plugins/orangehrmCoreOAuthPlugin/Server/OAuthServer.php` constructs exactly
 * those two, unconditionally, with no configuration flag, and
 * `ClientCredentialsGrant.php` sits unused in the vendored
 * `league/oauth2-server`. Measured against `orangehrm/orangehrm:5.9` with
 * deliberately bogus credentials, so the answer was about the grant rather than
 * about a secret:
 *
 *   grant_type=client_credentials     400  unsupported_grant_type
 *   grant_type=authorization_code     401  invalid_client
 *   grant_type=not_a_real_grant_name  400  unsupported_grant_type
 *
 * The third row is the control, and it is the proof: `client_credentials` was
 * indistinguishable from a grant name invented for the probe, while a grant the
 * server DOES implement got as far as client authentication. The previous
 * module's whole premise — "there is no refresh token, nothing rotates" — was a
 * statement about a flow this product does not offer, and 120 green tests
 * agreed with it because the fake was written from the same assumption.
 *
 * So this module is Workday's lifecycle, not Workday's transport. See
 * `providers/workday/token.ts`: same four functions, same rotation trap avoided
 * the same way. `HrisSyncDeps.persistSecret`, which the old module said was
 * "deliberately unused", is now the thing that keeps a connection alive.
 *
 * ═══ THE CREDENTIALS GO IN THE BODY, AND THAT IS MEASURED TOO ═══
 *
 * RFC 6749 §2.3.1 says a server MUST support HTTP Basic for client
 * authentication, and this one effectively does not at this endpoint:
 * OrangeHRM's REST Bearer middleware claims any request carrying an
 * `Authorization` header before the OAuth server evaluates it. Same grant, same
 * bogus credentials, only the placement differs:
 *
 *   authorization_code, credentials in the BODY    401  invalid_client
 *   authorization_code, credentials in a Basic hdr 401  "Unexpected error
 *                                                       occurred while
 *                                                       evaluating the
 *                                                       `Bearer` token"
 *
 * The first reached the OAuth server. The second never did. The old module put
 * them in the header for a good reason — keeping the secret out of any
 * request-body logging a proxy in front of the instance might do — and this
 * product defeats it. The reason is recorded here rather than deleted, because
 * it is the right default everywhere it works, and a future reader moving these
 * back into a header needs to know it was tried.
 *
 * ═══ WHAT AN OPERATOR HAS TO DO, WHICH NO CODE HERE CAN DO FOR THEM ═══
 *
 * Register a CONFIDENTIAL OAuth client in the instance (Admin → Configuration →
 * OAuth Clients) whose redirect URI is this deployment's
 * `/api/integrations/orangehrm/callback`. Three properties of that registration
 * were measured and are easy to get wrong:
 *
 *  - It must be confidential. `AuthCodeGrant` requires PKCE for PUBLIC clients
 *    only (`requireCodeChallengeForPublicClients`), and this flow sends no
 *    `code_verifier`. The instance's stock `orangehrm_mobile_app` client is
 *    public, which is why it cannot be reused.
 *  - OrangeHRM BCRYPTS the client secret (`ClientRepository::validateClientSecret`
 *    → `PasswordHash::verify`). A secret written straight into
 *    `ohrm_oauth2_client.client_secret` as plaintext can never authenticate.
 *  - Doctrine caches the client row. A registration made below the UI needs
 *    `src/cache/doctrine_queries` cleared before the server will see it — which
 *    is how the first four probes in #3594 came to be indistinguishable from a
 *    client that did not exist.
 *
 * @module integrations/providers/orangehrm/token
 */
import { resilientFetch } from '../../http-resilience';
import { assertOrangeHrmHost } from './host';

/**
 * OrangeHRM 5.x serves its whole web application, API included, under this
 * prefix. Stated once as a constant so the token endpoint and the roster
 * endpoint cannot drift apart, and so the one assumption most likely to be
 * wrong about a self-hosted deployment is findable by grep.
 */
export const ORANGEHRM_WEB_ROOT = '/web/index.php';

/** Refresh this many seconds before the recorded expiry. Mirrors Workday's. */
const EXPIRY_SKEW_SECONDS = 60;

/**
 * Scopes requested from OrangeHRM: none, and now for a measured reason rather
 * than an assumed one.
 *
 * `ohrm_oauth_scope` is EMPTY in a stock 5.9 instance — the product defines no
 * scopes at all — so there is nothing to ask for and an empty `scope` parameter
 * is not sent. The previous note guessed that "the PIM read is covered by the
 * default scope granted to an API client", which was right by accident.
 */
export const ORANGEHRM_SCOPES: readonly string[] = [];

/**
 * The shape persisted (encrypted) in `IntegrationConnection.secretEncrypted`,
 * alongside the `clientSecret` the operator entered.
 *
 * Identical to `WorkdaySecret` and `SharePointSecret` by design — same
 * lifecycle, same fields, same rotation hazard.
 */
export interface OrangeHrmSecret {
    accessToken: string;
    refreshToken: string;
    /** Unix seconds. */
    expiresAt: number;
}

/** Per-connection OAuth2 client identity. Neither field has an env default. */
export interface OrangeHrmOAuthClient {
    /** Instance host — bare hostname or full URL; validated against the allowlist. */
    host: string;
    clientId: string;
    clientSecret: string;
}

/**
 * A token exchange that came back with a status, CARRYING the status.
 *
 * ═══ WHY A CLASS AND NOT THE STRING IT REPLACES ═══
 *
 * The message is byte-identical to the plain `Error` this replaced, so nothing
 * reading it changes. What changes is that a caller can now ASK for the status
 * instead of parsing it back out of prose — and one caller has to:
 * `write-back-preflight.ts` classifies a credential failure by
 * `docs/jml-hris-write-back-design.md` Decision 4's rule (a 400/401/403/404 is
 * PROVEN, a 5xx or a lost response is not), and a refusal decided once for a
 * whole batch is sound only when it is proven. Recovering the number from a
 * message is the shape that silently starts answering "unknown" the day
 * somebody rewords the sentence.
 *
 * ═══ WHAT IT STILL DOES NOT DO ═══
 *
 * Classify the OAuth error BODY. OAuth2 signals a revoked or invalid client
 * with HTTP 400 and an `error` body (RFC 6749 §5.2 — `invalid_client`), and
 * this class carries only the status. That remains the same known, shared gap
 * the Workday, Google DWD and Entra token exchanges have, and closing it still
 * belongs solved once for every provider rather than a fourth time here.
 *
 * It matters slightly more now than it did: #3594's whole diagnosis turned on
 * `unsupported_grant_type` versus `invalid_client`, two bodies behind a 400 and
 * a 401 that this class cannot tell apart. A reader chasing the next version of
 * that problem should know the information is being dropped here.
 */
export class OrangeHrmTokenError extends Error {
    readonly status: number;
    constructor(status: number) {
        super(`OrangeHRM token request failed: ${status}`);
        this.name = 'OrangeHrmTokenError';
        this.status = status;
    }
}

/**
 * Build the token endpoint for an instance.
 *
 * `assertOrangeHrmHost`, not a string trim: this request carries the client
 * credentials and `host` comes from `configJson`. See `./host` for what an
 * unvalidated host would otherwise allow.
 */
export function orangeHrmTokenEndpoint(client: OrangeHrmOAuthClient): string {
    const host = assertOrangeHrmHost(client.host);
    return `https://${host}${ORANGEHRM_WEB_ROOT}/oauth2/token`;
}

/** The consent endpoint, validated through the same allowlist for the same reason. */
export function orangeHrmAuthorizeEndpoint(client: Pick<OrangeHrmOAuthClient, 'host'>): string {
    const host = assertOrangeHrmHost(client.host);
    return `https://${host}${ORANGEHRM_WEB_ROOT}/oauth2/authorize`;
}

/**
 * Build the authorization URL for the consent redirect.
 *
 * No `code_challenge`: the client must be CONFIDENTIAL (see the module note),
 * and `AuthCodeGrant` requires PKCE for public clients only. Sending a
 * challenge without a verifier at exchange time would fail the exchange, so the
 * two halves of that decision have to stay together — which is why this
 * function and `exchangeCodeForOrangeHrmToken` both say so.
 */
export function buildOrangeHrmAuthorizeUrl(opts: {
    client: Pick<OrangeHrmOAuthClient, 'host' | 'clientId'>;
    redirectUri: string;
    state: string;
}): string {
    if (!opts.client.clientId) throw new Error('OrangeHRM client id is required');
    const params = new URLSearchParams({
        client_id: opts.client.clientId,
        response_type: 'code',
        redirect_uri: opts.redirectUri,
        state: opts.state,
    });
    // Only when there is something to ask for — an empty `scope=` is not the
    // same request as no `scope` at all, and `ohrm_oauth_scope` is empty.
    if (ORANGEHRM_SCOPES.length) params.set('scope', ORANGEHRM_SCOPES.join(' '));
    return `${orangeHrmAuthorizeEndpoint(opts.client)}?${params.toString()}`;
}

/**
 * Shared POST to the instance's token endpoint.
 *
 * The client credentials go in the BODY. See the module docblock — this is the
 * measured half of #3594, not a style choice.
 */
async function postToken(
    client: OrangeHrmOAuthClient,
    body: Record<string, string>,
    fetchImpl: typeof fetch,
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
    if (!client.clientId || !client.clientSecret) {
        throw new Error('OrangeHRM client id and client secret are required');
    }
    const res = await fetchImpl(orangeHrmTokenEndpoint(client), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            ...body,
            client_id: client.clientId,
            client_secret: client.clientSecret,
        }),
    });
    if (!res.ok) throw new OrangeHrmTokenError(res.status);
    return (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
}

/**
 * Read a token response, refusing the three shapes that would otherwise become
 * a broken connection later rather than an error now.
 *
 * An empty-but-200 response must not become an empty Bearer header: that
 * request would come back 401 from a DIFFERENT endpoint and read as a
 * credential problem at the roster, several frames away from the token exchange
 * that actually failed.
 */
function readTokenPair(
    data: { access_token?: string; refresh_token?: string; expires_in?: number },
    fallbackRefreshToken: string | null,
    nowMs: number,
): OrangeHrmSecret {
    if (!data.access_token) {
        throw new Error('OrangeHRM token response carried no access_token');
    }
    const refreshToken = data.refresh_token ?? fallbackRefreshToken;
    if (!refreshToken) {
        // Without one, the connection works until the first expiry and then
        // dies silently at 04:00 some morning. Fail at consent instead.
        throw new Error(
            'OrangeHRM consent did not return a refresh token — the OAuth client must be '
            + 'registered as confidential and the refresh_token grant must be enabled',
        );
    }
    if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
        // An absent `expires_in` defaulted to anything is a guess about when to
        // refresh. Guessing LONG strands the connection; guessing SHORT burns a
        // refresh on every run and, with a rotating server, multiplies the
        // chance of losing the chain. Neither is better than saying so.
        throw new Error('OrangeHRM token response carried no usable expires_in');
    }
    return {
        accessToken: data.access_token,
        refreshToken,
        expiresAt: Math.floor(nowMs / 1000) + data.expires_in,
    };
}

/** Exchange an authorization code for the first token pair. */
export async function exchangeCodeForOrangeHrmToken(
    opts: { client: OrangeHrmOAuthClient; code: string; redirectUri: string },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<OrangeHrmSecret> {
    const fetchImpl = deps.fetchImpl ?? resilientFetch;
    const nowMs = deps.now ? deps.now() : Date.now();
    const data = await postToken(
        opts.client,
        // `redirect_uri` is REQUIRED here and must byte-match the one sent to
        // the authorize endpoint; league/oauth2-server compares them and
        // answers `invalid_grant` on a mismatch. The callers derive both from
        // the same `resolvePublicOrigin`, so they cannot disagree.
        //
        // No `code_verifier`: confidential client, no PKCE. See
        // `buildOrangeHrmAuthorizeUrl`.
        { grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri },
        fetchImpl,
    );
    return readTokenPair(data, null, nowMs);
}

/** Exchange a refresh token for a new pair. */
export async function refreshOrangeHrmToken(
    opts: { client: OrangeHrmOAuthClient; refreshToken: string },
    deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<OrangeHrmSecret> {
    const fetchImpl = deps.fetchImpl ?? resilientFetch;
    const nowMs = deps.now ? deps.now() : Date.now();
    const data = await postToken(
        opts.client,
        { grant_type: 'refresh_token', refresh_token: opts.refreshToken },
        fetchImpl,
    );
    // The current token is the fallback: `RefreshTokenGrant` MAY rotate and MAY
    // not. Overwriting with undefined un-authenticates the connection on the
    // NEXT run, which reads as an unrelated failure a day later — the same trap
    // Workday's and SharePoint's `?? current.refreshToken` avoid.
    return readTokenPair(data, opts.refreshToken, nowMs);
}

/**
 * Return a still-valid access token, refreshing and persisting the rotated pair
 * when the current one is within the expiry skew.
 *
 * Returns `rotated: null` when nothing changed, so the caller can skip a write
 * rather than re-encrypting an identical secret on every sync.
 */
export async function resolveOrangeHrmAccessToken(
    current: OrangeHrmSecret,
    opts: { client: OrangeHrmOAuthClient },
    deps: {
        now?: () => number;
        refresh?: (refreshToken: string) => Promise<OrangeHrmSecret>;
        persist?: (secret: OrangeHrmSecret) => Promise<void>;
        fetchImpl?: typeof fetch;
    } = {},
): Promise<{ accessToken: string; rotated: OrangeHrmSecret | null }> {
    const nowSeconds = (deps.now ? deps.now() : Date.now()) / 1000;
    if (nowSeconds < current.expiresAt - EXPIRY_SKEW_SECONDS) {
        return { accessToken: current.accessToken, rotated: null };
    }

    const rotated = deps.refresh
        ? await deps.refresh(current.refreshToken)
        : await refreshOrangeHrmToken(
            { client: opts.client, refreshToken: current.refreshToken },
            { fetchImpl: deps.fetchImpl, now: deps.now },
        );

    // Persist BEFORE returning, and before the caller spends the token on a
    // roster read. If the server rotated and the write is skipped, the stored
    // refresh token is already dead and the next run cannot authenticate —
    // which is the failure Workday's module exists to avoid persisting late.
    if (deps.persist) await deps.persist(rotated);
    return { accessToken: rotated.accessToken, rotated };
}

/**
 * Read an `OrangeHrmSecret` out of the merged config+secret bag, or say why
 * there isn't one.
 *
 * Returns `null` rather than throwing for the case that is not an error at all:
 * a connection saved with its client credentials but never taken through
 * consent. That connection is incomplete, not broken, and the caller's job is
 * to say "authorize this connection" rather than to report a malformed secret.
 */
export function readOrangeHrmSecret(merged: Record<string, unknown>): OrangeHrmSecret | null {
    const accessToken = typeof merged.accessToken === 'string' ? merged.accessToken : '';
    const refreshToken = typeof merged.refreshToken === 'string' ? merged.refreshToken : '';
    const expiresAt = typeof merged.expiresAt === 'number' ? merged.expiresAt : 0;
    if (!refreshToken) return null;
    // An access token may legitimately be absent or stale — that is what
    // `resolveOrangeHrmAccessToken` is for. `expiresAt: 0` forces a refresh,
    // which is the correct reading of "we hold a refresh token and nothing
    // trustworthy about the access token".
    return { accessToken, refreshToken, expiresAt };
}
