/**
 * @jest-environment jsdom
 *
 * The node palette collapses on a phone — on THIS canvas too.
 *
 * ═══ THE GAP ═══
 *
 * `globals.css` carries a `@media (max-width: 767px)` rule that turns the
 * palette from a vertical sidebar into a horizontal scrolling strip:
 *
 *   [data-process-canvas="true"][data-mobile-layout="true"]
 *     [data-process-palette="true"] { flex-direction: row; … }
 *
 * The xyflow canvas emitted both attributes. `TldrawProcessCanvas` emitted
 * `data-tldraw-process-canvas` — a different name — and no
 * `data-mobile-layout` at all, so the rule matched nothing and the palette
 * kept a sidebar's width on a 767px screen.
 *
 * Found by deleting the xyflow canvas (#3079): `p6b-touch-mobile` asserted
 * the attributes on a file that no longer exists, and the capability had no
 * home to re-point to. Unlike the other gaps the deletion surfaced, this one
 * has no "zero rows" argument — it is every phone user.
 *
 * ═══ WHY THE ASSERTIONS ARE ON ATTRIBUTES, NOT ON LAYOUT ═══
 *
 * jsdom applies no stylesheet and computes no layout, so there is nothing to
 * measure. The attributes ARE the contract between the component and the
 * stylesheet.
 *
 * The stylesheet's half of that contract is deliberately NOT asserted here.
 * `p6b-touch-mobile` already pins the selector and its `flex-direction: row`,
 * and it is one of the files Class A of the raw-source ratchet permits to read
 * unmasked source — a second reader here is both redundant and a ratchet
 * breach, which is how I found out. Two guards reading one file is also how a
 * contract ends up asserted in a place nobody looks when it moves.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

/** What `useMediaQuery` reads. Set before each mount. */
let matches = false;
jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({ isMobile: matches, isTablet: false, isDesktop: !matches }),
}));

const ROWS: GraphRows = { nodes: [], edges: [] };

async function mount(isMobile: boolean) {
    matches = isMobile;
    let container: HTMLElement | undefined;
    await act(async () => {
        const r = render(
            <div style={{ width: 800, height: 600 }}>
                <TldrawProcessCanvas rows={ROWS} />
            </div>,
        );
        container = r.container;
    });
    return container!.querySelector('[data-process-canvas]') as HTMLElement | null;
}

describe('the canvas carries what the mobile rule selects on', () => {
    it('emits the renderer-agnostic data-process-canvas', async () => {
        // THE assertion that was missing. The host had only its own
        // tldraw-specific marker, which the shared stylesheet does not know.
        const el = await mount(false);
        expect(el).not.toBeNull();
        expect(el!.getAttribute('data-process-canvas')).toBe('true');
    });

    it('and keeps its own marker, which the drop-target test resolves by', async () => {
        // Teeth against "fixing" this by renaming rather than adding.
        const el = await mount(false);
        expect(el!.getAttribute('data-tldraw-process-canvas')).toBe('true');
    });

    it('sets data-mobile-layout="true" on a phone', async () => {
        const el = await mount(true);
        expect(el!.getAttribute('data-mobile-layout')).toBe('true');
    });

    it('and omits it entirely on a desktop, rather than saying "false"', async () => {
        // The CSS matches `[data-mobile-layout="true"]`, so "false" would be
        // inert — but the two hosts emitting different shapes for one state is
        // how a later selector change breaks only one of them. The xyflow
        // canvas emitted `undefined`; this matches.
        const el = await mount(false);
        expect(el!.hasAttribute('data-mobile-layout')).toBe(false);
    });
});
