/**
 * POST /api/account/avatar reads its body through a byte cap that aborts at
 * the cap (#5303). It used to call `req.formData()`, which buffers the whole
 * body, and only then compare the parsed file with `AVATAR_MAX_BYTES` — so an
 * ordinary signed-in account could make the web tier hold a body of any size.
 */
const getServerSessionMock = jest.fn();
const uploadOwnAvatar = jest.fn();

jest.mock('@/auth', () => ({ authOptions: {} }));
jest.mock('next-auth', () => ({ getServerSession: () => getServerSessionMock() }));
jest.mock('@/lib/account/sso-scope', () => ({ assertAccountWideWriteInScope: jest.fn() }));
jest.mock('@/lib/account/avatar', () => ({
    AVATAR_MAX_BYTES: 1024,
    uploadOwnAvatar: (...a: unknown[]) => uploadOwnAvatar(...a),
    removeOwnAvatar: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/account/avatar/route';

const CHUNK = 64 * 1024;

/** A body with no Content-Length that counts how much of it was pulled. */
function countingStream(totalBytes: number) {
    const pulled = { bytes: 0 };
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulled.bytes >= totalBytes) {
                controller.close();
                return;
            }
            const n = Math.min(CHUNK, totalBytes - pulled.bytes);
            pulled.bytes += n;
            controller.enqueue(new Uint8Array(n).fill(0x61));
        },
        // Pull nothing until somebody reads, so `pulled` counts reads only.
    }, { highWaterMark: 0 });
    return { stream, pulled };
}

function streamedRequest(stream: ReadableStream<Uint8Array>) {
    return new NextRequest('http://localhost/api/account/avatar', {
        method: 'POST',
        body: stream,
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        duplex: 'half',
    } as never);
}

function call(req: NextRequest) {
    return POST(req, { params: Promise.resolve({}) } as never);
}

beforeEach(() => {
    jest.clearAllMocks();
    getServerSessionMock.mockResolvedValue({ user: { id: 'u1' } });
    uploadOwnAvatar.mockResolvedValue({ ok: true });
});

describe('POST /api/account/avatar — the body cap bounds memory', () => {
    it('an oversize body with NO Content-Length is refused 400 without being read whole', async () => {
        const total = 50 * 1024 * 1024;
        const { stream, pulled } = countingStream(total);
        const res = await call(streamedRequest(stream));
        expect(res.status).toBe(400);
        // The reader stops within a chunk or two of the cap, nowhere near 50 MiB.
        expect(pulled.bytes).toBeLessThan(4 * CHUNK);
        expect(uploadOwnAvatar).not.toHaveBeenCalled();
    });

    it('a declared Content-Length over the cap is refused before a byte is read', async () => {
        const { stream, pulled } = countingStream(10 * 1024 * 1024);
        const req = new NextRequest('http://localhost/api/account/avatar', {
            method: 'POST',
            body: stream,
            headers: {
                'content-type': 'multipart/form-data; boundary=x',
                'content-length': String(10 * 1024 * 1024),
            },
            duplex: 'half',
        } as never);
        const res = await call(req);
        expect(res.status).toBe(400);
        expect(pulled.bytes).toBe(0);
    });

    it('a well-formed small upload still reaches the usecase with its bytes', async () => {
        const form = new FormData();
        form.append('file', new File([new Uint8Array([1, 2, 3])], 'a.webp', { type: 'image/webp' }));
        const req = new NextRequest('http://localhost/api/account/avatar', { method: 'POST', body: form });
        const res = await call(req);
        expect(res.status).toBe(200);
        expect(uploadOwnAvatar).toHaveBeenCalledTimes(1);
        const [userId, buf] = uploadOwnAvatar.mock.calls[0] as [string, Buffer];
        expect(userId).toBe('u1');
        expect([...buf]).toEqual([1, 2, 3]);
    });

    it('a file over the limit inside a body under the cap is still refused', async () => {
        const form = new FormData();
        form.append('file', new File([new Uint8Array(2048)], 'a.webp', { type: 'image/webp' }));
        const req = new NextRequest('http://localhost/api/account/avatar', { method: 'POST', body: form });
        const res = await call(req);
        expect(res.status).toBe(400);
        expect(uploadOwnAvatar).not.toHaveBeenCalled();
    });

    it('a body that is not a form is a 400, not a 500', async () => {
        const req = new NextRequest('http://localhost/api/account/avatar', {
            method: 'POST',
            body: 'not a form',
            headers: { 'content-type': 'text/plain' },
        });
        const res = await call(req);
        expect(res.status).toBe(400);
    });
});
