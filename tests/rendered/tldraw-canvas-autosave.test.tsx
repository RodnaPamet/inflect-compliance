/**
 * @jest-environment jsdom
 *
 * The autosave composition — and the stale-version trap it exists to avoid.
 *
 * ── The failure this file is mostly about ────────────────────────────
 *
 * `save` is handed to a hook that stores it and calls it later. Close over
 * `expectedVersion` by value and the FIRST save succeeds — bumping the server's
 * version — while every save after it sends the version before that one. The
 * server refuses each with 409, the reload toast fires on every autosave cycle,
 * and the canvas becomes unsaveable while presenting as a conflict between two
 * users. There is no second user.
 *
 * A test that saves ONCE cannot see this. The central test below saves, feeds
 * the new version back the way a caller would, and saves again.
 *
 * ── Why the editor is a stub ─────────────────────────────────────────
 *
 * `serializeEditorCanvas` is exercised against a real mounted editor in
 * `editor-canvas-serializes-the-page`. What is under test here is the
 * COMPOSITION — which version reaches the wire, when a save is allowed to fire
 * at all — so the editor is the smallest object that module reads. Mounting a
 * real one would add ~36s of jest floor and test something already covered.
 */
import { act, renderHook } from '@testing-library/react';
import type { Editor } from 'tldraw';

import type { ToastApi } from '@inflect/ui/components/ui/hooks/use-toast';
import {
    useTldrawCanvasAutosave,
    type UseTldrawCanvasAutosaveOptions,
} from '@/lib/processes/use-tldraw-canvas-autosave';

const DELAY = 3000;

/** The smallest object `serializeEditorCanvas` reads. */
function stubEditor(): Editor {
    return {
        getCurrentPageShapes: () => [],
        store: { allRecords: () => [] },
    } as unknown as Editor;
}

function toastStub(): ToastApi {
    return { error: jest.fn() } as unknown as ToastApi;
}

const OK_BODY = {
    id: 'map-1',
    version: 5,
    updatedAt: 'now',
    nodes: [],
    edges: [],
};

const responder = (status: number, body: unknown = OK_BODY) =>
    jest.fn().mockResolvedValue({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    });

/**
 * `fetchMock` is a PARAMETER, not something this helper picks.
 *
 * It used to assign `globalThis.fetch` itself, which silently clobbered any
 * responder a test had set beforehand. One test failed loudly on that and one
 * — the 409 case — PASSED, because a 200 also settles as `saved`, so it was
 * asserting the right thing about the wrong response. Both were fixed by making
 * the caller own the mock.
 */
function setup(
    over: Partial<UseTldrawCanvasAutosaveOptions> = {},
    fetchMock: jest.Mock = responder(200),
) {
    // The module reaches the global `fetch` through `saveTldrawCanvas`'s default.
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const props: UseTldrawCanvasAutosaveOptions = {
        editor: stubEditor(),
        tenantSlug: 'acme',
        mapId: 'map-1',
        expectedVersion: 4,
        toast: toastStub(),
        onConflict: jest.fn(),
        onSaved: jest.fn(),
        delayMs: DELAY,
        ...over,
    };
    const view = renderHook(
        (p: UseTldrawCanvasAutosaveOptions) => useTldrawCanvasAutosave(p),
        { initialProps: props },
    );
    return { view, fetchMock, props };
}

/** Let the debounce fire and the save settle. */
async function flush() {
    await act(async () => {
        jest.advanceTimersByTime(DELAY);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

const versionsSent = (m: jest.Mock): unknown[] =>
    m.mock.calls.map(
        (c) => JSON.parse(String((c[1] as RequestInit).body)).expectedVersion,
    );

afterEach(() => {
    jest.useRealTimers();
});

describe('the version it sends', () => {
    it('sends the CURRENT version on every save, not the one it mounted with', async () => {
        // THE test. Save once, feed the new version back as a caller would,
        // save again — and the second request must carry 5, not 4.
        jest.useFakeTimers();
        const { view, fetchMock, props } = setup();

        act(() => view.result.current.markDirty());
        await flush();
        expect(versionsSent(fetchMock)).toEqual([4]);

        // The caller's job after `onSaved`: re-render with the fresh version.
        view.rerender({ ...props, expectedVersion: 5 });

        act(() => view.result.current.markDirty());
        await flush();

        // A closure over `expectedVersion` would send [4, 4] here, the server
        // would 409, and the reload toast would fire on every cycle.
        expect(versionsSent(fetchMock)).toEqual([4, 5]);
    });

    it('follows a changed mapId too', async () => {
        // Switching the selected map must not save the new canvas over the old
        // map's row set.
        jest.useFakeTimers();
        const { view, fetchMock, props } = setup();

        act(() => view.result.current.markDirty());
        await flush();
        expect(String(fetchMock.mock.calls[0]![0])).toContain('/processes/map-1');

        view.rerender({ ...props, mapId: 'map-2' });
        act(() => view.result.current.markDirty());
        await flush();
        expect(String(fetchMock.mock.calls[1]![0])).toContain('/processes/map-2');
    });
});

describe('when a save is allowed to fire at all', () => {
    it('does nothing with no editor — it has not mounted yet', async () => {
        jest.useFakeTimers();
        const { view, fetchMock } = setup({ editor: null });
        act(() => view.result.current.markDirty());
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does nothing with no map selected', async () => {
        // Without this the PUT would go to `/processes/null`.
        jest.useFakeTimers();
        const { view, fetchMock } = setup({ mapId: null });
        act(() => view.result.current.markDirty());
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('respects an explicit enabled: false, e.g. while loading', async () => {
        jest.useFakeTimers();
        const { view, fetchMock } = setup({ enabled: false });
        act(() => view.result.current.markDirty());
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('and starts working once the editor arrives', async () => {
        // Teeth for all three above: a hook that never saved would pass them.
        jest.useFakeTimers();
        const { view, fetchMock, props } = setup({ editor: null });

        act(() => view.result.current.markDirty());
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();

        view.rerender({ ...props, editor: stubEditor() });
        act(() => view.result.current.markDirty());
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('it still reports the truth to the state machine', () => {
    it('a failure leaves status error, so the chip can show it', async () => {
        jest.useFakeTimers();
        const fetchMock = responder(500, {});
        const { view } = setup({}, fetchMock);

        act(() => view.result.current.markDirty());
        await flush();

        // Assert the response was actually exercised, not just the outcome —
        // the earlier version of this test never reached a 500 at all.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The composition must not swallow — that defect is documented in
        // `handleSave` and cost a bar rendering "Saved" over unsaved work.
        expect(view.result.current.status).toBe('error');
    });

    it('a 409 settles as saved, because the reload toast owns it', async () => {
        jest.useFakeTimers();
        const fetchMock = responder(409, {
            error: { details: { currentVersion: 9 } },
        });
        const toast = toastStub();
        const { view } = setup({ toast }, fetchMock);

        act(() => view.result.current.markDirty());
        await flush();

        // The discriminator this test lacked: prove a 409 was the response.
        // With a 200 it asserted the right thing about the wrong status and
        // passed anyway.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((toast.error as jest.Mock)).toHaveBeenCalledTimes(1);

        expect(view.result.current.status).toBe('saved');
        expect(view.result.current.error).toBeNull();
    });
});
