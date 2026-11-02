/**
 * Coverage wave E — `src/lib/processes/switch-canvas-mode.ts`.
 *
 * Three thin fetch wrappers behind the process-map document bar. Each
 * has exactly two outcomes (ok / !ok), so the tests pin the request
 * shape (method, headers, body, URL) AND the thrown-message contract
 * on failure: the message is the server's own reason, or empty for the
 * caller to replace with its translated sentence. It never carries the
 * status code (#4987) — the person reading the toast is not an operator.
 */
import {
    patchCanvasMode,
    patchProcessStatus,
    deleteProcessMap,
} from '@/lib/processes/switch-canvas-mode';

const fetchMock = jest.fn();

beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});

const ok = () => ({ ok: true, status: 200 });
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body });
const refusal = (message: string) => ({ error: { code: 'CONFLICT', message } });

describe('patchCanvasMode', () => {
    it('PATCHes the canvasMode as JSON to the tenant-scoped map URL', async () => {
        fetchMock.mockResolvedValueOnce(ok());

        await patchCanvasMode('acme', 'map-1', 'AUTOMATION');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/processes/map-1');
        expect(init.method).toBe('PATCH');
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(JSON.parse(init.body)).toEqual({ canvasMode: 'AUTOMATION' });
    });

    it('round-trips the DOCUMENT mode too', async () => {
        fetchMock.mockResolvedValueOnce(ok());
        await patchCanvasMode('acme', 'map-1', 'DOCUMENT');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            canvasMode: 'DOCUMENT',
        });
    });

    it("throws the server's reason when the response is not ok", async () => {
        fetchMock.mockResolvedValueOnce(fail(409, refusal('The map changed since you opened it')));
        await expect(
            patchCanvasMode('acme', 'map-1', 'AUTOMATION'),
        ).rejects.toThrow('The map changed since you opened it');
    });

    it('throws an EMPTY message, never the status code, when the server gave no reason', async () => {
        fetchMock.mockResolvedValueOnce(fail(409));
        const err = await patchCanvasMode('acme', 'map-1', 'AUTOMATION').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('');
    });
});

describe('patchProcessStatus', () => {
    it.each(['DRAFT', 'ACTIVE', 'ARCHIVED'] as const)(
        'PATCHes status=%s',
        async (status) => {
            fetchMock.mockResolvedValueOnce(ok());

            await patchProcessStatus('acme', 'map-9', status);

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/t/acme/processes/map-9');
            expect(init.method).toBe('PATCH');
            expect(JSON.parse(init.body)).toEqual({ status });
        },
    );

    it("throws the server's reason when the response is not ok", async () => {
        fetchMock.mockResolvedValueOnce(fail(400, refusal('An archived map cannot be activated')));
        await expect(
            patchProcessStatus('acme', 'map-9', 'ARCHIVED'),
        ).rejects.toThrow('An archived map cannot be activated');
    });

    it('throws an EMPTY message when the body is not JSON', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 502,
            json: async () => {
                throw new SyntaxError('Unexpected token <');
            },
        });
        const err = await patchProcessStatus('acme', 'map-9', 'ARCHIVED').catch((e: unknown) => e);
        expect((err as Error).message).toBe('');
    });
});

describe('deleteProcessMap', () => {
    it('sends a DELETE with no body', async () => {
        fetchMock.mockResolvedValueOnce(ok());

        await deleteProcessMap('acme', 'map-3');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/processes/map-3');
        expect(init.method).toBe('DELETE');
        expect(init.body).toBeUndefined();
    });

    it("throws the server's reason when the response is not ok", async () => {
        fetchMock.mockResolvedValueOnce(fail(403, refusal('Only an admin can delete a map')));
        await expect(deleteProcessMap('acme', 'map-3')).rejects.toThrow(
            'Only an admin can delete a map',
        );
    });
});
