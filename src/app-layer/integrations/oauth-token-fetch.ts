/**
 * Credential classification for OAuth2 token endpoints.
 *
 * ## The gap this closes
 *
 * `resilientFetch` classifies by STATUS: 401/403 become `IntegrationAuthError`,
 * 404 becomes `IntegrationTerminalError`, 429/5xx retry. 400 is in none of those
 * sets, so the `Response` is handed back to the caller.
 *
 * But RFC 6749 §5.2 puts a token endpoint's failure code in a **400** body, and
 * that is where the dominant real-world credential failures live: a revoked
 * Google domain-wide-delegation grant answers `400 invalid_grant`, an expired
 * Entra client secret `400 invalid_client`. Those reached the caller's own
 * `!res.ok` line, became a plain `Error`, and `markAuthFailure` — which marks
 * only for `IntegrationAuthError` — silently returned false. The connection kept
 * rendering as healthy while every sync failed.
 *
 * ## Why this is a wrapper and not a change to resilientFetch
 *
 * Two reasons, both load-bearing.
 *
 * It must be OPT-IN, because a 400 from an ordinary REST endpoint means
 * something entirely different — a malformed query, not a dead credential.
 * Widening the global status sets would start accusing working connections the
 * first time any provider sent a bad request.
 *
 * And it must be ADDITIVE. Every 401/403 already marks today, unconditionally
 * and without inspecting the body. An earlier draft of this routed 401 through
 * the same allowlist, which reads as a tightening and is actually a narrowing:
 * a provider that reports a disabled key as 401 with a vendor-specific code
 * would have stopped marking, silently removing a signal that works. So 401/403
 * are not touched here — `RETRYABLE_STATUS` / `AUTH_STATUS` / `TERMINAL_STATUS`
 * stay exactly as they are, and this only adds a verdict where there was none.
 */
import { IntegrationAuthError, resilientFetch } from './http-resilience';
import { safeUrl } from './bounded-fetch';

/**
 * RFC 6749 §5.2 codes that mean THE CREDENTIAL IS BAD.
 *
 * Deliberately excluded, because they indicate our own malformed request or a
 * configuration problem rather than a revoked credential — marking on them would
 * turn a bug of ours into an accusation about the customer's credentials:
 *
 *   invalid_request         a malformed request — ours to fix
 *   unsupported_grant_type  a misconfigured grant — ours to fix
 *   invalid_scope           the requested scope is wrong — configuration
 */
const CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
    'invalid_grant',
    'invalid_client',
    'unauthorized_client',
]);

/**
 * Read the RFC 6749 error code, or null if this is not a credential failure.
 *
 * Never throws. An unreadable or unrecognised body must leave the caller's
 * existing behaviour untouched — "we could not tell" is not a verdict, and
 * turning it into one would cost the job its retries.
 */
async function credentialErrorCode(res: Response): Promise<string | null> {
    const contentType = res.headers?.get?.('content-type') ?? '';
    // Microsoft and Workday gateways answer with HTML on some failures, and a
    // JSON.parse of an error page is not a credential verdict.
    if (!contentType.toLowerCase().includes('json')) return null;
    try {
        // clone() so the caller's own `await res.json()` still works on the
        // non-credential path — a Response body can only be read once.
        const body: unknown = await res.clone().json();
        const code = (body as { error?: unknown } | null)?.error;
        return typeof code === 'string' && CREDENTIAL_ERROR_CODES.has(code) ? code : null;
    } catch {
        return null;
    }
}

/**
 * `resilientFetch` for an OAuth2 token endpoint: same deadline, same 429
 * handling, plus a credential verdict on a 400 body.
 *
 * Returns the `Response` unchanged unless the body says the credential is bad,
 * in which case it throws `IntegrationAuthError` so `markAuthFailure` can record
 * it. Callers keep their existing `!res.ok` handling for every other failure.
 */
export async function fetchOAuthToken(
    input: string,
    init?: RequestInit,
    doFetch: typeof fetch = resilientFetch,
): Promise<Response> {
    const res = await doFetch(input, init);
    // ONLY 400. 401/403 never reach here — resilientFetch has already thrown.
    if (res.status !== 400) return res;

    const code = await credentialErrorCode(res);
    if (code === null) return res;

    // `code` comes from CREDENTIAL_ERROR_CODES, never from the body verbatim.
    // IntegrationAuthError's message is persisted into
    // IntegrationConnection.authFailureReason, which is exempt from field
    // encryption on the recorded grounds that it is system-generated and
    // URL-scrubbed by safeUrl. safeUrl scrubs URLs, not bodies — an
    // error_description can carry a client id, a service-account email or an
    // assertion fragment, so nothing from the body is interpolated here.
    throw new IntegrationAuthError(400, safeUrl(input), code);
}
