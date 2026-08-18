/**
 * Our own request errors must not be reported as revoked credentials.
 *
 * Both cases here produce a token-endpoint rejection that is caused by
 * something on OUR side — a clock, a missing secret — and both were surfacing
 * as "this connection's credentials are revoked". That is the expensive
 * direction to be wrong in: `markAuthFailure` writes `authFailedAt`, and
 * `shouldBypassQueueRetry` strips the job of its retries, so a transient local
 * problem became a permanent verdict about the customer's credentials.
 *
 * Neither test asserts an error MESSAGE. They assert the properties that decide
 * what happens next: whether a request is made at all, and which error class
 * comes out — because the class is what `markAuthFailure` and
 * `shouldBypassQueueRetry` branch on.
 */
import { getEntraAccessToken } from '@/app-layer/integrations/providers/entra-id';
import { getGoogleAccessToken } from '@/app-layer/integrations/providers/google-workspace';
import {
    IntegrationAuthError,
    IntegrationTerminalError,
    shouldBypassQueueRetry,
} from '@/app-layer/integrations/http-resilience';

/** A throwaway RSA key so the assertion can actually be signed. */
function makeServiceAccountJson(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return JSON.stringify({
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
}

describe('Google DWD assertion leaves room for clock skew', () => {
    it('requests less than the 3600s maximum, so a fast host still authenticates', async () => {
        // Google validates `exp` against ITS clock. Asking for exactly 3600
        // means the assertion is valid only while our clock is at or behind
        // Google's — a host a second fast gets 400 invalid_grant on EVERY sync,
        // which reads as a revoked grant while the grant is fine.
        let sentBody = '';
        const capturingFetch = (async (_url: unknown, init?: RequestInit) => {
            sentBody = String(init?.body ?? '');
            return new Response(JSON.stringify({ access_token: 'tok' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof fetch;

        await getGoogleAccessToken(
            { serviceAccountJson: makeServiceAccountJson(), adminEmail: 'admin@example.com' },
            capturingFetch,
        );

        const assertion = new URLSearchParams(sentBody).get('assertion');
        expect(assertion).toBeTruthy();

        const payload = JSON.parse(
            Buffer.from(assertion!.split('.')[1], 'base64url').toString('utf8'),
        ) as { iat: number; exp: number };

        const lifetime = payload.exp - payload.iat;
        expect(lifetime).toBeLessThan(3600);
        // A margin too small to absorb realistic drift is the same bug with a
        // smaller number, so pin a floor on the tolerance as well.
        expect(3600 - lifetime).toBeGreaterThanOrEqual(120);
    });
});

describe('Entra refuses to post an empty client secret', () => {
    const CONFIG = { tenantId: 'tenant-1', clientId: 'client-1' };

    it('does not make the request at all when the secret is missing', async () => {
        // Entra answers an empty secret with 401 AADSTS7000218 — our malformed
        // request — and resilientFetch turns EVERY 401 into IntegrationAuthError.
        // Not sending it is what keeps that verdict off the connection.
        const doFetch = jest.fn();
        await expect(
            getEntraAccessToken(CONFIG, doFetch as unknown as typeof fetch),
        ).rejects.toThrow();
        expect(doFetch).not.toHaveBeenCalled();
    });

    it('throws a class that neither marks the connection nor kills the retries', async () => {
        // The distinction that matters:
        //   IntegrationAuthError     -> markAuthFailure writes authFailedAt
        //   IntegrationTerminalError -> shouldBypassQueueRetry strips retries
        //   plain Error              -> neither
        // A secret missing because it failed to decrypt may well be there on the
        // next attempt, so this must stay retryable.
        const err = await getEntraAccessToken(
            CONFIG,
            (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(IntegrationAuthError);
        expect(err).not.toBeInstanceOf(IntegrationTerminalError);
        expect(shouldBypassQueueRetry(err)).toBe(false);
    });

    it('still performs the exchange when a secret IS present', async () => {
        // Guard against "fixing" the false positive by refusing everything.
        const doFetch = jest.fn(async () =>
            new Response(JSON.stringify({ access_token: 'tok' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        await expect(
            getEntraAccessToken({ ...CONFIG, clientSecret: 'shh' }, doFetch as unknown as typeof fetch),
        ).resolves.toBe('tok');
        expect(doFetch).toHaveBeenCalledTimes(1);
    });
});
