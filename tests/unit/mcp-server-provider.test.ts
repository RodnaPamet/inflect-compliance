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
    // `mintToken`, NOT `mintAccessToken` (#3467). The provider dispatches on
    // the credential's `kind` now, and this double is placed at the dispatcher
    // so a case here can assert WHICH grant the provider chose — the thing the
    // defect was about. `resolveMcpCredentials` is deliberately left REAL
    // (`requireActual` above): it is the shared shape resolver, and stubbing it
    // would take the one piece this provider and the runtime must agree on out
    // of the test.
    mintToken: (...a: unknown[]) => mintMock(...a),
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
    listToolsMock.mockResolvedValue({ tools: [{ name: 'q', description: 'd', inputSchema: {} }], refusedNames: 0 });
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
        // `scope` ARRIVED LATE AND WAS ALREADY READ (#3467). The minting path
        // consulted `config.scope` from the day it landed and there was no
        // field for it, so the only reachable value was the delegated default —
        // and an operator whose server has its own audience had no way to say
        // so. It is CONFIG rather than a secret because an audience is a public
        // identifier of the server, not a credential.
        expect(provider.configSchema.configFields.map((f) => f.key)).toEqual([
            'url',
            'tenantId',
            'clientId',
            'scope',
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

    /**
     * Two credentials where only one is ever sent (#3340).
     *
     * `authorizationFor` takes its OAuth branch if ANY of four fields is set
     * and then never reads `secrets.authorization`. Saving both is therefore
     * saving a connection whose static secret is dead weight — harmless for a
     * plain tool call, and for the grant endpoint (#3323) the cause of a
     * permanent, undiagnosable failure: that endpoint authenticates by
     * comparing the presented bearer against the stored static value, so the
     * two sides end up comparing unrelated credentials while each behaves
     * correctly.
     *
     * Refused here rather than in the form because the API reaches this and
     * the form does not cover it.
     */
    it.each([
        ['tenantId on the config', { tenantId: 'a-tenant-guid' }, {}],
        ['clientId on the config', { clientId: 'an-app-guid' }, {}],
        // pragma: allowlist nextline secret -- test fixture
        ['clientSecret in the secrets', {}, { clientSecret: 'a-client-secret' }],
        // pragma: allowlist nextline secret -- test fixture
        ['refreshToken in the secrets', {}, { refreshToken: 'a-refresh-token' }],
    ])(
        'refuses a static Authorization alongside %s, before reaching the network',
        async (_label, extraConfig, extraSecrets) => {
            const r = await provider.validateConnection(
                { ...CONFIG, ...extraConfig },
                { authorization: 'Bearer a-pasted-token', ...extraSecrets },
            );

            expect(r.valid).toBe(false);
            expect(r.error).toMatch(/both/i);
            // The point of refusing at save time is that nobody has to
            // discover this from a live call.
            expect(initializeMock).not.toHaveBeenCalled();
        },
    );

    it('names WHICH OAuth field collided, so the operator knows what to clear', async () => {
        const r = await provider.validateConnection(
            { ...CONFIG, tenantId: 'a-tenant-guid' },
            { authorization: 'Bearer a-pasted-token' },
        );

        expect(r.error).toContain('tenantId');
        // Never the credential itself.
        expect(r.error).not.toContain('a-pasted-token');
    });

    it('allows a static Authorization on its own', async () => {
        const r = await provider.validateConnection(CONFIG, {
            authorization: 'Bearer a-pasted-token',
        });

        expect(r.valid).toBe(true);
    });

    it('treats blank OAuth fields as absent, so a form posting every key still saves', async () => {
        // An integrations form submits '' for the fields left empty. Reading
        // those as "configured" would refuse every static-secret connection
        // saved through that form.
        const r = await provider.validateConnection(
            { ...CONFIG, tenantId: '', clientId: '   ' },
            { authorization: 'Bearer a-pasted-token', clientSecret: '' },
        );

        expect(r.valid).toBe(true);
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
        listToolsMock.mockResolvedValue({
            tools: [
                { name: 'dangerous_write', description: 'd', inputSchema: {} },
            ],
            refusedNames: 0,
        });

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
        listToolsMock.mockReset().mockResolvedValue({ tools: [], refusedNames: 0 });
    });

    it('mints a token and presents it as a Bearer header', async () => {
        mintMock.mockResolvedValue({ accessToken: 'at-1', expiresAt: Date.now() + 3_600_000, rotatedRefreshToken: null });

        await expect(provider.validateConnection(cfg, secrets)).resolves.toEqual({ valid: true });
        expect(initializeMock).toHaveBeenCalledWith(
            expect.objectContaining({ authorization: 'Bearer at-1' }),
        );
        // AND WHICH GRANT (#3467). The header alone cannot tell a delegated
        // token from an app-only one, and the two have different governance:
        // only the delegated grant caps an agent at the privileges of a named
        // person. A validation that minted the wrong one would be green.
        expect(mintMock.mock.calls[0][0]).toEqual(
            expect.objectContaining({ kind: 'delegated', refreshToken: 'refresh-1' }),
        );
    });

    it('mints by the APP-ONLY grant when there is a scope and no refresh token', async () => {
        // The defect this issue was filed for: a server that wants app-only
        // auth could only be connected with a pasted bearer that expires in
        // about an hour. Asserted through `validateConnection`, which is the
        // button an operator actually presses.
        mintMock.mockResolvedValue({ accessToken: 'at-app', expiresAt: Date.now() + 3_600_000, rotatedRefreshToken: null });

        const r = await provider.validateConnection(
            { ...cfg, scope: 'https://mcp.svc.cloud.microsoft/.default' },
            { clientSecret: 'secret-1' },
        );

        expect(r).toEqual({ valid: true });
        expect(mintMock.mock.calls[0][0]).toEqual({
            kind: 'app-only',
            tenantId: cfg.tenantId,
            clientId: cfg.clientId,
            clientSecret: 'secret-1',
            scope: 'https://mcp.svc.cloud.microsoft/.default',
        });
    });

    it('refuses a PARTLY configured connection, before reaching the network', async () => {
        // Falling back to a stale pasted token here would work until that token
        // died and then look like a server problem.
        //
        // THE MESSAGE CHANGED WITH THE SECOND GRANT (#3467), and the old one
        // was the wrong thing to say: "tenantId, clientId, clientSecret and
        // refreshToken are all required together" sent an operator who had
        // deliberately supplied three of them looking for a refresh token their
        // server cannot issue. What is missing here is the field that would
        // select EITHER grant, and the message now names both options.
        const r = await provider.validateConnection(cfg, { clientSecret: 'secret-1' });

        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/app-only connection needs a scope/);
        expect(r.error).toMatch(/refreshToken instead for delegated access/);
        expect({ mints: mintMock.mock.calls.length, handshakes: initializeMock.mock.calls.length }).toEqual({
            mints: 0,
            handshakes: 0,
        });
    });

    it('a SCOPE ALONE does not make a static connection look half-configured', async () => {
        // `scope` is a property of the SERVER, not of the grant, so a connection
        // authenticated by a static header may carry one. Counting it as an
        // Entra field would refuse to save a correct configuration — and the
        // #3340 both-credentials check is where that would have bitten.
        initializeMock.mockResolvedValue(undefined);
        listToolsMock.mockResolvedValue({ tools: [], refusedNames: 0 });

        const r = await provider.validateConnection(
            { url: 'https://mcp.example.com/rpc', scope: 'https://x/.default' },
            { authorization: 'Bearer pasted' },
        );

        expect(r).toEqual({ valid: true });
        expect({ mints: mintMock.mock.calls.length }).toEqual({ mints: 0 });
        expect(initializeMock).toHaveBeenCalledWith(
            expect.objectContaining({ authorization: 'Bearer pasted' }),
        );
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
