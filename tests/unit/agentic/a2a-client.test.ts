/**
 * The A2A client is the third client on the one outbound wire (#3679, O4): it
 * refuses before a socket opens what must never leave, and everything else
 * goes through `wirePost`, whose https rule is decided above the test seam.
 */
import { sendA2aMessage } from '@/lib/agentic/a2a/client';
import { buildA2aSendBody } from '@/lib/agentic/a2a/protocol';

const okFetch = jest.fn(async () => new Response('{"jsonrpc":"2.0","id":"j1","result":{"kind":"message"}}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-inflect-a2a-receipt': 'r' },
}));

beforeEach(() => okFetch.mockClear());

const body = (text: string) => buildA2aSendBody({ rpcId: 'j1', messageId: 'm1', text });

describe('sendA2aMessage', () => {
    it('sends through the wire and returns the exact body and the receipt header', async () => {
        const r = await sendA2aMessage({ url: 'https://peer.example/a2a', body: body('go'), receiptHeader: 'h', fetchImpl: okFetch });
        expect(r).toEqual({ ok: true, body: '{"jsonrpc":"2.0","id":"j1","result":{"kind":"message"}}', receiptHeader: 'r' });
        const [, init] = okFetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(new Headers(init.headers).get('x-inflect-a2a-receipt')).toBe('h');
        expect(init.body).toBe(body('go'));
    });

    it('refuses a plaintext endpoint before the seam is called — the wire decides https, not the caller', async () => {
        const r = await sendA2aMessage({ url: 'http://peer.example/a2a', body: body('go'), receiptHeader: 'h', fetchImpl: okFetch });
        expect(r).toEqual({ ok: false, reason: 'SCHEME_REFUSED', mayHaveArrived: false });
        expect(okFetch).not.toHaveBeenCalled();
    });

    it('refuses an Inflect credential or ciphertext in the task before a socket opens', async () => {
        // A ciphertext envelope is a whole value; a key is found anywhere in one.
        for (const leak of ['see iflk_live_abc', 'see iflp_abc', 'v2:abc:def:ghi']) {
            const r = await sendA2aMessage({ url: 'https://peer.example/a2a', body: body(leak), receiptHeader: 'h', fetchImpl: okFetch });
            expect({ leak, r }).toMatchObject({ leak, r: { ok: false, mayHaveArrived: false } });
        }
        expect(okFetch).not.toHaveBeenCalled();
    });

    it('can say message/send and nothing else', async () => {
        const tools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
        const r = await sendA2aMessage({ url: 'https://peer.example/a2a', body: tools, receiptHeader: 'h', fetchImpl: okFetch });
        expect(r).toEqual({ ok: false, reason: 'METHOD_REFUSED', mayHaveArrived: false });
        expect(okFetch).not.toHaveBeenCalled();
    });

    it('a non-2xx or a non-JSON answer may have arrived, and says so', async () => {
        const bad = jest.fn(async () => new Response('x', { status: 500 }));
        expect(await sendA2aMessage({ url: 'https://peer.example/a2a', body: body('go'), receiptHeader: 'h', fetchImpl: bad })).toEqual({
            ok: false,
            reason: 'HTTP_ERROR',
            mayHaveArrived: true,
        });
        const sse = jest.fn(async () => new Response('data: x', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        expect(await sendA2aMessage({ url: 'https://peer.example/a2a', body: body('go'), receiptHeader: 'h', fetchImpl: sse })).toEqual({
            ok: false,
            reason: 'NOT_JSON',
            mayHaveArrived: true,
        });
    });
});
