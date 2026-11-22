/**
 * The A2A routes at their HTTP boundary (#5376): the body cap, and the token
 * route's two credential carriages.
 *
 * The usecases behind these routes are tested on their own; nothing ran the
 * ROUTES. Three things live only in the route files and nothing held them:
 *
 *   1. The cap bounds MEMORY, not only the answer. A body over the cap is a
 *      413 — and it must be a 413 before the whole body is buffered, or the
 *      cap is a report rather than a defence. So each oversize case reads its
 *      body from a counting stream and asserts how much the route PULLED. The
 *      token route used to `req.text()` first and measure after: it answered
 *      413 correctly while reading every byte a caller cared to send.
 *   2. A `Content-Length` is the caller's claim. Absent (a chunked body) or
 *      understating, the stream itself is counted.
 *   3. An HTTP Basic header the server cannot decode is bad credentials (401,
 *      `invalid_client`, nothing echoed), never a 500. `decodeURIComponent`
 *      throws `URIError` on a stray `%`, and the route did not catch it.
 *
 * And it pins the token route's precedence, as its own comment intends: a
 * field in the form body wins over the same field in Basic.
 *
 * The real `withApiErrorHandling` runs, so a throw surfaces as the status a
 * caller would see rather than as a rejected promise.
 */
const mockIssue = jest.fn();
jest.mock('@/app-layer/usecases/a2a-host-consumer-token', () => ({
    issueHostConsumerToken: (...a: unknown[]) => mockIssue(...a),
}));
const mockInbound = jest.fn();
jest.mock('@/app-layer/usecases/a2a-inbound', () => ({
    handleInboundA2a: (...a: unknown[]) => mockInbound(...a),
}));

import { NextRequest } from 'next/server';

import { POST as TOKEN_POST } from '@/app/api/a2a/[tenantSlug]/token/route';
import { POST as INBOUND_POST } from '@/app/api/a2a/[tenantSlug]/route';
import { POST as PEER_POST } from '@/app/api/a2a/[tenantSlug]/peers/[peerId]/route';
import { readA2aBody } from '@/lib/agentic/a2a/body';
import { A2A_MAX_BODY_BYTES } from '@/lib/agentic/a2a/protocol';

const TOKEN_CAP = 8 * 1024;
const CHUNK = 1024;

type Handler = (req: NextRequest, ctx: unknown) => Promise<Response>;

/** A body that counts what is pulled from it, and whether it was cancelled. */
function countingStream(totalBytes: number, fill = 0x61) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (state.pulled >= totalBytes) {
                    controller.close();
                    return;
                }
                const n = Math.min(CHUNK, totalBytes - state.pulled);
                state.pulled += n;
                controller.enqueue(new Uint8Array(n).fill(fill));
            },
            cancel() {
                state.cancelled = true;
            },
        },
        { highWaterMark: 0 },
    );
    return { stream, state };
}

function request(
    path: string,
    body: BodyInit | null,
    headers: Record<string, string> = {},
): NextRequest {
    return new NextRequest(`https://app.example/api/a2a/acme${path}`, {
        method: 'POST',
        body,
        headers,
        // A stream body needs half duplex in Node's fetch.
        duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1]);
}

function callToken(req: NextRequest) {
    return (TOKEN_POST as unknown as Handler)(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}
function callInbound(req: NextRequest) {
    return (INBOUND_POST as unknown as Handler)(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}
function callPeer(req: NextRequest) {
    return (PEER_POST as unknown as Handler)(req, {
        params: Promise.resolve({ tenantSlug: 'acme', peerId: 'peer-1' }),
    });
}

function basic(id: string, secret: string): string {
    return `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockIssue.mockResolvedValue({ ok: true, accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900 });
    mockInbound.mockResolvedValue({
        status: 200,
        body: '{"jsonrpc":"2.0","result":{}}',
        headers: { 'content-type': 'application/json' },
    });
});

describe('token route — the body cap bounds memory', () => {
    it('an oversize body with NO Content-Length is refused 413 without being read whole', async () => {
        const { stream, state } = countingStream(TOKEN_CAP * 16);
        const res = await callToken(request('/token', stream, {
            'content-type': 'application/x-www-form-urlencoded',
        }));

        expect(res.status).toBe(413);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_request' });
        expect(mockIssue).not.toHaveBeenCalled();
        // Stopped at the cap, not at the end of what the caller sent.
        expect(state.pulled).toBeLessThanOrEqual(TOKEN_CAP + 2 * CHUNK);
        expect(state.cancelled).toBe(true);
    });

    it('a Content-Length that UNDERSTATES the body is refused 413 on the bytes actually sent', async () => {
        const { stream, state } = countingStream(TOKEN_CAP * 16);
        const res = await callToken(request('/token', stream, {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': '10',
        }));

        expect(res.status).toBe(413);
        expect(mockIssue).not.toHaveBeenCalled();
        expect(state.pulled).toBeLessThanOrEqual(TOKEN_CAP + 2 * CHUNK);
    });

    it('a declared Content-Length over the cap is refused before a byte is read', async () => {
        const { stream, state } = countingStream(TOKEN_CAP * 16);
        const res = await callToken(request('/token', stream, {
            'content-length': String(TOKEN_CAP * 16),
        }));

        expect(res.status).toBe(413);
        expect(mockIssue).not.toHaveBeenCalled();
        expect(state.pulled).toBe(0);
    });

    it('a body exactly at the cap is read and handed on', async () => {
        const res = await callToken(request('/token', 'grant_type=client_credentials&x=' + 'a'.repeat(TOKEN_CAP - 32)));
        expect(res.status).toBe(200);
        expect(mockIssue).toHaveBeenCalledTimes(1);
    });
});

describe('token route — HTTP Basic', () => {
    it('a malformed %-escape in Basic is 401 invalid_client, not 500, and echoes nothing', async () => {
        const res = await callToken(request('/token', 'grant_type=client_credentials', {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basic('ifhc_%E0%A4%A', 'secret%'),
        }));

        expect(res.status).toBe(401);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'invalid_client' });
        expect(text).not.toContain('ifhc_');
        expect(text).not.toContain('URI');
        expect(mockIssue).not.toHaveBeenCalled();
    });

    it('a malformed escape in the SECRET alone is refused the same way', async () => {
        const res = await callToken(request('/token', 'grant_type=client_credentials', {
            authorization: basic('ifhc_good', '%zz'),
        }));
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_client' });
        expect(mockIssue).not.toHaveBeenCalled();
    });

    it('a well-formed Basic header carries the credentials, form-decoded, split on the FIRST colon', async () => {
        const res = await callToken(request('/token', 'grant_type=client_credentials', {
            authorization: basic('ifhc_abc', encodeURIComponent('s3cr:et%')),
        }));
        expect(res.status).toBe(200);
        expect(mockIssue).toHaveBeenCalledWith({
            tenantSlug: 'acme',
            grantType: 'client_credentials',
            clientId: 'ifhc_abc',
            clientSecret: 's3cr:et%',
        });
    });

    it('a field in the form body wins over the same field in Basic', async () => {
        await callToken(request(
            '/token',
            'grant_type=client_credentials&client_id=ifhc_body&client_secret=body-secret',
            {
                'content-type': 'application/x-www-form-urlencoded',
                authorization: basic('ifhc_header', 'header-secret'),
            },
        ));
        expect(mockIssue).toHaveBeenCalledWith(expect.objectContaining({
            clientId: 'ifhc_body',
            clientSecret: 'body-secret',
        }));
    });

    it('a refusal from the usecase is one shape, at its status', async () => {
        mockIssue.mockResolvedValue({ ok: false, reason: 'BAD_CLIENT_SECRET', httpStatus: 401 });
        const res = await callToken(request('/token', 'grant_type=client_credentials', {
            authorization: basic('ifhc_abc', 'wrong'),
        }));
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_client' });
    });
});

describe.each([
    ['per-tenant inbound', callInbound],
    ['per-peer inbound', callPeer],
])('%s route — the body cap', (_name, call) => {
    it('an oversize body with NO Content-Length is 413, read no further than the cap', async () => {
        const { stream, state } = countingStream(A2A_MAX_BODY_BYTES * 4);
        const res = await call(request('', stream, { 'content-type': 'application/json' }));

        expect(res.status).toBe(413);
        expect(mockInbound).not.toHaveBeenCalled();
        expect(state.pulled).toBeLessThanOrEqual(A2A_MAX_BODY_BYTES + 2 * CHUNK);
        expect(state.cancelled).toBe(true);
    });

    it('a Content-Length that understates the body is 413', async () => {
        const { stream, state } = countingStream(A2A_MAX_BODY_BYTES * 4);
        const res = await call(request('', stream, { 'content-length': '2' }));

        expect(res.status).toBe(413);
        expect(mockInbound).not.toHaveBeenCalled();
        expect(state.pulled).toBeLessThanOrEqual(A2A_MAX_BODY_BYTES + 2 * CHUNK);
    });

    it('a body under the cap reaches the usecase verbatim, with the caller headers', async () => {
        const body = '{"jsonrpc":"2.0","method":"tasks/get","id":1}';
        const res = await call(request('', body, {
            authorization: 'Bearer iflp_x',
            'x-request-id': 'req-1',
        }));

        expect(res.status).toBe(200);
        expect(mockInbound).toHaveBeenCalledTimes(1);
        expect(mockInbound.mock.calls[0][0]).toEqual(expect.objectContaining({
            tenantSlug: 'acme',
            authorization: 'Bearer iflp_x',
            body,
            requestId: 'req-1',
        }));
    });
});

describe('readA2aBody', () => {
    it('decodes a multi-byte character split across chunks', async () => {
        const bytes = new TextEncoder().encode('ünïcödé');
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, 1));
                controller.enqueue(bytes.slice(1));
                controller.close();
            },
        });
        const req = new Request('https://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
        await expect(readA2aBody(req)).resolves.toEqual({ ok: true, body: 'ünïcödé' });
    });

    it('counts BYTES, not characters, against the cap', async () => {
        // 3 two-byte characters = 6 bytes, over a 5-byte cap.
        const req = new Request('https://x/', { method: 'POST', body: 'üüü' });
        await expect(readA2aBody(req, 5)).resolves.toEqual({ ok: false });
        const ok = new Request('https://x/', { method: 'POST', body: 'üüü' });
        await expect(readA2aBody(ok, 6)).resolves.toEqual({ ok: true, body: 'üüü' });
    });

    it('a request with no body reads as empty', async () => {
        await expect(readA2aBody(new Request('https://x/', { method: 'POST' }))).resolves.toEqual({ ok: true, body: '' });
    });
});
