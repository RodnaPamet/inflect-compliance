/**
 * @jest-environment jsdom
 *
 * Canvas export on tldraw — what reaches the engine, and what comes back.
 *
 * ── What this can and cannot cover ───────────────────────────────────
 *
 * The PNG path ends in a `<canvas>` composite, and this repo has neither
 * `canvas` nor `jest-canvas-mock`, so jsdom has no 2D context. That half is
 * therefore NOT covered here and the module isolates it behind `compositeImpl`
 * for exactly that reason. What is asserted is the decision rather than the
 * drawing: that the composite is invoked, and with WHICH colour.
 *
 * The SVG path has no such gap — `getSvgString` returns a string, so the
 * background injection is fully checkable.
 *
 * This mirrors how `tests/unit/canvas-export.test.ts` already tests the xyflow
 * path: mock the rasteriser, assert the option that reached it. The editor is a
 * plain object here, which is cheaper than the 36s a mounted-editor suite costs.
 */
import {
    EmptyCanvasExportError,
    copyTldrawCanvasToClipboard,
    exportTldrawCanvasAsPng,
    exportTldrawCanvasAsSvg,
    injectBackgroundRect,
} from '@/lib/processes/tldraw-canvas-export';

const DARK = '#0A2138';
const LIGHT = '#FBFAF8';

/**
 * The export options each tldraw entrypoint receives. Declared so the mocks
 * below carry PARAMETERS — `jest.fn(() => x)` types `mock.calls` as the empty
 * tuple, and every `calls[0]![1]` assertion then fails to compile even though
 * the test passes at runtime.
 */
interface SvgOpts {
    background?: boolean;
    padding?: number;
}
interface ImageOpts extends SvgOpts {
    format?: string;
    pixelRatio?: number;
}

/** A stand-in editor. Only the three methods the module touches exist. */
function fakeEditor(opts: {
    shapes?: unknown[];
    svg?: string | undefined;
} = {}) {
    const shapes = opts.shapes ?? [{ id: 'shape:a' }, { id: 'shape:b' }];
    return {
        getCurrentPageShapes: jest.fn((): unknown[] => shapes),
        getSvgString: jest.fn(async (_shapes: unknown[], _opts?: SvgOpts) =>
            'svg' in opts && opts.svg === undefined
                ? undefined
                : { svg: opts.svg ?? '<svg viewBox="0 0 10 10"><g id="shapes"/></svg>', width: 10, height: 10 },
        ),
        toImage: jest.fn(async (_shapes: unknown[], _opts?: ImageOpts) => ({
            blob: new Blob(['raw-png-bytes'], { type: 'image/png' }),
            width: 10,
            height: 10,
        })),
        // Present so a regression that reaches for the whole store is visible
        // as a CALL rather than as a wrong number.
        store: { allRecords: jest.fn(() => { throw new Error('the export must not read the whole store'); }) },
    };
}

/** A composite seam that records what it was asked to do. */
function recordingComposite() {
    const calls: Array<{ blob: Blob; background: string }> = [];
    // The exact instance handed back, so a caller can assert the Blob reached
    // its destination UNTOUCHED rather than re-encoded.
    const out = new Blob(['composited'], { type: 'image/png' });
    const impl = jest.fn(async (blob: Blob, background: string) => {
        calls.push({ blob, background });
        return out;
    });
    return { impl, calls, out };
}

function setTheme(theme: string | null) {
    if (theme === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
}

beforeEach(() => {
    setTheme(null);
    jest.restoreAllMocks();
    // `downloadDataUrl` clicks an <a download>; jsdom has no navigation, so
    // every export would log "Not implemented: navigation". Stubbed by
    // default — the one test that cares about the filename re-spies on it.
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('injectBackgroundRect — the whole of the SVG background fix', () => {
    it('inserts the rect as the FIRST child, so it paints behind everything', () => {
        const out = injectBackgroundRect('<svg viewBox="0 0 10 10"><g id="shapes"/></svg>', DARK);
        // Order is the point: after the shapes, it would cover them.
        expect(out.indexOf('<rect')).toBeLessThan(out.indexOf('<g id="shapes"'));
        expect(out).toContain(`fill="${DARK}"`);
    });

    it('keeps the original <svg> attributes intact', () => {
        const out = injectBackgroundRect('<svg viewBox="0 0 4 2" width="4">x</svg>', LIGHT);
        expect(out).toContain('viewBox="0 0 4 2"');
        expect(out).toContain('width="4"');
        expect(out).toContain('x</svg>');
    });

    it('covers the full area regardless of the viewBox', () => {
        const out = injectBackgroundRect('<svg viewBox="-500 -500 1000 1000"></svg>', DARK);
        expect(out).toMatch(/width="100%"\s+height="100%"/);
    });

    it('refuses a non-hex colour rather than writing it into an attribute', () => {
        expect(() => injectBackgroundRect('<svg></svg>', 'red; --x: y')).toThrow(/hex colour/);
    });

    it('refuses a document that is not an SVG', () => {
        expect(() => injectBackgroundRect('<html><body/></html>', DARK)).toThrow(/Not an SVG/);
    });

    it('refuses an unterminated <svg> tag', () => {
        expect(() => injectBackgroundRect('<svg viewBox="0 0 1 1"', DARK)).toThrow(/unterminated/);
    });
});

describe('SVG export', () => {
    it('asks tldraw NOT to draw a background, then supplies ours', async () => {
        // THE assertion for the whole port. `background` is a boolean in
        // tldraw, so leaving it true would silently restyle every export to
        // tldraw's own theme colour instead of the product token.
        const editor = fakeEditor();
        const url = await exportTldrawCanvasAsSvg({ editor: editor as never, mapName: 'Invoices' });

        expect(editor.getSvgString).toHaveBeenCalledTimes(1);
        expect(editor.getSvgString.mock.calls[0]![1]).toMatchObject({ background: false });
        expect(decodeURIComponent(url)).toContain(`fill="${DARK}"`);
    });

    it('reads the theme — light gives the light token', async () => {
        setTheme('light');
        const editor = fakeEditor();
        const url = await exportTldrawCanvasAsSvg({ editor: editor as never, mapName: 'm' });
        expect(decodeURIComponent(url)).toContain(`fill="${LIGHT}"`);
        expect(decodeURIComponent(url)).not.toContain(DARK);
    });

    it('and an ABSENT data-theme gives DARK, which is the product default', async () => {
        // Teeth for the test above: a resolver that always returned light
        // would satisfy it. The absent case is also the common one.
        setTheme(null);
        const editor = fakeEditor();
        const url = await exportTldrawCanvasAsSvg({ editor: editor as never, mapName: 'm' });
        expect(decodeURIComponent(url)).toContain(`fill="${DARK}"`);
    });

    it('exports the CURRENT PAGE, never the whole store', async () => {
        // A process map is one page. `store.allRecords()` throws in the fake,
        // so reaching for it fails loudly rather than exporting shapes the
        // user cannot see — the same hazard editor-canvas guards on save.
        const editor = fakeEditor();
        await exportTldrawCanvasAsSvg({ editor: editor as never, mapName: 'm' });
        expect(editor.getCurrentPageShapes).toHaveBeenCalled();
        expect(editor.store.allRecords).not.toHaveBeenCalled();
        expect(editor.getSvgString.mock.calls[0]![0]).toHaveLength(2);
    });

    it('refuses an empty page instead of downloading a blank file', async () => {
        const editor = fakeEditor({ shapes: [] });
        await expect(
            exportTldrawCanvasAsSvg({ editor: editor as never, mapName: 'm' }),
        ).rejects.toThrow(EmptyCanvasExportError);
        expect(editor.getSvgString).not.toHaveBeenCalled();
    });

    it('refuses when getSvgString returns undefined — its declared empty case', async () => {
        // `getSvgString` is typed `| undefined`. Without this the module would
        // interpolate "undefined" into a data URL and download it.
        const editor = fakeEditor({ svg: undefined });
        await expect(
            exportTldrawCanvasAsSvg({ editor: editor as never, mapName: 'm' }),
        ).rejects.toThrow(EmptyCanvasExportError);
    });

    it('names the file from the map, sanitised', async () => {
        const clicked: string[] = [];
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement,
        ) {
            clicked.push(this.download);
        });
        const editor = fakeEditor();
        await exportTldrawCanvasAsSvg({
            editor: editor as never,
            mapName: 'Accounts / Payable **2026**',
        });
        expect(clicked).toEqual(['accounts-payable-2026.svg']);
    });
});

describe('PNG export', () => {
    it('asks for png with no background, and composites OUR colour', async () => {
        const { impl, calls } = recordingComposite();
        const editor = fakeEditor();
        await exportTldrawCanvasAsPng({
            editor: editor as never,
            mapName: 'm',
            compositeImpl: impl,
        });

        expect(editor.toImage.mock.calls[0]![1]).toMatchObject({
            format: 'png',
            background: false,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.background).toBe(DARK);
    });

    it('passes the theme colour through to the composite, not a fixed one', async () => {
        setTheme('light');
        const { impl, calls } = recordingComposite();
        const editor = fakeEditor();
        await exportTldrawCanvasAsPng({
            editor: editor as never,
            mapName: 'm',
            compositeImpl: impl,
        });
        expect(calls[0]!.background).toBe(LIGHT);
    });

    it('omits pixelRatio entirely when not given, keeping tldraw’s own default', async () => {
        // `JSON.stringify` drops undefined but an explicit `pixelRatio:
        // undefined` would still override a default in a `??` chain, so the
        // module spreads it conditionally. Asserted on the KEY, not the value.
        const { impl } = recordingComposite();
        const editor = fakeEditor();
        await exportTldrawCanvasAsPng({ editor: editor as never, mapName: 'm', compositeImpl: impl });
        expect(Object.keys(editor.toImage.mock.calls[0]![1] ?? {})).not.toContain('pixelRatio');
    });

    it('forwards pixelRatio when it IS given', async () => {
        const { impl } = recordingComposite();
        const editor = fakeEditor();
        await exportTldrawCanvasAsPng({
            editor: editor as never,
            mapName: 'm',
            pixelRatio: 3,
            compositeImpl: impl,
        });
        expect(editor.toImage.mock.calls[0]![1]).toMatchObject({ pixelRatio: 3 });
    });

    it('returns a png data URL built from the COMPOSITED bytes', async () => {
        const { impl } = recordingComposite();
        const editor = fakeEditor();
        const url = await exportTldrawCanvasAsPng({
            editor: editor as never,
            mapName: 'm',
            compositeImpl: impl,
        });
        expect(url.startsWith('data:image/png')).toBe(true);
        // "composited", base64 — proves the returned URL is not the raw blob
        // that went INTO the composite.
        expect(atob(url.split(',')[1]!)).toBe('composited');
    });

    it('refuses an empty page before calling toImage', async () => {
        const { impl } = recordingComposite();
        const editor = fakeEditor({ shapes: [] });
        await expect(
            exportTldrawCanvasAsPng({ editor: editor as never, mapName: 'm', compositeImpl: impl }),
        ).rejects.toThrow(EmptyCanvasExportError);
        expect(editor.toImage).not.toHaveBeenCalled();
    });
});

describe('clipboard', () => {
    const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

    afterEach(() => {
        (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem;
    });

    function installClipboard() {
        const written: Array<Record<string, Blob>> = [];
        class FakeClipboardItem {
            constructor(public readonly items: Record<string, Blob>) {}
        }
        (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                write: jest.fn(async (items: FakeClipboardItem[]) => {
                    written.push(items[0]!.items);
                }),
            },
        });
        return written;
    }

    it('writes the composited Blob directly — no data-URL round trip', async () => {
        // The xyflow path had to atob a base64 data URL back into a Blob
        // because `toPng` only returns a string. `toImage` returns the Blob
        // `ClipboardItem` wants, so that decode step should be GONE.
        const written = installClipboard();
        const { impl, out } = recordingComposite();
        const editor = fakeEditor();
        await copyTldrawCanvasToClipboard({
            editor: editor as never,
            mapName: 'm',
            compositeImpl: impl,
        });
        expect(written).toHaveLength(1);
        // Identity, not contents: the SAME Blob instance the composite
        // returned is what reached the clipboard. A data-URL round trip would
        // produce an equal-but-different Blob, so this is the assertion that
        // actually forbids the decode step.
        expect(written[0]!['image/png']).toBe(out);
    });

    it('throws a human-readable error when ClipboardItem is missing', async () => {
        installClipboard();
        delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
        const { impl } = recordingComposite();
        await expect(
            copyTldrawCanvasToClipboard({
                editor: fakeEditor() as never,
                mapName: 'm',
                compositeImpl: impl,
            }),
        ).rejects.toThrow(/doesn't support copying images/);
    });

    it('does not reach the editor at all when the clipboard is unavailable', async () => {
        // The feature check is FIRST, so an unsupported browser costs no
        // render. Ordering, asserted rather than assumed.
        installClipboard();
        delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
        const editor = fakeEditor();
        const { impl } = recordingComposite();
        await expect(
            copyTldrawCanvasToClipboard({ editor: editor as never, mapName: 'm', compositeImpl: impl }),
        ).rejects.toThrow();
        expect(editor.toImage).not.toHaveBeenCalled();
    });
});
