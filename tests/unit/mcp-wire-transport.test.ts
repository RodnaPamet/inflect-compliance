/**
 * The shared outbound MCP wire (#3303).
 *
 * The two clients' own suites cover their dialects. What is tested here is the
 * part that was written twice and is now written once: the deadline, the byte
 * cap that aborts, and the single `safeFetch` branch.
 *
 * Two of these assert behaviours the tools client did NOT have before the
 * move, so this file is where that change is pinned rather than implied:
 * the timeout covering the BODY read, and the early refusal on a declared
 * `content-length` over the cap.
 */

const safeFetchMock = jest.fn();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    safeFetch: (...a: unknown[]) => safeFetchMock(...a),
}));

import {
    wirePost,
    WireCapExceededError,
    WireEgressError,
    WireTimeoutError,
} from '@/lib/mcp/wire-transport';

/** A body delivered as chunks, optionally with a gap between them. */
function streamOf(chunks: string[], gapMs = 0): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        async pull(c) {
            if (i >= chunks.length) {
                c.close();
                return;
            }
            if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
            c.enqueue(enc.encode(chunks[i]!));
            i += 1;
        },
    });
}

function responseOf(
    body: ReadableStream<Uint8Array> | null,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    return new Response(body, {
        status: init.status ?? 200,
        headers: init.headers ?? {},
    });
}

const BASE = {
    url: 'https://mcp.example.com/rpc',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    timeoutMs: 1_000,
};

beforeEach(() => jest.clearAllMocks());

describe('wirePost — the egress branch', () => {
    it('reaches the network through safeFetch when no seam is injected', async () => {
        safeFetchMock.mockResolvedValue(responseOf(streamOf(['{"ok":true}'])));
        const res = await wirePost(BASE);
        expect(safeFetchMock).toHaveBeenCalledTimes(1);
        expect(safeFetchMock.mock.calls[0]![0]).toBe(BASE.url);
        await expect(res.readBody(1024)).resolves.toBe('{"ok":true}');
    });

    it('uses the injected seam INSTEAD of safeFetch, never as well', async () => {
        const fetchImpl = jest.fn(async () => responseOf(streamOf(['{"a":1}'])));
        const res = await wirePost({ ...BASE, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(safeFetchMock).not.toHaveBeenCalled();
        await expect(res.readBody(1024)).resolves.toBe('{"a":1}');
    });

    it('wraps a socket failure as WireEgressError, preserving the cause', async () => {
        const boom = new Error('ECONNREFUSED');
        safeFetchMock.mockRejectedValue(boom);
        const err = await wirePost(BASE).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WireEgressError);
        expect((err as WireEgressError).cause).toBe(boom);
    });

    it('passes the caller\'s headers through verbatim, accept included', async () => {
        // The accept header is the point of difference between the two
        // dialects, so the transport must not have an opinion about it.
        safeFetchMock.mockResolvedValue(responseOf(null, { status: 202 }));
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        };
        const res = await wirePost({ ...BASE, headers });
        res.discard();
        expect(safeFetchMock.mock.calls[0]![1]).toMatchObject({ headers });
    });
});

describe('wirePost — the caller-owned deadline', () => {
    it('refuses before opening a socket when the deadline has passed', async () => {
        const err = await wirePost({ ...BASE, deadlineAt: Date.now() - 1 }).catch((e) => e);
        expect(err).toBeInstanceOf(WireTimeoutError);
        expect((err as WireTimeoutError).phase).toBe('request');
        // Nothing was sent. A refusal must not be observable to the far end.
        expect(safeFetchMock).not.toHaveBeenCalled();
    });

    it('bounds the attempt by the LESSER of timeoutMs and the deadline', async () => {
        safeFetchMock.mockImplementation(
            (_u: string, init: RequestInit) =>
                new Promise((_res, rej) => {
                    init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
                }),
        );
        const err = await wirePost({
            ...BASE,
            timeoutMs: 60_000,
            deadlineAt: Date.now() + 60,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(WireTimeoutError);
        expect((err as WireTimeoutError).phase).toBe('request');
    });

    it('times out a SLOW BODY, not just a slow response head', async () => {
        // The behaviour the tools client did not have: it cleared its timer as
        // soon as the head arrived, so a server dribbling bytes was bounded
        // only by the byte cap.
        //
        // The double wires its stream to `init.signal`, which is what fetch
        // does — a hand-made Response is NOT connected to the caller's
        // controller, so a stream that ignored the signal would prove nothing
        // about this code and would simply deliver its body.
        safeFetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
            const enc = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                async pull(c) {
                    await new Promise<void>((resolve, reject) => {
                        const t = setTimeout(resolve, 40);
                        init.signal?.addEventListener('abort', () => {
                            clearTimeout(t);
                            reject(new Error('aborted'));
                        });
                    });
                    c.enqueue(enc.encode('a'));
                },
            });
            return new Response(body);
        });
        const res = await wirePost({ ...BASE, timeoutMs: 60 });
        const err = await res.readBody(1024).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WireTimeoutError);
        expect((err as WireTimeoutError).phase).toBe('body');
    });
});

describe('wirePost — the byte cap', () => {
    it('aborts mid-transfer once the cap is exceeded', async () => {
        safeFetchMock.mockResolvedValue(responseOf(streamOf(['12345', '67890', 'more'])));
        const res = await wirePost(BASE);
        await expect(res.readBody(8)).rejects.toBeInstanceOf(WireCapExceededError);
    });

    it('refuses a DECLARED content-length over the cap', async () => {
        // The discriminator is that the BODY is well under the cap: only the
        // declared-length check can refuse this, because the streaming count
        // would have accepted one byte. (Asserting "no byte was read" directly
        // is not possible — a ReadableStream pulls eagerly to fill its queue,
        // before any reader exists, so such a flag measures the stream rather
        // than this code.)
        safeFetchMock.mockResolvedValue(
            responseOf(streamOf(['x']), { headers: { 'content-length': '9999' } }),
        );
        const res = await wirePost(BASE);
        await expect(res.readBody(10)).rejects.toBeInstanceOf(WireCapExceededError);
    });

    it('accepts a body exactly at the cap', async () => {
        safeFetchMock.mockResolvedValue(responseOf(streamOf(['12345678'])));
        const res = await wirePost(BASE);
        await expect(res.readBody(8)).resolves.toBe('12345678');
    });

    it('returns empty for a response with no body at all', async () => {
        safeFetchMock.mockResolvedValue(responseOf(null, { status: 202 }));
        const res = await wirePost(BASE);
        await expect(res.readBody(1024)).resolves.toBe('');
    });

    it('decodes multi-byte characters split across chunk boundaries', async () => {
        // An incremental decoder that ignored `{ stream: true }` would mangle
        // a character whose bytes land in two chunks.
        const enc = new TextEncoder();
        const bytes = enc.encode('грант');
        const mid = 3;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(bytes.slice(0, mid));
                c.enqueue(bytes.slice(mid));
                c.close();
            },
        });
        safeFetchMock.mockResolvedValue(responseOf(body));
        const res = await wirePost(BASE);
        await expect(res.readBody(1024)).resolves.toBe('грант');
    });
});

describe('wirePost — what it does NOT decide', () => {
    it('hands back a non-2xx without throwing, because the clients map status differently', async () => {
        safeFetchMock.mockResolvedValue(responseOf(streamOf(['nope']), { status: 503 }));
        const res = await wirePost(BASE);
        expect(res.status).toBe(503);
        await expect(res.readBody(1024)).resolves.toBe('nope');
    });

    it('hands back an SSE content type without refusing it', async () => {
        // One client refuses SSE by contract, the other requires it. A shared
        // transport that decided would be deciding for both.
        safeFetchMock.mockResolvedValue(
            responseOf(streamOf(['data: {}']), { headers: { 'content-type': 'text/event-stream' } }),
        );
        const res = await wirePost(BASE);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        await expect(res.readBody(1024)).resolves.toBe('data: {}');
    });
});
