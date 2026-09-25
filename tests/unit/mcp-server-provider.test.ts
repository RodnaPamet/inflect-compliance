/**
 * AN EXTERNAL MCP SERVER AS A CONNECTION — and the line between connecting to
 * one and being able to call anything on it.
 *
 * The risk this file is really about: a "Test connection" button that quietly
 * confers reach. Testing a connection performs a real handshake, which is why
 * `liveValidation` is true — but a tool becomes callable only by being pinned
 * into the tenant's manifest AND granted to a registered agent, both human
 * acts. Nothing below may leak authority out of a validation call.
 */
const initializeMock = jest.fn();
const listToolsMock = jest.fn();
const mintMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/mcp/token'),
    mintAccessToken: (...a: unknown[]) => mintMock(...a),
}));

jest.mock('@/app-layer/integrations/mcp/client', () => {
    class McpClientError extends Error {
        constructor(message: string, readonly code?: number) {
            super(message);
            this.name = 'McpClientError';
        }
    }
    return {
        McpClientError,
        initialize: (...a: unknown[]) => initializeMock(...a),
        listTools: (...a: unknown[]) => listToolsMock(...a),
    };
});

import { McpServerProvider } from '@/app-layer/integrations/providers/mcp-server-provider';
import { McpClientError } from '@/app-layer/integrations/mcp/client';

const provider = new McpServerProvider();
const CONFIG = { url: 'https://mcp.example.com/rpc' };

beforeEach(() => {
    jest.clearAllMocks();
    initializeMock.mockResolvedValue({ protocolVersion: '2025-06-18' });
    listToolsMock.mockResolvedValue([{ name: 'q', description: 'd', inputSchema: {} }]);
});

describe('what the provider declares about itself', () => {
    it('runs NO scheduled check, and says so with an empty list', () => {
        // Not an omission. Declaring a check it does not implement would put it
        // in the automation registry and route control automationKeys at
        // something that cannot serve them.
        expect(provider.supportedChecks).toEqual([]);
    });

    it('declares live validation, and earns it', async () => {
        // This codebase treats an undeclared `liveValidation` as a label
        // arriving by silence. True here has to be true: a real handshake
        // happens below.
        expect(provider.liveValidation).toBe(true);

        await provider.validateConnection(CONFIG, {});

        expect(initializeMock).toHaveBeenCalledTimes(1);
        expect(listToolsMock).toHaveBeenCalledTimes(1);
    });

    it('asks for a URL, the Entra fields, and nothing else', () => {
        expect(provider.configSchema.configFields.map((f) => f.key)).toEqual([
            'url',
            'tenantId',
            'clientId',
        ]);
        expect(provider.configSchema.secretFields.map((f) => f.key)).toEqual([
            'authorization',
            'clientSecret',
            'refreshToken',
        ]);
    });

    /**
     * Which fields are SECRETS is the load-bearing half. `clientSecret` and
     * `refreshToken` are long-lived credentials — the refresh token more so
     * than the access tokens it buys — and a secret field rides the encrypted
     * store while a config field sits in a plain JSON column that reaches
     * exports and logs. `tenantId` and `clientId` are identifiers, not
     * credentials, and are config for that reason.
     */
    it('puts every credential in the encrypted store and no identifier in it', () => {
        expect(provider.configSchema.secretFields.map((f) => f.key).sort()).toEqual(
            ['authorization', 'clientSecret', 'refreshToken'].sort(),
        );
        expect(provider.configSchema.configFields.map((f) => f.key)).not.toContain('clientSecret');
        expect(provider.configSchema.configFields.map((f) => f.key)).not.toContain('refreshToken');
    });

    it('requires none of them, so a server needing no credential still works', () => {
        for (const f of provider.configSchema.secretFields) {
            expect({ key: f.key, required: f.required }).toEqual({ key: f.key, required: false });
        }
    });
});

describe('validating a connection', () => {
    it('refuses without a URL, before reaching the network', async () => {
        const r = await provider.validateConnection({}, {});

        expect(r.valid).toBe(false);
        expect(initializeMock).not.toHaveBeenCalled();
    });

    it('fails when the catalogue read fails, not just the handshake', async () => {
        // A server that answers `initialize` and then refuses `tools/list`
        // would be reported as fine and found empty. The catalogue read is
        // what this connection exists for, so it is part of the test.
        listToolsMock.mockRejectedValue(new McpClientError('tools/list refused'));

        const r = await provider.validateConnection(CONFIG, {});

        expect(r.valid).toBe(false);
        expect(r.error).toContain('tools/list refused');
    });

    it('passes the credential through as Authorization', async () => {
        await provider.validateConnection(CONFIG, { authorization: 'Bearer x' });

        expect(initializeMock.mock.calls[0][0]).toMatchObject({ authorization: 'Bearer x' });
    });

    it('sends NO authorization when the field is blank rather than an empty one', async () => {
        // An empty `Authorization:` header is not the same as none — some
        // servers reject it outright, and the failure would read as a bad
        // credential rather than an absent one.
        await provider.validateConnection(CONFIG, { authorization: '   ' });

        expect(initializeMock.mock.calls[0][0].authorization).toBeUndefined();
    });

    it('does NOT render an arbitrary transport failure as the server\'s own words', async () => {
        // An SSRF refusal, a TLS failure or a timeout is OUR finding about the
        // attempt. Passing a raw thrown string into an admin screen would
        // present text nobody here vouches for as though we did.
        listToolsMock.mockRejectedValue(new Error('ECONNREFUSED 169.254.169.254'));

        const r = await provider.validateConnection(CONFIG, {});

        expect(r.valid).toBe(false);
        expect(r.error).not.toContain('169.254.169.254');
        expect(r.error).toMatch(/HTTPS endpoint on a public address/);
    });

    it('a successful validation confers nothing', async () => {
        // THE ASSERTION THIS FILE EXISTS FOR. The result carries `valid` and
        // nothing else — no tool list, no grant, no token. Connecting is not
        // permission, and there is no field here through which it could become
        // permission by accident.
        listToolsMock.mockResolvedValue([
            { name: 'dangerous_write', description: 'd', inputSchema: {} },
        ]);

        const r = await provider.validateConnection(CONFIG, {});

        expect(r.valid).toBe(true);
        expect(Object.keys(r)).toEqual(['valid']);
    });
});

/**
 * ENTRA CREDENTIALS — validating what mints a token, not a token.
 *
 * Validation exists to answer "do these credentials work". Two failure modes
 * are easy to confuse and are separated on purpose: a credential that cannot
 * MINT is our side of the connection, and a server that REFUSES is theirs. An
 * operator told the wrong one goes looking in the wrong place.
 */
describe('a connection configured for Entra', () => {
    const cfg = {
        url: 'https://mcp.svc.cloud.microsoft/enterprise',
        tenantId: '0fc6f345-0eee-4408-89a9-96fdd1b6439d',
        clientId: 'client-1',
    };
    const secrets = { clientSecret: 'secret-1', refreshToken: 'refresh-1' };

    beforeEach(() => {
        mintMock.mockReset();
        initializeMock.mockReset().mockResolvedValue({ protocolVersion: '2025-06-18' });
        listToolsMock.mockReset().mockResolvedValue([]);
    });

    it('mints a token and presents it as a Bearer header', async () => {
        mintMock.mockResolvedValue({ accessToken: 'at-1', expiresAt: Date.now() + 3_600_000, rotatedRefreshToken: null });

        await expect(provider.validateConnection(cfg, secrets)).resolves.toEqual({ valid: true });
        expect(initializeMock).toHaveBeenCalledWith(
            expect.objectContaining({ authorization: 'Bearer at-1' }),
        );
    });

    it('refuses a PARTLY configured connection, before reaching the network', async () => {
        // Falling back to a stale pasted token here would work until that token
        // died and then look like a server problem.
        const r = await provider.validateConnection(cfg, { clientSecret: 'secret-1' });

        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/all required together/);
        expect({ mints: mintMock.mock.calls.length, handshakes: initializeMock.mock.calls.length }).toEqual({
            mints: 0,
            handshakes: 0,
        });
    });

    it('says the CREDENTIAL failed, not the server, when minting is refused', async () => {
        const { McpTokenError } = jest.requireActual('@/app-layer/integrations/mcp/token');
        mintMock.mockRejectedValue(new McpTokenError('token endpoint refused the refresh: invalid_grant'));

        const r = await provider.validateConnection(cfg, secrets);

        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/invalid_grant/);
        // The server was never asked, so nothing about it can be blamed.
        expect({ handshakes: initializeMock.mock.calls.length }).toEqual({ handshakes: 0 });
    });

    it('still accepts a static credential, for a server that takes one', async () => {
        await expect(
            provider.validateConnection({ url: cfg.url }, { authorization: 'Bearer pasted' }),
        ).resolves.toEqual({ valid: true });
        expect(initializeMock).toHaveBeenCalledWith(
            expect.objectContaining({ authorization: 'Bearer pasted' }),
        );
        expect({ mints: mintMock.mock.calls.length }).toEqual({ mints: 0 });
    });
});
