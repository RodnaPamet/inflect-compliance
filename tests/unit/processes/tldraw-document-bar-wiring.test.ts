/**
 * @jest-environment jsdom
 *
 * The document bar's four prop groups, built from a tldraw editor.
 *
 * ── What is asserted here and not elsewhere ──────────────────────────
 *
 * `CanvasDocumentBar` has its own tests and is reused unchanged, so nothing
 * here renders it. `saveTldrawCanvas` has its own tests for the WIRE, including
 * whether `name` reaches the payload. What only this hook can be wrong about is
 * the WIRING: which call a bar action becomes, what it carries, and whether the
 * two editor-derived booleans stay current.
 *
 * The three shared helpers are mocked to prove delegation — that
 * `onSwitchMode` becomes `patchCanvasMode` rather than a hand-rolled fetch is
 * the point of reusing them, and a regression would be a new fetch appearing
 * beside them.
 */
import { act, renderHook } from '@testing-library/react';

import {
    SNAP_STORAGE_KEY,
    useTldrawDocumentBar,
} from '@/lib/processes/use-tldraw-document-bar';

/**
 * Parameter TYPED on purpose. `jest.fn(async () => …)` declares no parameters,
 * which makes `mock.calls` the empty tuple — every `calls[0]![0]` assertion
 * below then fails to compile while passing at runtime, so the tests would be
 * green and `Typecheck` red.
 */
const saveTldrawCanvas = jest.fn(
    async (_input: Record<string, unknown>): Promise<void> => undefined,
);
jest.mock('@/lib/processes/tldraw-save', () => ({
    saveTldrawCanvas: (input: Record<string, unknown>) => saveTldrawCanvas(input),
}));

jest.mock('@/components/processes/tldraw/editor-canvas', () => ({
    serializeEditorCanvas: () => ({
        rows: { nodes: [{ nodeKey: 'n1' }], edges: [] },
        freeform: [],
    }),
}));

const patchCanvasMode = jest.fn(async () => undefined);
const patchProcessStatus = jest.fn(async () => undefined);
const deleteProcessMap = jest.fn(async () => undefined);
jest.mock('@/lib/processes/switch-canvas-mode', () => ({
    patchCanvasMode: (...a: unknown[]) => patchCanvasMode(...(a as [])),
    patchProcessStatus: (...a: unknown[]) => patchProcessStatus(...(a as [])),
    deleteProcessMap: (...a: unknown[]) => deleteProcessMap(...(a as [])),
}));

const PROCESS = {
    id: 'map-1',
    name: 'Invoice approval',
    status: 'DRAFT',
    version: 4,
    canvasMode: 'DOCUMENT' as const,
};

/** A fake editor exposing only what the hook touches. */
function fakeEditor(over: { canUndo?: boolean; canRedo?: boolean } = {}) {
    let listener: (() => void) | null = null;
    const prefs: Array<Record<string, unknown>> = [];
    const state = { canUndo: over.canUndo ?? false, canRedo: over.canRedo ?? false };
    return {
        editor: {
            getCanUndo: () => state.canUndo,
            getCanRedo: () => state.canRedo,
            undo: jest.fn(),
            redo: jest.fn(),
            store: {
                listen: (fn: () => void) => {
                    listener = fn;
                    return () => {
                        listener = null;
                    };
                },
            },
            user: { updateUserPreferences: (p: Record<string, unknown>) => prefs.push(p) },
        },
        /** Flip history availability and notify, as a real edit would. */
        emit(next: { canUndo?: boolean; canRedo?: boolean }) {
            Object.assign(state, next);
            listener?.();
        },
        prefs,
        isListening: () => listener !== null,
    };
}

function setup(over: Partial<Parameters<typeof useTldrawDocumentBar>[0]> = {}) {
    const f = fakeEditor();
    const onProcessesChange = jest.fn();
    const onActiveIdChange = jest.fn();
    const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'map-2', name: 'new', status: 'DRAFT', version: 1 }),
    })) as unknown as typeof fetch;

    const hook = renderHook(() =>
        useTldrawDocumentBar({
            tenantSlug: 'acme',
            editor: f.editor as never,
            mapId: 'map-1',
            processes: [PROCESS],
            activeProcess: PROCESS,
            version: 4,
            autosaveStatus: 'idle',
            autosaveError: null,
            toast: { error: jest.fn() } as never,
            onActiveIdChange,
            onProcessesChange,
            onSaved: jest.fn(),
            onConflict: jest.fn(),
            fetchImpl,
            ...over,
        }),
    );
    return { hook, f, onProcessesChange, onActiveIdChange, fetchImpl };
}

beforeEach(() => {
    jest.clearAllMocks();
    try {
        window.localStorage.clear();
    } catch {
        /* ignore */
    }
});

describe('rename routes through the save, not a second fetch', () => {
    it('sends the new name WITH the version token', async () => {
        // The design decision. A separate PUT would have to re-derive the
        // version, and the one that forgot would write over a concurrent edit.
        const { hook } = setup();
        act(() => hook.result.current.handlers.setEditedName('Quarterly close'));
        await act(async () => {
            await hook.result.current.handlers.handleRenameCommit();
        });

        expect(saveTldrawCanvas).toHaveBeenCalledTimes(1);
        expect(saveTldrawCanvas.mock.calls[0]![0]).toMatchObject({
            mapId: 'map-1',
            name: 'Quarterly close',
            expectedVersion: 4,
        });
    });

    it('optimistically updates the summary list', async () => {
        const { hook, onProcessesChange } = setup();
        act(() => hook.result.current.handlers.setEditedName('Renamed'));
        await act(async () => {
            await hook.result.current.handlers.handleRenameCommit();
        });
        expect(onProcessesChange).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'map-1', name: 'Renamed' }),
        ]);
    });

    it('refuses an EMPTY name and snaps the field back', async () => {
        // Clearing the field and blurring must not send `name: ''`. The check
        // lives here rather than in the save, next to the text input.
        const { hook } = setup();
        act(() => hook.result.current.handlers.setEditedName('   '));
        await act(async () => {
            await hook.result.current.handlers.handleRenameCommit();
        });
        expect(saveTldrawCanvas).not.toHaveBeenCalled();
        expect(hook.result.current.doc.editedName).toBe('Invoice approval');
    });

    it('and an UNCHANGED name is a no-op', async () => {
        const { hook } = setup();
        act(() => hook.result.current.handlers.setEditedName('Invoice approval'));
        await act(async () => {
            await hook.result.current.handlers.handleRenameCommit();
        });
        expect(saveTldrawCanvas).not.toHaveBeenCalled();
    });

    it('a plain save carries NO name', async () => {
        // Teeth for the rename test: a hook that always passed `editedName`
        // would satisfy it while making every autosave a rename.
        const { hook } = setup();
        await act(async () => {
            await hook.result.current.handlers.handleSave();
        });
        expect(Object.keys(saveTldrawCanvas.mock.calls[0]![0])).not.toContain('name');
    });
});

describe('undo/redo is OBSERVED, not read once', () => {
    it('subscribes to the store', () => {
        const { f } = setup();
        expect(f.isListening()).toBe(true);
    });

    it('reflects a change in availability without a re-render from elsewhere', () => {
        // `getCanUndo()` is a read. Called once, the bar's buttons would stay
        // wrong until something unrelated re-rendered the tree.
        const { hook, f } = setup();
        expect(hook.result.current.editorState.canUndo).toBe(false);

        act(() => f.emit({ canUndo: true, canRedo: true }));

        expect(hook.result.current.editorState.canUndo).toBe(true);
        expect(hook.result.current.editorState.canRedo).toBe(true);
    });

    it('unsubscribes on unmount', () => {
        const { hook, f } = setup();
        hook.unmount();
        expect(f.isListening()).toBe(false);
    });

    it('reports both false with no editor, rather than throwing', () => {
        const { hook } = setup({ editor: null });
        expect(hook.result.current.editorState).toMatchObject({
            canUndo: false,
            canRedo: false,
        });
    });

    it('delegates the actions to the editor', () => {
        const { hook, f } = setup();
        act(() => hook.result.current.handlers.handleUndo());
        act(() => hook.result.current.handlers.handleRedo());
        expect(f.editor.undo).toHaveBeenCalledTimes(1);
        expect(f.editor.redo).toHaveBeenCalledTimes(1);
    });
});

describe('snap shares the xyflow preference', () => {
    it('writes the SAME localStorage key, so the flag flip does not reset it', () => {
        // The parity detail. A separate key would silently drop the user's
        // setting at cutover and read as lost state.
        expect(SNAP_STORAGE_KEY).toBe('inflect:processes:snap');
        const { hook } = setup();
        act(() => hook.result.current.handlers.setSnapEnabled(true));
        expect(window.localStorage.getItem(SNAP_STORAGE_KEY)).toBe('1');
        expect(hook.result.current.editorState.snapEnabled).toBe(true);
    });

    it('reads that key on mount', () => {
        window.localStorage.setItem(SNAP_STORAGE_KEY, '1');
        const { hook } = setup();
        expect(hook.result.current.editorState.snapEnabled).toBe(true);
    });

    it('tells the editor too, not just localStorage', () => {
        const { hook, f } = setup();
        act(() => hook.result.current.handlers.setSnapEnabled(true));
        expect(f.prefs).toEqual([{ isSnapMode: true }]);
    });

    it('accepts an updater function, as the bar passes one', () => {
        const { hook } = setup();
        act(() => hook.result.current.handlers.setSnapEnabled((p) => !p));
        expect(hook.result.current.editorState.snapEnabled).toBe(true);
    });
});

describe('the three already-shared helpers are DELEGATED to', () => {
    it('onSwitchMode calls patchCanvasMode and flips the mode', async () => {
        const { hook, onProcessesChange } = setup();
        await act(async () => {
            await hook.result.current.handlers.onSwitchMode();
        });
        expect(patchCanvasMode).toHaveBeenCalledWith('acme', 'map-1', 'AUTOMATION');
        expect(onProcessesChange).toHaveBeenCalledWith([
            expect.objectContaining({ canvasMode: 'AUTOMATION' }),
        ]);
    });

    it('onChangeStatus calls patchProcessStatus', async () => {
        const { hook } = setup();
        await act(async () => {
            await hook.result.current.handlers.onChangeStatus('ACTIVE');
        });
        expect(patchProcessStatus).toHaveBeenCalledWith('acme', 'map-1', 'ACTIVE');
    });

    it('and does nothing when the status already matches', async () => {
        const { hook } = setup();
        await act(async () => {
            await hook.result.current.handlers.onChangeStatus('DRAFT');
        });
        expect(patchProcessStatus).not.toHaveBeenCalled();
    });

    it('onDelete removes the map and selects what remains', async () => {
        const { hook, onProcessesChange, onActiveIdChange } = setup();
        await act(async () => {
            await hook.result.current.handlers.onDelete();
        });
        expect(deleteProcessMap).toHaveBeenCalledWith('acme', 'map-1');
        expect(onProcessesChange).toHaveBeenCalledWith([]);
        expect(onActiveIdChange).toHaveBeenCalledWith(null);
    });
});

describe('duplicate', () => {
    it('seeds the copy with the current canvas and sends NO expectedVersion', async () => {
        // By construction: the copy was just created, so there is no prior
        // version to guard, and sending the SOURCE map's version would be a
        // mismatch that 409s every duplicate.
        const { hook, fetchImpl } = setup();
        await act(async () => {
            await hook.result.current.handlers.handleDuplicate();
        });

        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/t/acme/processes',
            expect.objectContaining({ method: 'POST' }),
        );
        const saveArgs = saveTldrawCanvas.mock.calls[0]![0];
        expect(saveArgs).toMatchObject({ mapId: 'map-2' });
        expect(Object.keys(saveArgs)).not.toContain('expectedVersion');
    });

    it('selects the copy once it exists', async () => {
        const { hook, onActiveIdChange } = setup();
        await act(async () => {
            await hook.result.current.handlers.handleDuplicate();
        });
        expect(onActiveIdChange).toHaveBeenCalledWith('map-2');
    });
});

describe('the prop groups the bar actually receives', () => {
    it('doc carries the version as loadedMap, which is what the bar reads', () => {
        const { hook } = setup();
        expect(hook.result.current.doc).toMatchObject({
            activeId: 'map-1',
            editedName: 'Invoice approval',
            loadedMap: { version: 4 },
        });
    });

    it('and loadedMap is NULL when no version is known', () => {
        // Distinguishes "version 0" from "not loaded". The bar renders a
        // version pill; a missing version must not read as version zero.
        const { hook } = setup({ version: undefined });
        expect(hook.result.current.doc.loadedMap).toBeNull();
    });

    it('busy exposes the four flags the bar expects', () => {
        const { hook } = setup();
        expect(hook.result.current.busy).toEqual({
            saving: false,
            loading: false,
            creating: false,
            duplicating: false,
        });
    });

    it('editorState passes the autosave status straight through', () => {
        const { hook } = setup({ autosaveStatus: 'saving', autosaveError: 'boom' });
        expect(hook.result.current.editorState).toMatchObject({
            autosaveStatus: 'saving',
            autosaveError: 'boom',
        });
    });
});
