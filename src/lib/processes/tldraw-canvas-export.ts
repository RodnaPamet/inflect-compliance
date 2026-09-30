/**
 * Canvas export, on tldraw.
 *
 * ── What this replaces, and why it is not a swap ─────────────────────
 *
 * The xyflow path (`canvas-export.ts`) does three things to make an image:
 * finds the `.react-flow__viewport` DOM node, computes a fit-to-content
 * viewport with `getNodesBounds` + `getViewportForBounds`, then hands that
 * node to `html-to-image`. tldraw does all three itself — `editor.toImage()`
 * and `editor.getSvgString()` take shapes and return finished bytes — so
 * none of that machinery ports.
 *
 * What does NOT come for free is the background colour, and it is the one
 * user-visible difference:
 *
 *   `TLSvgExportOptions.background` is a **boolean**, not a colour. tldraw
 *   paints its own theme background when true. Ours is a product token
 *   (`#0A2138` / `#FBFAF8`) and the whole point of a migration is that the
 *   output does not change, so `background: false` is passed and our colour
 *   is applied here.
 *
 * That lands differently per format, which is why the two paths below are not
 * symmetrical:
 *
 *   - **SVG** is a string, so the background is a `<rect>` inserted into it.
 *     Deterministic, and testable without a browser.
 *   - **PNG** is a rasterised `Blob`, so applying a background means drawing
 *     it onto a canvas. That is real browser work and this repo has no
 *     `canvas` or `jest-canvas-mock`, so it sits behind `compositeImpl` — an
 *     injectable seam whose default does the drawing. The tests assert which
 *     COLOUR reaches the seam; the `drawImage` call itself is not covered, and
 *     saying so is more useful than pretending otherwise.
 *
 * ── Current page, not the whole store ────────────────────────────────
 *
 * `editor.getCurrentPageShapes()` is deliberate. `store.allRecords()` spans
 * pages, and a process map is one page — the same distinction
 * `serializeEditorCanvas` had to make so a shape parked on page two does not
 * become a saved node. An export has the same hazard: it would silently
 * include shapes the user cannot see on the map they are exporting.
 */
import type { Editor } from 'tldraw';

import {
    EXPORT_PADDING,
    blobToDataUrl,
    downloadDataUrl,
    resolveBackground,
    safeFilename,
} from '@/lib/processes/canvas-export-shared';

export interface TldrawCanvasExportOptions {
    /** The live editor. Its CURRENT PAGE is what gets exported. */
    editor: Editor;
    /** Map name — the download filename stem. */
    mapName: string;
    /**
     * Pixel ratio for the PNG raster. tldraw defaults bitmap exports to 2;
     * left undefined to keep that default rather than restating it.
     */
    pixelRatio?: number;
    /**
     * Seam for the PNG background composite. Defaults to the real
     * canvas-backed implementation; tests pass a stub so they can assert the
     * colour without needing a 2D context.
     */
    compositeImpl?: (blob: Blob, background: string) => Promise<Blob>;
}

/** A map with nothing on it cannot be exported to an image. */
export class EmptyCanvasExportError extends Error {
    constructor() {
        super('There is nothing on this canvas to export.');
        this.name = 'EmptyCanvasExportError';
    }
}

/**
 * Insert a full-bleed background rect as the first child of an SVG.
 *
 * Kept separate and exported because it is the whole of the SVG background
 * fix, and it is the half that can be tested exactly.
 */
export function injectBackgroundRect(svg: string, background: string): string {
    // Our own tokens are the only callers, but validating keeps a future
    // caller from putting arbitrary text inside an attribute.
    if (!/^#[0-9a-fA-F]{3,8}$/.test(background)) {
        throw new Error(`Not a hex colour: ${background}`);
    }
    const svgAt = svg.indexOf('<svg');
    if (svgAt === -1) throw new Error('Not an SVG document');
    const openTagEnd = svg.indexOf('>', svgAt);
    if (openTagEnd === -1) throw new Error('Malformed SVG: unterminated <svg> tag');

    const rect = `<rect x="0" y="0" width="100%" height="100%" fill="${background}"/>`;
    return svg.slice(0, openTagEnd + 1) + rect + svg.slice(openTagEnd + 1);
}

/**
 * Draw a transparent PNG onto an opaque background.
 *
 * The uncovered five lines this file's header refers to. Isolated so the
 * decision (which colour) is testable even though the drawing is not.
 */
async function compositeOntoBackground(blob: Blob, background: string): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D context for the export');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (out) => (out ? resolve(out) : reject(new Error('Could not encode the export'))),
            'image/png',
        );
    });
}

/** The current page's shapes, or the empty-canvas error. */
function shapesToExport(editor: Editor) {
    const shapes = editor.getCurrentPageShapes();
    if (shapes.length === 0) throw new EmptyCanvasExportError();
    return shapes;
}

/**
 * Export the current page as an SVG. Downloads as a side-effect and returns
 * the data URL, matching `exportCanvasAsSvg`'s contract.
 */
export async function exportTldrawCanvasAsSvg(
    opts: TldrawCanvasExportOptions,
): Promise<string> {
    const shapes = shapesToExport(opts.editor);
    const result = await opts.editor.getSvgString(shapes, {
        background: false,
        padding: EXPORT_PADDING,
    });
    // `getSvgString` is declared `| undefined` — an export that produced
    // nothing is not an empty string to hand to a download.
    if (!result) throw new EmptyCanvasExportError();

    const svg = injectBackgroundRect(result.svg, resolveBackground());
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    downloadDataUrl(dataUrl, safeFilename(opts.mapName, 'svg'));
    return dataUrl;
}

/**
 * Export the current page as a PNG. Downloads as a side-effect and returns
 * the data URL, matching `exportCanvasAsPng`'s contract.
 */
export async function exportTldrawCanvasAsPng(
    opts: TldrawCanvasExportOptions,
): Promise<string> {
    const blob = await rasterise(opts);
    const dataUrl = await blobToDataUrl(blob);
    downloadDataUrl(dataUrl, safeFilename(opts.mapName, 'png'));
    return dataUrl;
}

/**
 * Copy the current page to the clipboard as a PNG.
 *
 * Simpler than its xyflow counterpart, which had to decode a base64 data URL
 * back into a Blob because `toPng` only returns a string. `toImage` returns
 * the Blob `ClipboardItem` wants.
 */
export async function copyTldrawCanvasToClipboard(
    opts: TldrawCanvasExportOptions,
): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.write) {
        throw new Error("Your browser doesn't support copying images to the clipboard.");
    }
    if (typeof ClipboardItem === 'undefined') {
        throw new Error("Your browser doesn't support copying images to the clipboard.");
    }
    const blob = await rasterise(opts);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** PNG bytes with our background applied — shared by download and clipboard. */
async function rasterise(opts: TldrawCanvasExportOptions): Promise<Blob> {
    const shapes = shapesToExport(opts.editor);
    const { blob } = await opts.editor.toImage(shapes, {
        format: 'png',
        background: false,
        padding: EXPORT_PADDING,
        ...(opts.pixelRatio !== undefined ? { pixelRatio: opts.pixelRatio } : {}),
    });
    const composite = opts.compositeImpl ?? compositeOntoBackground;
    return composite(blob, resolveBackground());
}

// ─── Server-backed exports ─────────────────────────────────────────────
//
// Both of these are "produce a PNG, then POST it" — the rasterising half is
// engine-specific and the routes are not, so only the first half ports. The
// URLs, payload shapes and return contracts are the xyflow ones unchanged,
// because the server does not know or care which canvas drew the image.
//
// The Evidence path gets SIMPLER here, for the same reason the clipboard did:
// its xyflow counterpart has to `atob` a base64 data URL back into a Blob
// because `toPng` only returns a string. `toImage` already hands over the Blob
// that `File` wants, so the decode step disappears rather than being ported.

export interface TldrawCanvasServerExportOptions extends TldrawCanvasExportOptions {
    /** Tenant slug + map id for the server-side endpoints. */
    tenantSlug: string;
    mapId: string;
    /** Seam for tests. */
    fetchImpl?: typeof fetch;
}

/**
 * Render the current page server-side as a PDF and download it.
 *
 * The route takes the PNG and composes the document, so this sends a data URL
 * and downloads whatever comes back — it does not build the PDF itself.
 */
export async function exportTldrawCanvasAsPdf(
    opts: TldrawCanvasServerExportOptions,
): Promise<void> {
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    const pngDataUrl = await blobToDataUrl(await rasterise(opts));

    const res = await doFetch(
        `/api/t/${opts.tenantSlug}/processes/${opts.mapId}/export-pdf`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pngDataUrl }),
        },
    );
    if (!res.ok) throw new Error(`PDF export failed (${res.status})`);

    const blobUrl = URL.createObjectURL(await res.blob());
    try {
        downloadDataUrl(blobUrl, safeFilename(opts.mapName, 'pdf'));
    } finally {
        // Revoked on a delay, not immediately: the anchor click is
        // asynchronous in some browsers and revoking first cancels the
        // download. Same delay the xyflow path uses.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }
}

/**
 * Attach the current page to the tenant's Evidence library as a PNG.
 *
 * Auditors need a process map as an evidence artefact rather than as a
 * screenshot, which is what this exists for.
 */
export async function attachTldrawCanvasToEvidence(
    opts: TldrawCanvasServerExportOptions,
): Promise<{ evidenceId: string }> {
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    const blob = await rasterise(opts);
    const filename = safeFilename(opts.mapName, 'png');

    const form = new FormData();
    form.append('file', new File([blob], filename, { type: 'image/png' }));
    form.append('title', `${opts.mapName} — Process Map`);
    form.append('category', 'PROCESS_MAP');

    const res = await doFetch(`/api/t/${opts.tenantSlug}/evidence/uploads`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) throw new Error(`Evidence upload failed (${res.status})`);

    // The route has answered with both shapes over its life; accepting either
    // is the xyflow behaviour and not worth diverging from here.
    const body = (await res.json()) as { id?: string; evidenceId?: string };
    return { evidenceId: body.id ?? body.evidenceId ?? '' };
}
