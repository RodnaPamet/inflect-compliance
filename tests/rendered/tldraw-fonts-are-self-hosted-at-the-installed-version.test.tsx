/**
 * tldraw's fonts come from our own origin, and from files of the tldraw version
 * that is installed (#5870; owner decision 2026-11-24).
 *
 * tldraw 3.x loads 16 font files from `https://cdn.tldraw.com/<version>/fonts/…`
 * by default. Our CSP `font-src` refuses that origin, and the decision was to
 * self-host the files rather than widen it. Two things can quietly undo that:
 *
 *   1. A tldraw upgrade. The vendored folder is per version and the files are
 *      tldraw's own, so after `npm install tldraw@<next>` the canvases would
 *      ask our origin for files of the OLD version. Every check in the first
 *      block fails until the fonts are refreshed (the steps are in
 *      `docs/implementation-notes/2026-11-24-tldraw-self-hosted-fonts.md`).
 *   2. A canvas mount without `assetUrls`. The second block mounts each of
 *      the three canvases on a live editor and asks the editor to load every
 *      default font face, then reads the source of every `FontFace` it built.
 *
 * jsdom loads nothing, so this proves which URL tldraw WOULD fetch, not that
 * the browser fetched it; the real-app check is in the PR.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as React from 'react';

import { act, render } from '@testing-library/react';
import { allDefaultFontFaces, defaultEditorAssetUrls, type Editor } from 'tldraw';

import { AgentFlowCanvas } from '@/components/processes/agent-flow/AgentFlowCanvas';
import { AgentCanvasView } from '@/components/processes/agent-view/AgentCanvasView';
import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { TLDRAW_ASSET_URLS, TLDRAW_VENDORED_VERSION } from '@/components/processes/tldraw/asset-urls';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';

const REPO = path.resolve(__dirname, '..', '..');
const VENDOR_ROOT = path.join(REPO, 'public', 'vendor', 'tldraw');

/** The version of the tldraw package that `node_modules` actually holds. */
function installedTldrawVersion(): string {
    // `tldraw` does not export its package.json; walk up from its entry point.
    const pkgDir = path.resolve(path.dirname(require.resolve('tldraw')), '..');
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
}

const TLDRAW_DEFAULT_FONTS = defaultEditorAssetUrls.fonts as Record<string, string>;
const OUR_FONTS: Record<string, string> = TLDRAW_ASSET_URLS.fonts;

describe('the vendored tldraw fonts are the installed version', () => {
    it('the vendored version is the installed tldraw version', () => {
        expect(TLDRAW_VENDORED_VERSION).toBe(installedTldrawVersion());
    });

    it('tldraw requests its fonts for exactly the vendored version', () => {
        const prefix = `https://cdn.tldraw.com/${TLDRAW_VENDORED_VERSION}/fonts/`;
        for (const url of Object.values(TLDRAW_DEFAULT_FONTS)) {
            expect(url.startsWith(prefix)).toBe(true);
        }
    });

    it('the vendor folder holds that one version and no stale one', () => {
        expect(fs.readdirSync(VENDOR_ROOT)).toEqual([TLDRAW_VENDORED_VERSION]);
    });

    it('every font tldraw would request maps to a file of the same name that exists', () => {
        expect(Object.keys(OUR_FONTS).sort()).toEqual(Object.keys(TLDRAW_DEFAULT_FONTS).sort());
        for (const [key, cdnUrl] of Object.entries(TLDRAW_DEFAULT_FONTS)) {
            const ours = OUR_FONTS[key];
            expect(ours).toBe(`/vendor/tldraw/${TLDRAW_VENDORED_VERSION}/fonts/${path.posix.basename(cdnUrl)}`);
            const onDisk = path.join(REPO, 'public', ...ours.split('/').filter(Boolean));
            expect(fs.statSync(onDisk).size).toBeGreaterThan(0);
        }
    });

    it('every font face tldraw declares resolves through the map', () => {
        for (const face of allDefaultFontFaces) {
            expect(OUR_FONTS[face.src.url]).toBeDefined();
        }
    });

    it('the fonts ship with their licences', () => {
        const dir = path.join(VENDOR_ROOT, TLDRAW_VENDORED_VERSION, 'fonts');
        for (const licence of ['IBM-Plex-OFL.txt', 'Shantell-Sans-OFL.txt']) {
            // The licence's own title line, exactly, not a phrase anywhere in the file.
            const lines = fs.readFileSync(path.join(dir, licence), 'utf8').split('\n').map((l) => l.trim());
            expect(lines).toContainEqual('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
        }
    });
});

// ── Every mount hands those URLs to its editor ─────────────────────────────

/** The source string of every FontFace an editor builds. */
const fontSources: string[] = [];
const ShimFontFace = (globalThis as unknown as { FontFace: new (...a: unknown[]) => object }).FontFace;
(globalThis as unknown as { FontFace: unknown }).FontFace = class RecordingFontFace extends ShimFontFace {
    constructor(family: unknown, source: unknown, descriptors?: unknown) {
        super(family, source, descriptors);
        fontSources.push(String(source));
    }
};

/**
 * Every FontFace source the editor built since its mount began. tldraw keeps a
 * font's load state per editor and may build some faces while mounting, so the
 * record is cleared before the mount (`mountWith`), not here.
 */
async function loadEveryDefaultFont(editor: Editor): Promise<string[]> {
    await act(async () => {
        await Promise.all(allDefaultFontFaces.map((face) => editor.fonts.ensureFontIsLoaded(face)));
    });
    return [...fontSources];
}

function expectSelfHosted(sources: string[]) {
    const ours = new Set(Object.values(OUR_FONTS).map((u) => `url(${JSON.stringify(u)})`));
    expect(sources.length).toBeGreaterThanOrEqual(allDefaultFontFaces.length);
    // Nothing but our own same-origin files — a cdn.tldraw.com source lands here.
    expect(sources.filter((s) => !ours.has(s))).toEqual([]);
    // And every one of them, so no face was left to tldraw's default.
    expect(new Set(sources)).toEqual(ours);
}

async function mountWith(node: (ready: (e: Editor) => void) => React.ReactElement): Promise<Editor> {
    let editor: Editor | undefined;
    fontSources.length = 0;
    await act(async () => {
        render(<div style={{ width: 800, height: 600 }}>{node((e) => (editor = e))}</div>);
    });
    if (!editor) throw new Error('the canvas did not finish mounting');
    return editor;
}

const ROWS: GraphRows = {
    nodes: [
        {
            nodeKey: 'n1', nodeType: 'processStep', label: 'Receive',
            subtitle: null, posX: 0, posY: 0, parentNodeKey: null, dataJson: null,
        },
    ],
    edges: [],
};

const PROJECTION: AgentCanvasProjection = {
    agent: { id: 'a1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW', effectiveCeiling: 2 },
    envelope: {
        grants: [{ name: 'get_compliance_posture', capability: 'read', requiredAutonomy: 1, withinCeiling: true }],
        policyCardVersion: null,
        breakerState: null,
        killScope: null,
    },
    profile: { state: 'NONE' },
    workflows: [],
    usedIn: [],
};

describe('every tldraw mount loads its fonts from our origin', () => {
    it('the process canvas', async () => {
        const editor = await mountWith((ready) => <TldrawProcessCanvas rows={ROWS} onEditorReady={ready} />);
        expectSelfHosted(await loadEveryDefaultFont(editor));
    });

    it('the agent view', async () => {
        const editor = await mountWith((ready) => (
            <AgentCanvasView projection={PROJECTION} diff={null} onEditorReady={ready} />
        ));
        expectSelfHosted(await loadEveryDefaultFont(editor));
    });

    it('the agent-flow canvas', async () => {
        const editor = await mountWith((ready) => (
            <AgentFlowCanvas
                nodes={[{ key: 'read-1', kind: 'read', label: 'Read', detail: 'x', problems: [], change: '' }]}
                edges={[]}
                layout={{ 'read-1': { x: 0, y: 0 } }}
                onEditorReady={ready}
            />
        ));
        expectSelfHosted(await loadEveryDefaultFont(editor));
    });
});
