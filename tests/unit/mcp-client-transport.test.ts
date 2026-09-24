/**
 * THE OUTBOUND MCP TRANSPORT, AND THE BOUNDS THAT MAKE IT SAFE TO POINT AT A
 * URL SOMEBODY ELSE CHOSE.
 *
 * An MCP server URL is tenant-supplied. The SSRF question — https only, no
 * private addresses, no DNS rebinding, no redirects — is `safeFetch`'s, and
 * this file asserts the client GOES THROUGH it rather than re-testing what
 * `webhook-safety` already proves. A client that called `fetch` directly would
 * pass every test below while being the exact primitive that module exists to
 * deny, so the first test is that the seam is used at all.
 *
 * What IS this file's own subject: the two bounds, and the refusal to trust
 * what comes back.
 */
const safeFetchMock = jest.fn();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    safeFetch: (...a: unknown[]) => safeFetchMock(...a),
}));

import {
    initialize,
    listTools,
    callTool,
    McpClientError,
    MCP_MAX_RESPONSE_BYTES,
} from '@/app-layer/integrations/mcp/client';

/** A Response whose body streams `text` in one chunk. */
const bodyOf = (text: string, ok = true, status = 200) => ({
    ok,
    status,
    body: {
        getReader() {
            let sent = false;
            return {
                read: async () =>
                    sent
                        ? { done: true, value: undefined }
                        : ((sent = true), { done: false, value: new TextEncoder().encode(text) }),
                cancel: async () => undefined,
            };
        },
    },
});

const OPTS = { url: 'https://mcp.example.com/rpc' };

beforeEach(() => {
    jest.clearAllMocks();
});

describe('every request goes through the SSRF-safe seam', () => {
    it('calls safeFetch, never a bare fetch', async () => {
        safeFetchMock.mockResolvedValue(
            bodyOf(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })),
        );

        await initialize(OPTS);

        // THE ASSERTION WITH TEETH. `webhook-safety` resolves DNS, re-checks
        // every address, pins the connection to them and refuses redirects.
        // None of that applies to a client that reached for global fetch.
        expect(safeFetchMock).toHaveBeenCalledTimes(1);
        expect(safeFetchMock.mock.calls[0][0]).toBe(OPTS.url);
    });

    it('sends the authorization the caller resolved, and nothing when there is none', async () => {
        safeFetchMock.mockResolvedValue(
            bodyOf(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })),
        );

        await listTools({ ...OPTS, authorization: 'Bearer x' });
        expect((safeFetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers)
            .toHaveProperty('Authorization', 'Bearer x');

        safeFetchMock.mockClear();
        await listTools(OPTS);
        expect((safeFetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers)
            .not.toHaveProperty('Authorization');
    });
});

describe('what comes back is bounded and distrusted', () => {
    it('refuses a body over the cap instead of buffering it', async () => {
        // The failure this prevents is an OOM in a worker, which surfaces as
        // an infrastructure incident rather than as a bad connection.
        safeFetchMock.mockResolvedValue(bodyOf('x'.repeat(MCP_MAX_RESPONSE_BYTES + 1)));

        await expect(listTools(OPTS)).rejects.toThrow(/exceeded .* bytes/);
    });

    it('accepts a body just under the cap', async () => {
        // The other side of the boundary. A cap that refused everything would
        // satisfy the test above while breaking every real call.
        const tools = [{ name: 'q', description: 'd', inputSchema: {} }];
        const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } });
        expect(payload.length).toBeLessThan(MCP_MAX_RESPONSE_BYTES);
        safeFetchMock.mockResolvedValue(bodyOf(payload));

        await expect(listTools(OPTS)).resolves.toHaveLength(1);
    });

    it('does not echo a non-JSON body into the error', async () => {
        // Attacker-influenced text of unknown shape, and an error string is one
        // of the few things that reliably reaches a log.
        safeFetchMock.mockResolvedValue(bodyOf('<html>secret-ish garbage</html>'));

        await expect(listTools(OPTS)).rejects.toThrow(/non-JSON body/);
        await expect(listTools(OPTS)).rejects.not.toThrow(/secret-ish/);
    });

    it('surfaces a JSON-RPC error as a refusal, with its code', async () => {
        safeFetchMock.mockResolvedValue(
            bodyOf(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such tool' } })),
        );

        await expect(callTool(OPTS, 'nope', {})).rejects.toMatchObject({
            name: 'McpClientError',
            code: -32601,
        });
    });

    it('refuses an initialize that names no protocol version', async () => {
        // A handshake that agreed nothing is not a handshake. Carrying on
        // would mean every later call assumed a dialect neither side stated.
        safeFetchMock.mockResolvedValue(bodyOf(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })));

        await expect(initialize(OPTS)).rejects.toThrow(/did not name a protocol version/);
    });

    it('treats a missing tools array as EMPTY, not as everything', async () => {
        // Fail-closed on a malformed catalogue: an absent list must not read
        // as "no restriction". Nothing is callable on the strength of this
        // list anyway — it is input to a pin — but the direction matters.
        safeFetchMock.mockResolvedValue(bodyOf(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })));

        await expect(listTools(OPTS)).resolves.toEqual([]);
    });

    it('turns a non-2xx into a client error rather than parsing the body', async () => {
        safeFetchMock.mockResolvedValue(bodyOf('{}', false, 503));

        await expect(listTools(OPTS)).rejects.toThrow(/HTTP 503/);
    });
});
