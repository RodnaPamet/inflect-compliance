/**
 * ATTACHING AN OAUTH CREDENTIAL TO AN ORANGEHRM CONNECTION (#3594).
 *
 * This flow did not exist. `providers/orangehrm` minted a token from the stored
 * client credentials on every run, and OrangeHRM 5.x does not implement that
 * grant — so a human has to authorize the connection once, and the refresh
 * token that comes back is the credential every later run depends on.
 *
 * Four properties matter more than the happy path:
 *
 *   · a connection that is not READY is refused BEFORE the admin is sent to
 *     the instance. Redirecting a half-configured connection returns a code
 *     that cannot be exchanged, after the admin has already consented.
 *   · the token pair is MERGED into the existing secrets. Replacing the blob
 *     would drop the `clientSecret` beside it — and unlike the MCP flow, every
 *     later REFRESH needs that secret, so the connection would die at the first
 *     expiry rather than immediately.
 *   · the audit row records WHO authorized WHAT and carries no credential. It
 *     streams to a SIEM; a refresh token in it would be a second place to steal
 *     the connection from.
 *   · the flow is REACHABLE. #3595 is the same feature in another provider
 *     where the token module is complete and nothing calls it, so the authorize
 *     URL can never be built — the last describe here is that lesson applied.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const mockTx = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

const exchangeMock = jest.fn();
jest.mock('@/app-layer/integrations/providers/orangehrm/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/providers/orangehrm/token'),
    exchangeCodeForOrangeHrmToken: (...a: unknown[]) => exchangeMock(...a),
}));

const logEventMock = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }));

jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: (s: string) => s,
    encryptField: (s: string) => s,
}));

jest.mock('@/app-layer/policies/common', () => ({
    ...jest.requireActual('@/app-layer/policies/common'),
    assertCanAdmin: jest.fn(),
}));

import {
    completeOrangeHrmConsent,
    orangeHrmConsentTarget,
} from '@/app-layer/usecases/orangehrm-connection-consent';

const ctx = { tenantId: 'tnt_1', userId: 'usr_9' } as never;
const CONN = 'cmconnbbb';
const HOST = 'acme.orangehrmlive.com';

const ready = {
    id: CONN,
    name: 'Acme OrangeHRM',
    configJson: { baseUrl: HOST, clientId: 'cid' },
    secretEncrypted: JSON.stringify({ clientSecret: 'csecret' }),
};

const PAIR = { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1_700_000_000 };

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.integrationConnection.findFirst.mockResolvedValue(ready);
    mockTx.integrationConnection.update.mockResolvedValue({});
    exchangeMock.mockResolvedValue(PAIR);
});

describe('a connection that is not ready', () => {
    for (const [label, row] of [
        ['no instance URL', { ...ready, configJson: { clientId: 'cid' } }],
        ['no client id', { ...ready, configJson: { baseUrl: HOST } }],
        ['no client secret', { ...ready, secretEncrypted: null }],
    ] as const) {
        it(`is refused before any exchange — ${label}`, async () => {
            mockTx.integrationConnection.findFirst.mockResolvedValue(row);
            await expect(orangeHrmConsentTarget(ctx, CONN)).rejects.toThrow(/not ready to authorize/);
            expect(exchangeMock).not.toHaveBeenCalled();
        });
    }

    it('is not found when it belongs to another tenant', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(orangeHrmConsentTarget(ctx, CONN)).rejects.toThrow(/not found/i);
    });

    it('hands back the host and client id, never the secret', async () => {
        const t = await orangeHrmConsentTarget(ctx, CONN);
        expect(t).toEqual({ host: HOST, clientId: 'cid' });
        // The host is returned as well as the client id — unlike Entra, the
        // authorize endpoint is on the customer's own instance.
        expect(JSON.stringify(t)).not.toContain('csecret');
    });
});

describe('completing the consent', () => {
    it('stores the token pair ALONGSIDE the client secret, not instead of it', async () => {
        await completeOrangeHrmConsent(ctx, { connectionId: CONN, code: 'code-1', redirectUri: 'https://app.test/cb' });

        const written = JSON.parse(
            (mockTx.integrationConnection.update.mock.calls[0][0] as { data: { secretEncrypted: string } })
                .data.secretEncrypted,
        ) as Record<string, unknown>;

        // Every later REFRESH needs the client secret, so dropping it here
        // would not break the connection now — it would break it at the first
        // expiry, hours later, as an unrelated-looking failure.
        expect(written.clientSecret).toBe('csecret');
        expect(written.refreshToken).toBe('r1');
        expect(written.accessToken).toBe('a1');
        expect(written.expiresAt).toBe(1_700_000_000);
    });

    it('passes the code and redirect URI through to the exchange unchanged', async () => {
        await completeOrangeHrmConsent(ctx, { connectionId: CONN, code: 'code-1', redirectUri: 'https://app.test/cb' });
        // The redirect URI must byte-match the one sent to the authorize
        // endpoint: league/oauth2-server compares them and answers
        // `invalid_grant` on any difference, including a trailing slash.
        expect(exchangeMock).toHaveBeenCalledWith({
            client: { host: HOST, clientId: 'cid', clientSecret: 'csecret' },
            code: 'code-1',
            redirectUri: 'https://app.test/cb',
        });
    });

    it('requires an authorizing user', async () => {
        await expect(
            completeOrangeHrmConsent({ tenantId: 'tnt_1' } as never, {
                connectionId: CONN,
                code: 'c',
                redirectUri: 'https://app.test/cb',
            }),
        ).rejects.toThrow(/authorizing user/i);
        expect(exchangeMock).not.toHaveBeenCalled();
    });

    it('writes nothing when the exchange fails', async () => {
        exchangeMock.mockRejectedValue(new Error('OrangeHRM token request failed: 401'));
        await expect(
            completeOrangeHrmConsent(ctx, { connectionId: CONN, code: 'c', redirectUri: 'https://app.test/cb' }),
        ).rejects.toThrow('401');
        expect(mockTx.integrationConnection.update).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });
});

describe('the audit row is accountable without being a credential store', () => {
    it('names who authorized what, and carries NO credential', async () => {
        await completeOrangeHrmConsent(ctx, { connectionId: CONN, code: 'code-1', redirectUri: 'https://app.test/cb' });

        const [, , entry] = logEventMock.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
        expect(entry.action).toBe('ORANGEHRM_CONNECTION_AUTHORIZED');
        const details = entry.detailsJson as Record<string, unknown>;
        expect(details.authorizedByUserId).toBe('usr_9');
        expect(details.instanceHost).toBe(HOST);
        expect(details.clientId).toBe('cid');
        // The expiry IS safe and is the one fact worth keeping: it makes "the
        // connection stopped working on the 14th" answerable without reading a
        // secret.
        expect(details.accessTokenExpiresAt).toBe(1_700_000_000);

        // Whole-row, not field-by-field: a future field carrying a credential
        // would pass a per-field allowlist that nobody remembered to extend.
        const blob = JSON.stringify(entry);
        for (const secret of ['csecret', 'r1', 'a1', 'code-1']) {
            expect(blob).not.toContain(secret);
        }
    });
});

describe('the flow is REACHABLE, which is the half #3595 is missing elsewhere', () => {
    // ═══ WHY A SOURCE SCAN AND NOT A UNIT ASSERTION ═══
    //
    // #3595: `providers/workday/token.ts` has a complete, correct
    // authorization-code lifecycle and NOTHING calls `buildWorkdayAuthorizeUrl`
    // or `exchangeCodeForWorkdayToken` — no connect route, no callback, no UI —
    // so a Workday connection can never obtain its first token. Every unit test
    // over those functions passes, because a test calling an exported function
    // proves the function works and never that anything calls it.
    //
    // These two assertions are that lesson applied to the provider this change
    // adds. They are deliberately narrow — the general guard across all
    // providers belongs to #3595.

    const ROOT = path.join(__dirname, '..', '..');

    /**
     * Masked, per `raw-source-assertion-ratchet`: comments blanked, string
     * literals kept, offsets preserved.
     *
     * It is not a formality here. Every assertion below names a CONSTRUCT —
     * `buildOrangeHrmAuthorizeUrl`, `state !== cookieState`, `assertCanAdmin` —
     * and an unmasked read would be satisfied by a comment mentioning any of
     * them. "Delete the call, keep the note explaining it" would be a green
     * diff, which is the precise failure these three tests exist to prevent.
     *
     * The positive control gains the most: `not.toContain('client_credentials')`
     * against raw source would fail the day somebody writes a comment saying
     * the grant was abandoned — a scar read as a wound.
     */
    const read = (p: string): string => codeOf(readFileSync(path.join(ROOT, p), 'utf8'));

    // ═══ WHY EVERY NEEDLE BELOW IS A CALL AND NOT AN IDENTIFIER ═══
    //
    // `toContain('buildOrangeHrmAuthorizeUrl')` matches the IMPORT as well as
    // the call, so deleting the call and keeping the import is a green diff —
    // which is the whole defect these tests are here to prevent, re-introduced
    // one level down. `assertion-needle-uniqueness-ratchet` counts exactly this
    // and failed on the first draft with +6.
    //
    // The call forms are unique in their files AND they assert the thing that
    // matters, so the needles got stronger rather than merely compliant.

    it('a route builds the authorize URL', () => {
        const route = read(
            'src/app/api/t/[tenantSlug]/admin/integrations/[connectionId]/orangehrm-consent/route.ts',
        );
        expect(route).toContain('buildOrangeHrmAuthorizeUrl({');
        expect(route).toContain('orangeHrmConsentTarget(ctx,');
        // The state cookie is what makes the tenant-agnostic callback safe, and
        // this needle asserts it is SET rather than merely mentioned.
        expect(route).toContain("res.cookies.set('ohrm_oauth_state'");
    });

    it('a route completes the exchange, and verifies the state before it does', () => {
        const route = read('src/app/api/integrations/orangehrm/callback/route.ts');
        expect(route).toContain('completeOrangeHrmConsent(ctx,');
        expect(route).toContain("req.cookies.get('ohrm_oauth_state')");
        // Re-authorised from the session, never from the URL.
        expect(route).toContain('getTenantCtx({ tenantSlug })');
        expect(route).toContain('assertCanAdmin(ctx)');
        // The CSRF check itself. Without this comparison the callback would act
        // on any code delivered to it.
        expect(route).toContain('state !== cookieState');
    });

    it('POSITIVE CONTROL — the reader finds a string that is NOT there', () => {
        // Without this, a path typo makes `read` throw (caught by jest) or the
        // assertions above pass over the wrong file. This proves the file being
        // read is the one meant, by checking a thing it must NOT contain: the
        // grant that started all of this.
        const route = read('src/app/api/integrations/orangehrm/callback/route.ts');
        expect(route).not.toContain('client_credentials');
    });
});
