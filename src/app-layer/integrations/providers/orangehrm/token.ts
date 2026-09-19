/**
 * OrangeHRM OAuth2 token exchange — client credentials, minted per run.
 *
 * ═══ WHY THIS IS NOT `providers/workday/token.ts` ═══
 *
 * Workday's module is an authorization-code lifecycle: it stores a refresh
 * token, rotates it, and has to persist the rotation AT THE MOMENT it happens
 * because Workday invalidates the predecessor. All of that exists to protect a
 * long-lived grant.
 *
 * The client-credentials grant has no long-lived grant to protect. There is no
 * refresh token, nothing rotates, and a token is minted from the stored client
 * id + secret on every run. So this module is one POST, `HrisSyncDeps.persistSecret`
 * is deliberately unused, and the whole class of "the sync threw after the
 * token rotated and took the new refresh token with it" bugs does not arise.
 *
 * Stating that explicitly because the absence is the kind of thing a reader
 * mistakes for an omission and "fixes" by copying Workday's persist callback in.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
 *
 * Classify credential failure. OAuth2 signals a revoked or invalid client with
 * HTTP 400 and an `error` body (RFC 6749 §5.2 — `invalid_client`), not 401.
 * `resilientFetch` classifies by status and 400 is in none of its sets, so a
 * revoked OrangeHRM client surfaces as a generic failure and does NOT mark the
 * connection. That is the same known, shared gap the Workday, Google DWD and
 * Entra token exchanges have; closing it means classifying an OAuth error BODY,
 * which should be solved once for every provider rather than a fourth time here.
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

/**
 * Scopes requested from OrangeHRM.
 *
 * An explicit constant rather than an inline string, mirroring
 * `WORKDAY_SCOPES`, so what the integration is asking for is reviewable in one
 * place. OrangeHRM's API scopes are coarse; the PIM read is covered by the
 * default scope granted to an API client, so this is empty by intent rather
 * than by omission — an empty `scope` parameter is not sent at all.
 */
export const ORANGEHRM_SCOPES: readonly string[] = [];

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
 * this class carries only the 400. That remains the same known, shared gap the
 * Workday, Google DWD and Entra token exchanges have, and closing it still
 * belongs solved once for every provider rather than a fourth time here. A 400
 * is enough for the preflight, which needs "proven, and it is a property of the
 * credential" rather than which OAuth error name the vendor chose.
 */
export class OrangeHrmTokenError extends Error {
    readonly status: number;
    constructor(status: number) {
        super(`OrangeHRM token request failed: ${status}`);
        this.name = 'OrangeHrmTokenError';
        this.status = status;
    }
}

/** Per-connection OAuth2 client identity. Neither field has an env default. */
export interface OrangeHrmOAuthClient {
    /** Instance host — bare hostname or full URL; validated against the allowlist. */
    host: string;
    clientId: string;
    clientSecret: string;
}

/**
 * Build the token endpoint for an instance.
 *
 * `assertOrangeHrmHost`, not a string trim: this request carries the client
 * credentials in a Basic header and `host` comes from `configJson`. See
 * `./host` for what an unvalidated host would otherwise allow.
 */
export function orangeHrmTokenEndpoint(client: OrangeHrmOAuthClient): string {
    const host = assertOrangeHrmHost(client.host);
    return `https://${host}${ORANGEHRM_WEB_ROOT}/oauth2/token`;
}

/**
 * Mint an access token from the stored client credentials.
 *
 * Returns the token only. There is no expiry to record, because nothing is
 * stored: the next run mints another. Trading one extra POST per nightly sync
 * for having no token lifecycle at all is the right side of that bargain for a
 * once-a-night read.
 */
export async function fetchOrangeHrmAccessToken(
    client: OrangeHrmOAuthClient,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
    const doFetch = deps.fetchImpl ?? resilientFetch;
    if (!client.clientId || !client.clientSecret) {
        throw new Error('OrangeHRM client id and client secret are required');
    }

    const body: Record<string, string> = { grant_type: 'client_credentials' };
    if (ORANGEHRM_SCOPES.length) body.scope = ORANGEHRM_SCOPES.join(' ');

    const res = await doFetch(orangeHrmTokenEndpoint(client), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            // In the Basic header rather than the form body, so the secret
            // stays out of any request-body logging a proxy in front of the
            // instance might do.
            Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams(body),
    });
    if (!res.ok) throw new OrangeHrmTokenError(res.status);

    const data = (await res.json()) as { access_token?: string };
    // An empty-but-200 response must not become an empty Bearer header: that
    // request would come back 401 from a DIFFERENT endpoint and read as a
    // credential problem at the roster, several frames away from the token
    // exchange that actually failed.
    if (!data.access_token) {
        throw new Error('OrangeHRM token response carried no access_token');
    }
    return data.access_token;
}
