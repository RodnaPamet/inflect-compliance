/**
 * ATTACHING AN ENTRA CREDENTIAL TO AN MCP CONNECTION.
 *
 * The credential this flow produces is a REFRESH token — the durable one, worth
 * more than the access tokens it buys. Three properties matter more than the
 * happy path:
 *
 *   · a connection that is not READY is refused BEFORE the admin is sent to
 *     Microsoft. Redirecting a half-configured connection returns a code that
 *     cannot be exchanged, after the admin has already consented.
 *   · the refresh token is MERGED into the existing secrets. Replacing the blob
 *     would silently drop the `clientSecret` beside it and break the connection
 *     this flow exists to complete.
 *   · the audit row records WHO authorized WHAT, and carries no credential. It
 *     streams to a SIEM; a refresh token in it would be a second place to steal
 *     the connection from.
 */
const mockTx = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

const exchangeMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/mcp/token'),
    exchangeCodeForRefreshToken: (...a: unknown[]) => exchangeMock(...a),
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
    completeMcpConsent,
    mcpConsentTarget,
} from '@/app-layer/usecases/mcp-connection-consent';

const TENANT_GUID = '0fc6f345-0eee-4408-89a9-96fdd1b6439d';
const ctx = { tenantId: 'tnt_1', userId: 'usr_9' } as never;
const CONN = 'cmconnaaa';

const ready = {
    id: CONN,
    name: 'Entra MCP',
    configJson: { url: 'https://mcp.svc.cloud.microsoft/enterprise', tenantId: TENANT_GUID, clientId: 'client-1' },
    secretEncrypted: JSON.stringify({ clientSecret: 'secret-1' }),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.integrationConnection.findFirst.mockResolvedValue(ready);
    mockTx.integrationConnection.update.mockResolvedValue({});
    exchangeMock.mockResolvedValue('refresh-1');
});

describe('a connection that is not ready', () => {
    it.each([
        ['no tenant id', { ...ready, configJson: { ...ready.configJson, tenantId: '' } }],
        ['no client id', { ...ready, configJson: { ...ready.configJson, clientId: '' } }],
        ['no client secret', { ...ready, secretEncrypted: JSON.stringify({}) }],
    ])('is refused with %s, before reaching Microsoft', async (_label, row) => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(row);
        await expect(mcpConsentTarget(ctx, CONN)).rejects.toThrow(/not ready to authorize/);
        expect({ exchanges: exchangeMock.mock.calls.length }).toEqual({ exchanges: 0 });
    });

    it('is not found when it belongs to another tenant', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(mcpConsentTarget(ctx, CONN)).rejects.toThrow(/not found/);
    });

    it('hands back only the identifiers, never the secret', async () => {
        await expect(mcpConsentTarget(ctx, CONN)).resolves.toEqual({
            tenantId: TENANT_GUID,
            clientId: 'client-1',
        });
    });
});

describe('completing the consent', () => {
    it('stores the refresh token ALONGSIDE the client secret, not instead of it', async () => {
        await completeMcpConsent(ctx, { connectionId: CONN, code: 'auth-code', redirectUri: 'https://x/cb' });

        const written = JSON.parse(
            mockTx.integrationConnection.update.mock.calls[0][0].data.secretEncrypted as string,
        );
        // Replacing the blob would drop clientSecret and break the very
        // connection this flow just authorized.
        expect(written).toEqual({ clientSecret: 'secret-1', refreshToken: 'refresh-1' });
    });

    it('passes the redirect URI through to the exchange', async () => {
        await completeMcpConsent(ctx, { connectionId: CONN, code: 'auth-code', redirectUri: 'https://x/cb' });
        expect(exchangeMock).toHaveBeenCalledWith(
            expect.objectContaining({ code: 'auth-code', redirectUri: 'https://x/cb' }),
        );
    });

    it('requires an authorizing user', async () => {
        await expect(
            completeMcpConsent({ tenantId: 'tnt_1' } as never, {
                connectionId: CONN,
                code: 'c',
                redirectUri: 'https://x/cb',
            }),
        ).rejects.toThrow(/authorizing user/);
    });

    it('writes nothing when the exchange fails', async () => {
        exchangeMock.mockRejectedValue(new Error('invalid_grant'));
        await expect(
            completeMcpConsent(ctx, { connectionId: CONN, code: 'c', redirectUri: 'https://x/cb' }),
        ).rejects.toThrow();
        expect({ writes: mockTx.integrationConnection.update.mock.calls.length }).toEqual({ writes: 0 });
    });
});

describe('the audit row is accountable without being a credential store', () => {
    it('names who authorized what, and carries NO secret', async () => {
        await completeMcpConsent(ctx, { connectionId: CONN, code: 'auth-code', redirectUri: 'https://x/cb' });

        expect(logEventMock).toHaveBeenCalledTimes(1);
        const entry = logEventMock.mock.calls[0][2];
        expect(entry).toMatchObject({
            action: 'MCP_CONNECTION_AUTHORIZED',
            entityId: CONN,
        });
        expect(entry.detailsJson).toMatchObject({
            entraTenantId: TENANT_GUID,
            clientId: 'client-1',
            authorizedByUserId: 'usr_9',
        });

        // The whole row, serialised — a credential must not appear anywhere in
        // it, including somewhere this test did not think to look.
        const serialised = JSON.stringify(entry);
        for (const secret of ['refresh-1', 'secret-1', 'auth-code']) {
            expect(serialised).not.toContain(secret);
        }
    });
});
