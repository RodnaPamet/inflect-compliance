/**
 * OAuth2 token endpoints report credential failure with 400, not 401.
 *
 * `resilientFetch` classifies by status, and 400 is in none of its sets — so a
 * revoked Google domain-wide-delegation grant (`400 invalid_grant`) or an
 * expired Entra client secret (`400 invalid_client`) reached the caller's own
 * `!res.ok` line, became a plain `Error`, and `markAuthFailure` — which marks
 * only for `IntegrationAuthError` — silently returned false. The connection kept
 * rendering as healthy while every sync failed.
 *
 * The assertions below are grouped around the two ways this can be wrong, and
 * the second is the one that would look like an improvement:
 *
 *   FALSE POSITIVE — marking on a 400 that is OUR malformed request, which turns
 *   a bug of ours into an accusation about the customer's credentials.
 *
 *   NARROWING — the rule must be ADDITIVE. Every 401/403 already marks today
 *   without body inspection, so routing those through the same allowlist would
 *   silently stop marking failures that are currently caught.
 */
import { fetchOAuthToken } from '@/app-layer/integrations/oauth-token-fetch';
import {
    IntegrationAuthError,
    shouldBypassQueueRetry,
} from '@/app-layer/integrations/http-resilience';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

const fetchReturning = (res: Response): typeof fetch =>
    (async () => res) as unknown as typeof fetch;

const URL_UNDER_TEST = 'https://oauth2.googleapis.com/token';

describe('a 400 whose body names a bad credential', () => {
    it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
        'throws IntegrationAuthError for %s, so markAuthFailure can record it',
        async (code) => {
            const err = await fetchOAuthToken(
                URL_UNDER_TEST,
                {},
                fetchReturning(json(400, { error: code })),
            ).catch((e: unknown) => e);

            expect(err).toBeInstanceOf(IntegrationAuthError);
            expect((err as IntegrationAuthError).reason).toBe(code);
            // Terminal, so the queue does not spend three attempts on a
            // credential that will not fix itself.
            expect(shouldBypassQueueRetry(err)).toBe(true);
        },
    );

    it('never puts the response body in the error message', async () => {
        // authFailureReason is exempt from field encryption on the recorded
        // grounds that it is system-generated and URL-scrubbed by safeUrl.
        // safeUrl scrubs URLs, not bodies — and error_description is exactly
        // where a provider puts identifying detail.
        const err = (await fetchOAuthToken(
            `${URL_UNDER_TEST}?client_id=SECRET-CLIENT&assertion=SECRET-JWT`,
            {},
            fetchReturning(
                json(400, {
                    error: 'invalid_grant',
                    error_description: 'svc@acme.iam.gserviceaccount.com is not authorised',
                }),
            ),
        ).catch((e: unknown) => e)) as Error;

        expect(err.message).toContain('invalid_grant');
        expect(err.message).not.toContain('gserviceaccount');
        expect(err.message).not.toContain('SECRET-CLIENT');
        expect(err.message).not.toContain('SECRET-JWT');
    });
});

describe('a 400 that is OUR fault must not accuse the customer', () => {
    it.each(['invalid_request', 'unsupported_grant_type', 'invalid_scope'])(
        'passes %s through untouched rather than marking',
        async (code) => {
            const res = await fetchOAuthToken(
                URL_UNDER_TEST,
                {},
                fetchReturning(json(400, { error: code })),
            );
            expect(res.status).toBe(400);
            // And the caller can still read it — clone() left the body intact.
            await expect(res.json()).resolves.toEqual({ error: code });
        },
    );

    it('passes an unparseable or non-JSON body through, since "cannot tell" is not a verdict', async () => {
        // Microsoft and Workday gateways answer with HTML on some failures.
        const html = new Response('<html>Gateway Error</html>', {
            status: 400,
            headers: { 'content-type': 'text/html' },
        });
        await expect(fetchOAuthToken(URL_UNDER_TEST, {}, fetchReturning(html))).resolves.toMatchObject({
            status: 400,
        });

        const brokenJson = new Response('{not json', {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
        await expect(
            fetchOAuthToken(URL_UNDER_TEST, {}, fetchReturning(brokenJson)),
        ).resolves.toMatchObject({ status: 400 });
    });
});

describe('the rule is additive — nothing that marked before stops marking', () => {
    it('leaves a 2xx alone', async () => {
        const res = await fetchOAuthToken(
            URL_UNDER_TEST,
            {},
            fetchReturning(json(200, { access_token: 'tok' })),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ access_token: 'tok' });
    });

    it('does not inspect the body of a 401 — that path already threw upstream', async () => {
        // resilientFetch throws IntegrationAuthError for 401/403 before this
        // wrapper ever sees a Response. The danger is a future edit that starts
        // gating 401 on the same allowlist: a provider reporting a disabled key
        // as 401 with a vendor-specific code would silently STOP marking.
        //
        // Simulated here with a transport that returns a 401 the wrapper must
        // not second-guess. It is passed straight through, so the classification
        // upstream stays the only authority on 401.
        // The body carries an ALLOWLISTED code deliberately. An earlier version
        // of this test used a vendor-specific one, which passed through whether
        // or not 401 was being inspected — so it asserted nothing. Using
        // invalid_grant means the only way this returns a Response is if the
        // wrapper genuinely ignores 401.
        const res = await fetchOAuthToken(
            URL_UNDER_TEST,
            {},
            fetchReturning(json(401, { error: 'invalid_grant' })),
        );
        expect(res.status).toBe(401);
    });

    it('leaves a 500 to the retry layer rather than calling it a credential failure', async () => {
        const res = await fetchOAuthToken(
            URL_UNDER_TEST,
            {},
            fetchReturning(json(500, { error: 'invalid_grant' })),
        );
        // Even a credential-shaped code on a 5xx is not a credential verdict —
        // a broken gateway can echo anything.
        expect(res.status).toBe(500);
    });
});
