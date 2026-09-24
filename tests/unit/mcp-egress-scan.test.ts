/**
 * THE OUTBOUND ARGUMENT SCAN.
 *
 * Every other MCP control governs what an agent may read. This one is the only
 * check on data LEAVING, and it exists because the agent picks the arguments:
 * having read tenant data legitimately, nothing downstream stops it addressing
 * that data to somebody else's endpoint.
 *
 * Two things this file insists on beyond the happy path:
 *
 *   - a POSITIVE CONTROL. A guard that blocked everything would pass every
 *     refusal test here while making the client useless, so the last test
 *     proves a clean call still goes out.
 *   - that a refusal costs the far end NOTHING. "Blocked" has to mean no bytes,
 *     not a request we tore down afterwards, so the assertion is on `safeFetch`
 *     never being entered rather than on the error alone.
 */
const safeFetchMock = jest.fn();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    safeFetch: (...a: unknown[]) => safeFetchMock(...a),
}));

import { findInternalSecret } from '@/app-layer/integrations/mcp/egress-scan';
import { callTool, McpClientError } from '@/app-layer/integrations/mcp/client';

const bodyOf = (text: string) => ({
    ok: true,
    status: 200,
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

beforeEach(() => safeFetchMock.mockReset());

describe('findInternalSecret', () => {
    it('passes arguments that carry nothing of ours', () => {
        expect(findInternalSecret({ query: 'up{job="api"}', range: '5m' })).toBeNull();
    });

    it.each([
        ['v2:', 'v2:d2hhdGV2ZXI='],
        ['v1:', 'v1:d2hhdGV2ZXI='],
    ])('refuses a %s ciphertext envelope', (_label, value) => {
        expect(findInternalSecret({ note: value })).toBe('an encrypted field value');
    });

    it('refuses an API key however deeply it is buried', () => {
        const payload = { filters: [{ any: { of: ['fine', 'iflk_6720c6eb_secret'] } }] };
        expect(findInternalSecret(payload)).toBe('an Inflect API key');
    });

    it('refuses a key embedded in prose, not just a bare value', () => {
        expect(findInternalSecret({ q: 'use iflk_abc to authenticate' })).toBe(
            'an Inflect API key',
        );
    });

    /**
     * The blind spot a hand-rolled `Object.entries` walk would have. A `Map` is
     * `typeof 'object'` with zero own entries, so a recursive walker never sees
     * inside one. Letting the serialiser drive means the question answers
     * itself: the second assertion is the one that makes the first SAFE rather
     * than merely green — the secret is unflagged because it never serialises,
     * so it cannot reach the wire either.
     */
    it('does not flag a secret that cannot be serialised — because it cannot be sent', () => {
        const payload = { m: new Map([['k', 'iflk_abc']]) };
        expect(findInternalSecret(payload)).toBeNull();
        expect(JSON.stringify(payload)).not.toContain('iflk_');
    });
});

describe('the client refuses to send it', () => {
    it('stops before a single byte leaves', async () => {
        await expect(
            callTool({ url: 'https://mcp.example.com' }, 'search', { token: 'iflk_abc' }),
        ).rejects.toThrow(McpClientError);
        expect({ fetchCalls: safeFetchMock.mock.calls.length }).toEqual({ fetchCalls: 0 });
    });

    it('names what it found, so the refusal is actionable', async () => {
        await expect(
            callTool({ url: 'https://mcp.example.com' }, 'search', { x: 'v2:abc=' }),
        ).rejects.toThrow(/mcp_egress_blocked.*an encrypted field value/);
    });

    /** POSITIVE CONTROL — the guard must not be blocking everything. */
    it('still sends a clean call', async () => {
        safeFetchMock.mockResolvedValue(
            bodyOf(JSON.stringify({ jsonrpc: '2.0', id: 'ic-1', result: { content: [] } })),
        );
        await callTool({ url: 'https://mcp.example.com' }, 'search', { query: 'cpu' });
        expect({ fetchCalls: safeFetchMock.mock.calls.length }).toEqual({ fetchCalls: 1 });
    });
});
