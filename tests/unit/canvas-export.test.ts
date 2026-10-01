/**
 * @jest-environment jsdom
 *
 * Unit tests for src/lib/processes/canvas-export.ts — process canvas
 * PNG/SVG/PDF/clipboard/evidence export helpers.
 *
 * `html-to-image` is mocked (the DOM->image rasterisation is a browser
 * concern and not under test). `@xyflow/react`'s `getNodesBounds` /
 * `getViewportForBounds` are pure maths and run for real.
 *
 * Branches covered:
 *   - resolveViewportEl present / absent (every export's "viewport not
 *     found" throw)
 *   - exportTransform empty-nodes default + populated-nodes path
 *   - resolveBackground light vs dark theme
 *   - safeFilename normal / empty / over-length-truncation
 *   - PNG + SVG download side-effect (anchor click + download attr)
 *   - clipboard copy: happy path + three guard throws
 *   - canCopyImageToClipboard true/false
 *   - PDF export: ok + non-ok response
 *   - Evidence attach: id / evidenceId / failure
 */
import {
    exportCanvasAsPng,
    exportCanvasAsSvg,
    copyCanvasAsImageToClipboard,
    exportCanvasAsPdf,
    attachCanvasPngToEvidence,
    __INTERNAL,
    type CanvasExportOptions,
} from '@/lib/processes/canvas-export';
// Moved to the shared module — it asks about the BROWSER, not the canvas.
import { canCopyImageToClipboard } from '@/lib/processes/canvas-export-shared';
import { toPng, toSvg } from 'html-to-image';
import type { Node } from '@xyflow/react';

jest.mock('html-to-image', () => ({
    toPng: jest.fn().mockResolvedValue('data:image/png;base64,AAAA'),
    toSvg: jest.fn().mockResolvedValue('data:image/svg+xml,<svg></svg>'),
}));

const mockToPng = toPng as jest.MockedFunction<typeof toPng>;
const mockToSvg = toSvg as jest.MockedFunction<typeof toSvg>;

const NODES: Node[] = [
    { id: 'a', position: { x: 0, y: 0 }, data: {}, measured: { width: 120, height: 60 } },
    { id: 'b', position: { x: 400, y: 200 }, data: {}, measured: { width: 120, height: 60 } },
];

function mountCanvas(withViewport = true): HTMLElement {
    document.body.innerHTML = withViewport
        ? '<div data-process-canvas="true"><div class="react-flow__viewport"></div></div>'
        : '<div data-process-canvas="true"></div>';
    return document.querySelector<HTMLElement>('[data-process-canvas="true"]')!;
}

function makeOpts(overrides: Partial<CanvasExportOptions> = {}): CanvasExportOptions {
    return {
        canvasEl: mountCanvas(),
        nodes: NODES,
        mapName: 'My Process Map',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    document.documentElement.setAttribute('data-theme', 'dark');
});

describe('__INTERNAL.safeFilename', () => {
    it('slugifies a normal name + extension', () => {
        expect(__INTERNAL.safeFilename('My Process Map', 'png')).toBe('my-process-map.png');
    });

    it('falls back to "process-map" for an all-symbol name', () => {
        expect(__INTERNAL.safeFilename('***', 'svg')).toBe('process-map.svg');
    });

    it('truncates to 60 chars of stem', () => {
        const long = 'a'.repeat(120);
        const out = __INTERNAL.safeFilename(long, 'pdf');
        expect(out).toBe(`${'a'.repeat(60)}.pdf`);
    });
});

describe('__INTERNAL.exportTransform', () => {
    it('returns the fixed default for an empty node list', () => {
        expect(__INTERNAL.exportTransform([])).toEqual({
            width: 800,
            height: 600,
            transform: [0, 0, 1],
        });
    });

    it('computes a width/height/transform from real node bounds', () => {
        const t = __INTERNAL.exportTransform(NODES);
        expect(t.width).toBeGreaterThanOrEqual(320);
        expect(t.height).toBeGreaterThanOrEqual(240);
        expect(t.transform).toHaveLength(3);
        expect(Number.isFinite(t.transform[2])).toBe(true);
    });
});

describe('__INTERNAL.resolveViewportEl', () => {
    it('finds the .react-flow__viewport child', () => {
        const el = mountCanvas(true);
        expect(__INTERNAL.resolveViewportEl(el)).not.toBeNull();
    });

    it('returns null when the viewport child is absent', () => {
        const el = mountCanvas(false);
        expect(__INTERNAL.resolveViewportEl(el)).toBeNull();
    });
});

describe('exportCanvasAsPng', () => {
    it('calls toPng on the viewport, downloads, and returns the data URL', async () => {
        const clickSpy = jest
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => {});

        const result = await exportCanvasAsPng(makeOpts());

        expect(result).toBe('data:image/png;base64,AAAA');
        expect(mockToPng).toHaveBeenCalledTimes(1);
        const [el, options] = mockToPng.mock.calls[0];
        expect((el as HTMLElement).className).toContain('react-flow__viewport');
        // dark theme background token
        expect(options?.backgroundColor).toBe('#0A2138');
        expect(clickSpy).toHaveBeenCalledTimes(1);
        clickSpy.mockRestore();
    });

    it('uses the light background token when data-theme=light', async () => {
        document.documentElement.setAttribute('data-theme', 'light');
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        await exportCanvasAsPng(makeOpts());
        expect(mockToPng.mock.calls[0][1]?.backgroundColor).toBe('#FBFAF8');
    });

    it('throws when the viewport element is missing', async () => {
        await expect(
            exportCanvasAsPng(makeOpts({ canvasEl: mountCanvas(false) })),
        ).rejects.toThrow('Canvas viewport not found');
        expect(mockToPng).not.toHaveBeenCalled();
    });
});

describe('exportCanvasAsSvg', () => {
    it('calls toSvg and returns the data URL', async () => {
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const result = await exportCanvasAsSvg(makeOpts());
        expect(result).toBe('data:image/svg+xml,<svg></svg>');
        expect(mockToSvg).toHaveBeenCalledTimes(1);
    });

    it('throws when the viewport element is missing', async () => {
        await expect(
            exportCanvasAsSvg(makeOpts({ canvasEl: mountCanvas(false) })),
        ).rejects.toThrow('Canvas viewport not found');
    });
});

describe('clipboard helpers', () => {
    const realClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

    function setClipboard(value: unknown) {
        Object.defineProperty(navigator, 'clipboard', {
            value,
            configurable: true,
        });
    }

    afterEach(() => {
        if (realClipboardDesc) {
            Object.defineProperty(navigator, 'clipboard', realClipboardDesc);
        } else {
            setClipboard(undefined);
        }
        delete (global as unknown as { ClipboardItem?: unknown }).ClipboardItem;
    });

    it('canCopyImageToClipboard returns true when both APIs exist', () => {
        setClipboard({ write: jest.fn() });
        (global as unknown as { ClipboardItem: unknown }).ClipboardItem = class {};
        expect(canCopyImageToClipboard()).toBe(true);
    });

    it('canCopyImageToClipboard returns false without clipboard.write', () => {
        setClipboard({});
        (global as unknown as { ClipboardItem: unknown }).ClipboardItem = class {};
        expect(canCopyImageToClipboard()).toBe(false);
    });

    it('canCopyImageToClipboard returns false without ClipboardItem', () => {
        setClipboard({ write: jest.fn() });
        delete (global as unknown as { ClipboardItem?: unknown }).ClipboardItem;
        expect(canCopyImageToClipboard()).toBe(false);
    });

    it('copies a PNG blob to the clipboard on the happy path', async () => {
        const write = jest.fn().mockResolvedValue(undefined);
        setClipboard({ write });
        (global as unknown as { ClipboardItem: new (i: unknown) => unknown }).ClipboardItem =
            class {
                constructor(public items: unknown) {}
            };

        await copyCanvasAsImageToClipboard(makeOpts());

        expect(mockToPng).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(1);
        expect(Array.isArray(write.mock.calls[0][0])).toBe(true);
    });

    it('throws when clipboard.write is unavailable', async () => {
        setClipboard(undefined);
        (global as unknown as { ClipboardItem: unknown }).ClipboardItem = class {};
        await expect(copyCanvasAsImageToClipboard(makeOpts())).rejects.toThrow(
            /doesn't support copying images/,
        );
    });

    it('throws when ClipboardItem is unavailable', async () => {
        setClipboard({ write: jest.fn() });
        delete (global as unknown as { ClipboardItem?: unknown }).ClipboardItem;
        await expect(copyCanvasAsImageToClipboard(makeOpts())).rejects.toThrow(
            /doesn't support copying images/,
        );
    });

    it('throws when the viewport is missing', async () => {
        setClipboard({ write: jest.fn() });
        (global as unknown as { ClipboardItem: unknown }).ClipboardItem = class {};
        await expect(
            copyCanvasAsImageToClipboard(makeOpts({ canvasEl: mountCanvas(false) })),
        ).rejects.toThrow('Canvas viewport not found');
    });
});

describe('exportCanvasAsPdf', () => {
    const realFetch = global.fetch;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;

    beforeEach(() => {
        URL.createObjectURL = jest.fn().mockReturnValue('blob:fake');
        URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        jest.useFakeTimers();
    });

    afterEach(() => {
        global.fetch = realFetch;
        URL.createObjectURL = realCreate;
        URL.revokeObjectURL = realRevoke;
        jest.useRealTimers();
    });

    function serverOpts() {
        return { ...makeOpts(), tenantSlug: 'acme', mapId: 'map-1' };
    }

    it('POSTs the PNG, downloads the returned PDF blob, and revokes the URL', async () => {
        const blob = new Blob(['pdf'], { type: 'application/pdf' });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            blob: jest.fn().mockResolvedValue(blob),
        }) as unknown as typeof fetch;

        await exportCanvasAsPdf(serverOpts());

        expect(global.fetch).toHaveBeenCalledWith(
            '/api/t/acme/processes/map-1/export-pdf',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
        jest.runAllTimers();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    });

    it('throws when the server responds non-ok', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
        }) as unknown as typeof fetch;

        await expect(exportCanvasAsPdf(serverOpts())).rejects.toThrow(
            'PDF export failed (500)',
        );
    });

    it('throws when the viewport is missing', async () => {
        await expect(
            exportCanvasAsPdf({ ...serverOpts(), canvasEl: mountCanvas(false) }),
        ).rejects.toThrow('Canvas viewport not found');
    });
});

describe('attachCanvasPngToEvidence', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    function serverOpts() {
        return { ...makeOpts(), tenantSlug: 'acme', mapId: 'map-1' };
    }

    it('uploads the PNG and returns the evidence id (from `id`)', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ id: 'ev-123' }),
        }) as unknown as typeof fetch;

        const result = await attachCanvasPngToEvidence(serverOpts());
        expect(result).toEqual({ evidenceId: 'ev-123' });
        expect(global.fetch).toHaveBeenCalledWith(
            '/api/t/acme/evidence/uploads',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('falls back to `evidenceId` then empty string', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ evidenceId: 'ev-fallback' }),
        }) as unknown as typeof fetch;

        const result = await attachCanvasPngToEvidence(serverOpts());
        expect(result).toEqual({ evidenceId: 'ev-fallback' });
    });

    it('throws when the upload responds non-ok', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 413,
        }) as unknown as typeof fetch;

        await expect(attachCanvasPngToEvidence(serverOpts())).rejects.toThrow(
            'Evidence upload failed (413)',
        );
    });

    it('throws when the viewport is missing', async () => {
        await expect(
            attachCanvasPngToEvidence({ ...serverOpts(), canvasEl: mountCanvas(false) }),
        ).rejects.toThrow('Canvas viewport not found');
    });
});
