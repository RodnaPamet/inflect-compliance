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

    it('asks for a URL and an optional authorization, and nothing else', () => {
        expect(provider.configSchema.configFields.map((f) => f.key)).toEqual(['url']);
        expect(provider.configSchema.secretFields.map((f) => f.key)).toEqual(['authorization']);
        // The credential is a SECRET field, so it rides the encrypted store
        // rather than the config blob.
        expect(provider.configSchema.secretFields[0].required).toBe(false);
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
