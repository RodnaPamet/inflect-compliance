/**
 * Canvas-export helpers that do not know which engine drew the canvas.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * `canvas-export.ts` is the xyflow export path and `tldraw-canvas-export.ts`
 * is the tldraw one. Three of its helpers are not about either engine — a
 * filename, a download, and which background colour the current theme wants —
 * and duplicating them into the second path would mean two answers to
 * "what colour is an exported map", which is exactly the kind of drift a
 * migration leaves behind.
 *
 * So they were MOVED here rather than copied. Nothing in this file is new
 * behaviour: `canvas-export.ts` imports the same functions it used to
 * declare, and its tests did not change.
 */

/**
 * Export background, per theme. These are the `--bg-canvas-frame` token
 * values rather than an arbitrary pair, so an exported image matches the
 * canvas the user was looking at.
 */
export const EXPORT_BG_LIGHT = '#FBFAF8';
export const EXPORT_BG_DARK = '#0A2138';

/** Padding, in page units, around the exported content. */
export const EXPORT_PADDING = 24;

/**
 * Trigger a browser download for a data URL.
 *
 * Engine-agnostic: an `<a download>` click does not care what produced the
 * bytes.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/**
 * A map name, reduced to something a filesystem will accept.
 *
 * Falls back to `process-map` when the name reduces to nothing — a map
 * called `"***"` would otherwise produce a file called `.png`, which is
 * hidden on unix and rejected on Windows.
 */
export function safeFilename(mapName: string, ext: string): string {
    const stem =
        mapName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'process-map';
    return `${stem}.${ext}`;
}

/**
 * The background colour the current theme wants behind an exported map.
 *
 * Note the fallback is DARK, not light: `data-theme` is absent when the user
 * has made no explicit choice, and this product's default is dark. Reading
 * the attribute and defaulting the other way would make the common case the
 * wrong one.
 *
 * Returns the light token when `document` is undefined (SSR, and some test
 * environments) because there is no theme to read and a deterministic answer
 * beats throwing from an export helper.
 */
export function resolveBackground(): string {
    if (typeof document === 'undefined') return EXPORT_BG_LIGHT;
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    if (theme === 'light') return EXPORT_BG_LIGHT;
    return EXPORT_BG_DARK;
}

/**
 * A `Blob` as a data URL.
 *
 * tldraw's `editor.toImage()` returns a `Blob`; every downstream consumer in
 * this repo — the download anchor, the PDF route, the Evidence attachment —
 * takes a data URL, because the xyflow path produced one. Converting at this
 * boundary keeps those four contracts unchanged.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === 'string') resolve(reader.result);
            else reject(new Error('Could not read the exported image'));
        };
        reader.onerror = () =>
            reject(reader.error ?? new Error('Could not read the exported image'));
        reader.readAsDataURL(blob);
    });
}
