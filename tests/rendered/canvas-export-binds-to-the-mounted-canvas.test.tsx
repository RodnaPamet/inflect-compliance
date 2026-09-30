/**
 * @jest-environment jsdom
 *
 * The exporter can find the canvas that is actually mounted.
 *
 * ── The gap this closes ──────────────────────────────────────────────
 *
 * `canvas-export.ts` locates what to rasterise with a hard-coded engine class:
 *
 *     canvasEl.querySelector<HTMLElement>(".react-flow__viewport")
 *
 * Five paths go through it — PNG download, SVG download, clipboard copy, the
 * PDF route, and `attachCanvasPngToEvidence`, which is how a process map
 * reaches an audit pack. If it resolves to `null` every one of them throws
 * `"Canvas viewport not found"`.
 *
 * Two tests already sit around that selector and **neither would notice**:
 *
 *   - `p3a-canvas-export-png-svg` pins the literal string *inside
 *     `canvas-export.ts`*. It stays green if the canvas is swapped and the
 *     selector left alone — and goes RED when the selector is correctly
 *     updated. It fights the fix rather than confirming it.
 *   - `canvas-export.test.ts` asserts `resolveViewportEl` works against
 *     `mountCanvas()`, which HAND-WRITES
 *     `<div data-process-canvas><div class="react-flow__viewport">`. The
 *     fixture *is* the engine's DOM, so it passes forever regardless of what
 *     the product renders.
 *
 * So the selector is pinned in two places and bound to the real DOM in
 * neither. Swap the renderer and all five paths throw at runtime with a fully
 * green suite. Unit coverage of both halves is not coverage of the seam.
 *
 * ── Why this file mounts the real canvas ─────────────────────────────
 *
 * The only assertion that cannot drift is one where the DOM comes from the
 * component that ships. `ProcessCanvas` takes three optional props and brings
 * its own `ReactFlowProvider`, so mounting it costs almost nothing — and it is
 * the same wrapper `PersistedProcessCanvas` hands the export menu via
 * `canvasWrapperRef`.
 *
 * This is deliberately NOT a source scan. A third assertion about the text of
 * `canvas-export.ts` would add a third thing to update at the swap and still
 * prove nothing about the page.
 */
import { render } from '@testing-library/react';
import { toPng } from 'html-to-image';

import { ProcessCanvas } from '@/components/processes/ProcessCanvas';
import { exportCanvasAsPng, __INTERNAL } from '@/lib/processes/canvas-export';

// The rasterisation itself is a browser concern. What is under test is WHICH
// element reaches it, so the mock records the argument rather than replacing
// the lookup that produced it.
jest.mock('html-to-image', () => ({
    toPng: jest.fn().mockResolvedValue('data:image/png;base64,AAAA'),
    toSvg: jest.fn().mockResolvedValue('data:image/svg+xml,<svg></svg>'),
}));

const mockToPng = toPng as jest.MockedFunction<typeof toPng>;

/** Mount the real canvas and return the wrapper the export menu is given. */
function mountRealCanvas(): HTMLElement {
    const { container } = render(<ProcessCanvas />);
    return wrapperIn(container);
}

function wrapperIn(root: HTMLElement): HTMLElement {
    const wrapper = root.querySelector<HTMLElement>('[data-process-canvas="true"]');
    if (!wrapper) {
        // If this ever fires, the wrapper contract itself moved — which the
        // export menu depends on just as much as the selector below.
        throw new Error('[data-process-canvas="true"] wrapper not rendered');
    }
    return wrapper;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('the export viewport lookup resolves against the mounted canvas', () => {
    it('finds a viewport inside the real wrapper, not a hand-built one', () => {
        const wrapper = mountRealCanvas();
        // The whole point: this DOM came from the component that ships.
        expect(__INTERNAL.resolveViewportEl(wrapper)).not.toBeNull();
    });

    it('is scoped to the wrapper it was handed, not the document', () => {
        // MEASURED, because the first draft of this test did not actually check
        // it. With one canvas mounted, `wrapper.contains(viewport)` holds even
        // for a document-wide lookup — the single canvas IS the document's
        // canvas — so mutating `canvasEl.querySelector` to
        // `document.querySelector` left every assertion green.
        //
        // Two canvases is what makes the claim decidable: a document-wide
        // lookup returns the FIRST one for both wrappers, so exporting the
        // second map would silently rasterise the first.
        const first = render(<ProcessCanvas />);
        const second = render(<ProcessCanvas />);

        const wrapperA = wrapperIn(first.container);
        const wrapperB = wrapperIn(second.container);
        expect(wrapperA).not.toBe(wrapperB);

        const viewportA = __INTERNAL.resolveViewportEl(wrapperA);
        const viewportB = __INTERNAL.resolveViewportEl(wrapperB);

        expect(wrapperA.contains(viewportA)).toBe(true);
        expect(wrapperB.contains(viewportB)).toBe(true);
        // The discriminator: each wrapper resolves its OWN viewport.
        expect(viewportA).not.toBe(viewportB);
        expect(wrapperA.contains(viewportB)).toBe(false);
        expect(viewportA).not.toBe(wrapperA);
    });

    it('a real export reaches rasterisation instead of throwing', async () => {
        // The end-to-end shape of the runtime failure a renderer swap causes:
        // `Canvas viewport not found`, thrown before any bytes exist.
        const wrapper = mountRealCanvas();

        await expect(
            exportCanvasAsPng({ canvasEl: wrapper, nodes: [], mapName: 'Order to cash' }),
        ).resolves.toBe('data:image/png;base64,AAAA');

        expect(mockToPng).toHaveBeenCalledTimes(1);
        const [passed] = mockToPng.mock.calls[0];
        // Rasterise the viewport, never the wrapper: the wrapper also contains
        // the palette slot and the empty-state overlay.
        expect(wrapper.contains(passed as HTMLElement)).toBe(true);
        expect(passed).not.toBe(wrapper);
    });

    it('and it still refuses a wrapper with no canvas in it', async () => {
        // Teeth in the other direction. Without this, a lookup rewritten to
        // return the wrapper itself would satisfy every assertion above while
        // rasterising the palette along with the graph.
        const bare = document.createElement('div');
        bare.setAttribute('data-process-canvas', 'true');
        document.body.appendChild(bare);

        expect(__INTERNAL.resolveViewportEl(bare)).toBeNull();
        await expect(
            exportCanvasAsPng({ canvasEl: bare, nodes: [], mapName: 'Empty' }),
        ).rejects.toThrow(/Canvas viewport not found/);
    });
});
