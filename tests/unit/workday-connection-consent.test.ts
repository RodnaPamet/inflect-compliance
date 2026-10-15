/**
 * ATTACHING AN OAUTH CREDENTIAL TO A WORKDAY CONNECTION (#3595).
 *
 * The token module for this flow has been complete and correct since it was
 * written, and nothing called it. `buildWorkdayAuthorizeUrl` and
 * `exchangeCodeForWorkdayToken` had no callers outside their own module — no
 * connect route, no callback, no UI — so a Workday connection could never
 * obtain its first refresh token, and the only live path was
 * `resolveWorkdayAccessToken`, which refreshes a token the system had no way to
 * acquire.
 *
 * The provider was never wrong about it: `validateConnection` already answers
 * "Workday is configured but not yet authorised — complete the OAuth consent to
 * connect", and `listEmployees` already throws the same. Both told an operator
 * to do something the product gave them no way to do.
 *
 * So the LAST describe here is the one that exists because of the defect, and
 * the rest exist because the credential is a refresh token:
 *
 *   · a connection that is not READY is refused BEFORE the admin is sent to
 *     Workday;
 *   · the token pair is MERGED, so the `clientSecret` beside it survives —
 *     every later refresh needs it, so dropping it would break the connection
 *     at the first expiry rather than immediately;
 *   · the audit row records WHO authorized WHAT and carries no credential;
 *   · and the flow is REACHABLE.
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
jest.mock('@/app-layer/integrations/providers/workday/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/providers/workday/token'),
    exchangeCodeForWorkdayToken: (...a: unknown[]) => exchangeMock(...a),
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
    completeWorkdayConsent,
    workdayConsentTarget,
} from '@/app-layer/usecases/workday-connection-consent';

const ctx = { tenantId: 'tnt_1', userId: 'usr_9' } as never;
const CONN = 'cmconnwdy';
const HOST = 'wd2-impl-services1.workday.com';
const TENANT = 'acme_preview';

const ready = {
    id: CONN,
    name: 'Acme Workday',
    configJson: { host: HOST, tenant: TENANT, clientId: 'cid', reportPath: '/ccx/service/customreport2/acme/x' },
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
        ['no host', { ...ready, configJson: { tenant: TENANT, clientId: 'cid' } }],
        ['no tenant', { ...ready, configJson: { host: HOST, clientId: 'cid' } }],
        ['no client id', { ...ready, configJson: { host: HOST, tenant: TENANT } }],
        ['no client secret', { ...ready, secretEncrypted: null }],
    ] as const) {
        it(`is refused before any exchange — ${label}`, async () => {
            mockTx.integrationConnection.findFirst.mockResolvedValue(row);
            await expect(workdayConsentTarget(ctx, CONN)).rejects.toThrow(/not ready to authorize/);
            expect(exchangeMock).not.toHaveBeenCalled();
        });
    }

    it('is not found when it belongs to another tenant', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(workdayConsentTarget(ctx, CONN)).rejects.toThrow(/not found/i);
    });

    it('hands back host, tenant and client id — never the secret', async () => {
        const t = await workdayConsentTarget(ctx, CONN);
        // The TENANT comes back too, unlike the OrangeHRM pair: Workday's
        // authorize endpoint is a tenant-scoped path, so the URL cannot be
        // built from the host alone.
        expect(t).toEqual({ host: HOST, tenant: TENANT, clientId: 'cid' });
        expect(JSON.stringify(t)).not.toContain('csecret');
    });
});

describe('completing the consent', () => {
    it('stores the token pair ALONGSIDE the client secret, not instead of it', async () => {
        await completeWorkdayConsent(ctx, { connectionId: CONN, code: 'code-1', redirectUri: 'https://app.test/cb' });

        const written = JSON.parse(
            (mockTx.integrationConnection.update.mock.calls[0][0] as { data: { secretEncrypted: string } })
                .data.secretEncrypted,
        ) as Record<string, unknown>;

        expect(written.clientSecret).toBe('csecret');
        expect(written.refreshToken).toBe('r1');
        expect(written.accessToken).toBe('a1');
        expect(written.expiresAt).toBe(1_700_000_000);
    });

    it('passes the whole client, the code and the redirect URI to the exchange', async () => {
        await completeWorkdayConsent(ctx, { connectionId: CONN, code: 'code-1', redirectUri: 'https://app.test/cb' });
        expect(exchangeMock).toHaveBeenCalledWith({
            client: { host: HOST, tenant: TENANT, clientId: 'cid', clientSecret: 'csecret' },
            code: 'code-1',
            redirectUri: 'https://app.test/cb',
        });
    });

    it('requires an authorizing user', async () => {
        await expect(
            completeWorkdayConsent({ tenantId: 'tnt_1' } as never, {
                connectionId: CONN,
                code: 'c',
                redirectUri: 'https://app.test/cb',
            }),
        ).rejects.toThrow(/authorizing user/i);
        expect(exchangeMock).not.toHaveBeenCalled();
    });

    it('writes nothing when the exchange fails', async () => {
        exchangeMock.mockRejectedValue(new Error('Workday code exchange failed: 400'));
        await expect(
            completeWorkdayConsent(ctx, { connectionId: CONN, code: 'c', redirectUri: 'https://app.test/cb' }),
        ).rejects.toThrow('400');
        expect(mockTx.integrationConnection.update).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });
});

describe('the audit row is accountable without being a credential store', () => {
    it('names who authorized what, and carries NO credential', async () => {
        await completeWorkdayConsent(ctx, { connectionId: CONN, code: 'code-1', redirectUri: 'https://app.test/cb' });

        const [, , entry] = logEventMock.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
        expect(entry.action).toBe('WORKDAY_CONNECTION_AUTHORIZED');
        const details = entry.detailsJson as Record<string, unknown>;
        expect(details.authorizedByUserId).toBe('usr_9');
        expect(details.workdayHost).toBe(HOST);
        expect(details.workdayTenant).toBe(TENANT);
        expect(details.clientId).toBe('cid');
        expect(details.accessTokenExpiresAt).toBe(1_700_000_000);

        // Whole-row, not field-by-field: a future field carrying a credential
        // would pass a per-field allowlist nobody remembered to extend.
        const blob = JSON.stringify(entry);
        for (const secret of ['csecret', 'r1', 'a1', 'code-1']) {
            expect(blob).not.toContain(secret);
        }
    });
});

describe('the flow is REACHABLE, which is the whole of #3595', () => {
    // ═══ WHY A SOURCE SCAN ═══
    //
    // Everything above passed BEFORE this change, over a token module nothing
    // called. A test that invokes an exported function proves the function
    // works and never that anything invokes it, and there is no type error for
    // an uncalled export. Only a scan for the CALLER distinguishes the two.
    //
    // Read through `codeOf`, so no assertion can be satisfied by a comment —
    // and that matters more here than usual, because the module's docblocks
    // mention every one of these identifiers while explaining them.

    const ROOT = path.join(__dirname, '..', '..');
    const read = (p: string): string => codeOf(readFileSync(path.join(ROOT, p), 'utf8'));

    // Needles are CALL forms, not identifiers: `toContain('buildWorkdayAuthorizeUrl')`
    // matches the import as well as the call, so deleting the call and keeping
    // the import would be a green diff — the defect this describe exists to
    // prevent, one level down.

    it('a route builds the authorize URL', () => {
        const route = read(
            'src/app/api/t/[tenantSlug]/admin/integrations/[connectionId]/workday-consent/route.ts',
        );
        expect(route).toContain('buildWorkdayAuthorizeUrl({');
        expect(route).toContain('workdayConsentTarget(ctx,');
        expect(route).toContain("res.cookies.set('wd_oauth_state'");
    });

    it('a route completes the exchange, and verifies the state before it does', () => {
        const route = read('src/app/api/integrations/workday/callback/route.ts');
        expect(route).toContain('completeWorkdayConsent(ctx,');
        expect(route).toContain("req.cookies.get('wd_oauth_state')");
        expect(route).toContain('getTenantCtx({ tenantSlug })');
        expect(route).toContain('assertCanAdmin(ctx)');
        expect(route).toContain('state !== cookieState');
    });

    it('POSITIVE CONTROL — the reader finds a string that is NOT there', () => {
        // Proves the file being read is the one meant. A path typo would make
        // `read` throw, but a WRONG path that happens to exist would not — so
        // this checks for something the callback must not contain.
        const route = read('src/app/api/integrations/workday/callback/route.ts');
        expect(route).not.toContain('orangehrm');
    });
});
