/**
 * @jest-environment jsdom
 *
 * A palette drag creates a node on the tldraw canvas.
 *
 * ── Why this is not optional chrome ──────────────────────────────────
 *
 * Drag-from-palette is the ONLY creation path. `ProcessPalette` takes no props
 * and renders anywhere, which made it look free — but rendering is not its
 * function, and the tldraw canvas had no `onDrop` at all. Without this the
 * canvas can open, move, rename, delete, export and inspect a map and never add
 * to one, which is not worth putting behind a flag.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render, screen } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas, mintNodeKey } from '@/components/processes/TldrawProcessCanvas';
import { PALETTE_DRAG_MIME } from '@/components/processes/ProcessPalette';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const EMPTY: GraphRows = { nodes: [], edges: [] };

async function mount(readOnly = false): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <TldrawProcessCanvas
                    rows={EMPTY}
                    readOnly={readOnly}
                    onEditorReady={(e) => (editor = e)}
                />
            </div>,
        );
    });
    if (!editor) throw new Error('the host did not finish mounting');
    return editor;
}

/** Process node shapes currently in the store. */
function nodes(editor: Editor) {
    return editor.store
        .allRecords()
        .filter(
            (r) =>
                r.typeName === 'shape' &&
                (r as { type?: string }).type === PROCESS_NODE_SHAPE_TYPE,
        ) as Array<{ x: number; y: number; props: { nodeKey: string; nodeType: string; label: string } }>;
}

/** A drop carrying `payload` at the given client point. */
async function drop(payload: string | null, at = { clientX: 300, clientY: 220 }) {
    const host = document.querySelector('[data-tldraw-process-canvas="true"]');
    if (!host) throw new Error('canvas host not found');
    const data = new Map<string, string>();
    if (payload !== null) data.set(PALETTE_DRAG_MIME, payload);
    await act(async () => {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.assign(event, {
            ...at,
            dataTransfer: { getData: (k: string) => data.get(k) ?? '', dropEffect: '' },
        });
        host.dispatchEvent(event);
    });
}

describe('dropping a palette item', () => {
    it('creates a node of the dragged KIND with its label', async () => {
        const editor = await mount();
        expect(nodes(editor)).toHaveLength(0);

        await drop(JSON.stringify({ kind: 'decision', label: 'Over threshold?' }));

        const created = nodes(editor);
        expect(created).toHaveLength(1);
        expect(created[0]!.props.nodeType).toBe('decision');
        expect(created[0]!.props.label).toBe('Over threshold?');
    });

    it('mints a nodeKey, because the shape id and the key are separate here', async () => {
        // On xyflow a node's id IS its key, so creation mints one implicitly.
        // Here they are distinct, and a node with no key cannot become a row.
        const editor = await mount();
        await drop(JSON.stringify({ kind: 'processStep', label: 'Step' }));
        expect(nodes(editor)[0]!.props.nodeKey).toMatch(/^node-/);
    });

    it('falls back to a step for a NON-JSON payload rather than throwing', async () => {
        // The payload crosses a `dataTransfer` boundary, so anything can
        // arrive. A default-labelled step beats an exception.
        const editor = await mount();
        await drop('not json at all');
        const created = nodes(editor);
        expect(created).toHaveLength(1);
        expect(created[0]!.props.nodeType).toBe('processStep');
        expect(created[0]!.props.label).toBe('not json at all');
    });

    it('falls back for a JSON payload with an UNKNOWN kind', async () => {
        // Valid JSON, invalid kind — `isProcessNodeKind` is what rejects it,
        // and the fallback must still produce a usable node.
        const editor = await mount();
        await drop(JSON.stringify({ kind: 'not-a-real-kind', label: 'x' }));
        expect(nodes(editor)[0]!.props.nodeType).toBe('processStep');
    });

    it('ignores a drop carrying no palette payload', async () => {
        // A file dragged onto the canvas, say. Creating a node for it would be
        // worse than ignoring it.
        const editor = await mount();
        await drop(null);
        expect(nodes(editor)).toHaveLength(0);
    });

    it('creates NOTHING when the canvas is read-only', async () => {
        // `readOnly` refuses the write, not just the affordance — the same
        // distinction the autosave makes between the UI and the network.
        const editor = await mount(true);
        await drop(JSON.stringify({ kind: 'processStep', label: 'Step' }));
        expect(nodes(editor)).toHaveLength(0);
    });

    it('and DOES create when not read-only — teeth for the above', async () => {
        const editor = await mount(false);
        await drop(JSON.stringify({ kind: 'processStep', label: 'Step' }));
        expect(nodes(editor)).toHaveLength(1);
    });

    it('is undoable, because the drop marks a history stopping point', async () => {
        // The xyflow handler had to be FIXED to push history — dropping a node
        // and pressing undo did nothing. Asserted here so it cannot regress
        // into the same state on this engine.
        const editor = await mount();
        await drop(JSON.stringify({ kind: 'processStep', label: 'Step' }));
        expect(nodes(editor)).toHaveLength(1);
        expect(editor.getCanUndo()).toBe(true);

        await act(async () => {
            editor.undo();
        });
        expect(nodes(editor)).toHaveLength(0);
    });
});

describe('mintNodeKey', () => {
    it('does not collide across two calls in the same millisecond', () => {
        // The xyflow handler uses `node-${Date.now()}`, which two drops inside
        // one millisecond share. A duplicate nodeKey is not cosmetic: the row
        // is keyed on it, so the save would collapse two nodes into one.
        const keys = new Set(Array.from({ length: 200 }, () => mintNodeKey()));
        expect(keys.size).toBe(200);
    });
});
