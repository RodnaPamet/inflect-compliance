/**
 * Coverage wave E — `src/lib/processes/switch-canvas-mode.ts`.
 *
 * Three thin fetch wrappers behind the process-map document bar. Each
 * has exactly two outcomes (ok / !ok), so the tests pin the request
 * shape (method, headers, body, URL) AND the thrown-message contract
 * on failure — the message carries the status code operators read in
 * a toast.
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
const fail = (status: number) => ({ ok: false, status });

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

    it('throws with the status code when the response is not ok', async () => {
        fetchMock.mockResolvedValueOnce(fail(409));
        await expect(
            patchCanvasMode('acme', 'map-1', 'AUTOMATION'),
        ).rejects.toThrow('Mode switch failed (409)');
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

    it('throws with the status code when the response is not ok', async () => {
        fetchMock.mockResolvedValueOnce(fail(500));
        await expect(
            patchProcessStatus('acme', 'map-9', 'ARCHIVED'),
        ).rejects.toThrow('Status change failed (500)');
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

    it('throws with the status code when the response is not ok', async () => {
        fetchMock.mockResolvedValueOnce(fail(403));
        await expect(deleteProcessMap('acme', 'map-3')).rejects.toThrow(
            'Delete failed (403)',
        );
    });
});
