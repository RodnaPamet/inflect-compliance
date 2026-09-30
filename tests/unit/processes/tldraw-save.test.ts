/**
 * The tldraw save — the concurrency path, tested where it can lose work.
 *
 * ── What each claim costs if it is wrong ─────────────────────────────
 *
 * This is the write path, so the failure modes are not cosmetic:
 *
 *   • **A 409 that rejects** starts autosave's error machinery for something
 *     the reload toast already owns, and the user sees two notices for one
 *     event.
 *   • **A 5xx that resolves** is the defect `handleSave`'s comment records
 *     having paid for once: autosave takes its saved branch, nulls
 *     `dirtySince`, and the bar renders "Saved" over unsaved work. It made
 *     `status === 'error'` unreachable, which is why the documented no-retry
 *     behaviour never appeared.
 *   • **A missing `expectedVersion`** removes the concurrency check silently —
 *     two editors then overwrite each other with no 409 and no toast.
 *   • **An omitted `freeformJson`** means the server leaves the stored value
 *     alone, so a user who deletes their last sticky finds it back on reload.
 *
 * Every one of those is a branch here rather than a comment.
 */
import { saveTldrawCanvas } from '@/lib/processes/tldraw-save';
import type { EditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import type { ToastApi } from '@/components/ui/hooks/use-toast';

const CANVAS: EditorCanvas = {
    rows: {
        nodes: [
            {
                nodeKey: 'n1',
                nodeType: 'processStep',
                label: 'Receive invoice',
                subtitle: null,
                posX: 0,
                posY: 0,
                parentNodeKey: null,
                dataJson: null,
            },
        ],
        edges: [],
    },
    freeform: [{ id: 'shape:sticky-1', type: 'note' }],
};

function toastSpy() {
    const error = jest.fn();
    return { api: { error } as unknown as ToastApi, error };
}

function responder(status: number, body: unknown = {}) {
    return jest.fn().mockResolvedValue({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    } as unknown as Response);
}

const SAVED = {
    id: 'map-1',
    version: 5,
    updatedAt: '2026-09-30T00:00:00.000Z',
    nodes: [],
    edges: [],
};

function input(over: Partial<Parameters<typeof saveTldrawCanvas>[0]> = {}) {
    const { api } = toastSpy();
    return {
        tenantSlug: 'acme',
        mapId: 'map-1',
        expectedVersion: 4,
        canvas: CANVAS,
        toast: api,
        onConflict: jest.fn(),
        onSaved: jest.fn(),
        fetchImpl: responder(200, SAVED),
        ...over,
    };
}

describe('the request it sends', () => {
    it('PUTs the rows, the freeform layer and expectedVersion', async () => {
        const fetchImpl = responder(200, SAVED);
        await saveTldrawCanvas(input({ fetchImpl }));

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe('/api/t/acme/processes/map-1');
        expect((init as RequestInit).method).toBe('PUT');

        const body = JSON.parse(String((init as RequestInit).body));
        expect(body).toEqual({
            nodes: CANVAS.rows.nodes,
            edges: CANVAS.rows.edges,
            freeformJson: CANVAS.freeform,
            expectedVersion: 4,
        });
    });

    it('sends NO expectedVersion field when the version is unknown', async () => {
        // Asserts the WIRE, which is the property that matters: no
        // `expectedVersion` field reaches the server, so a map whose version
        // is not yet known is still savable and no spurious check is applied.
        //
        // Note what this does NOT prove. `JSON.stringify` drops `undefined`,
        // so replacing the module's conditional spread with a plain
        // `expectedVersion,` reddens nothing — measured. The conditional is
        // belt-and-braces over that, not the mechanism. Stated because the
        // first version of this comment credited the spread.
        const fetchImpl = responder(200, SAVED);
        await saveTldrawCanvas(input({ fetchImpl, expectedVersion: undefined }));

        const body = JSON.parse(
            String((fetchImpl.mock.calls[0]![1] as RequestInit).body),
        );
        expect('expectedVersion' in body).toBe(false);
    });

    it('sends an EMPTY freeform layer rather than omitting it', async () => {
        // Omitting means "leave the stored value alone", so a user who deleted
        // their last sticky would find it back on reload. `[]` erases.
        const fetchImpl = responder(200, SAVED);
        await saveTldrawCanvas(
            input({ fetchImpl, canvas: { rows: CANVAS.rows, freeform: [] } }),
        );

        const body = JSON.parse(
            String((fetchImpl.mock.calls[0]![1] as RequestInit).body),
        );
        expect(body.freeformJson).toEqual([]);
        expect('freeformJson' in body).toBe(true);
    });
});

describe('a version conflict RESOLVES, and does not reject', () => {
    it('surfaces the toast, calls no onSaved, and settles', async () => {
        const { api, error } = toastSpy();
        const fetchImpl = responder(409, {
            error: { code: 'STALE_DATA', details: { currentVersion: 9 } },
        });
        const onSaved = jest.fn();

        // RESOLVES. Rejecting would hand autosave an error for something the
        // reload toast owns, and the user would get two notices for one event.
        await expect(
            saveTldrawCanvas(input({ fetchImpl, toast: api, onSaved })),
        ).resolves.toBeUndefined();

        expect(onSaved).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        // The honesty #2961 asks to preserve verbatim — the warning names the
        // server's version and says the edits will be lost BEFORE the user
        // clicks Reload.
        const [, opts] = error.mock.calls[0]!;
        expect((opts as { description?: string }).description).toContain('v9');
        expect((opts as { description?: string }).description).toContain(
            'will be lost on reload',
        );
    });

    it('wires Reload to the caller, so the conflict has a way out', async () => {
        const { api, error } = toastSpy();
        const onConflict = jest.fn();
        await saveTldrawCanvas(
            input({ fetchImpl: responder(409, {}), toast: api, onConflict }),
        );

        const [, opts] = error.mock.calls[0]!;
        (opts as { action: { onClick: () => void } }).action.onClick();
        expect(onConflict).toHaveBeenCalledTimes(1);
    });
});

describe('any other failure REJECTS', () => {
    it.each([500, 503, 400, 422])('%d throws, so autosave learns the truth', async (status) => {
        // The defect this prevents is documented in `handleSave`: swallowing
        // made every failure look like a success, so the bar rendered "Saved"
        // over unsaved work and the error state was unreachable.
        const onSaved = jest.fn();
        await expect(
            saveTldrawCanvas(input({ fetchImpl: responder(status), onSaved })),
        ).rejects.toThrow(new RegExp(`Save failed \\(${status}\\)`));
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('a network throw propagates untouched', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));
        await expect(saveTldrawCanvas(input({ fetchImpl }))).rejects.toThrow('offline');
    });

    it('and does NOT toast — the caller owns reporting', async () => {
        // A module that both threw and toasted would produce two notices for
        // one failure. The persistent error chip (#3018) is the surface that
        // survives a dismissal.
        const { api, error } = toastSpy();
        await expect(
            saveTldrawCanvas(input({ fetchImpl: responder(500), toast: api })),
        ).rejects.toThrow();
        expect(error).not.toHaveBeenCalled();
    });
});

describe('a success', () => {
    it('hands the fresh version and updatedAt to the caller', async () => {
        const onSaved = jest.fn();
        await saveTldrawCanvas(input({ fetchImpl: responder(200, SAVED), onSaved }));
        expect(onSaved).toHaveBeenCalledWith(SAVED);
    });
});
