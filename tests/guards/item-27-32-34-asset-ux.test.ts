/**
 * Items 27 / 32 / 34 — asset list interaction ratchets.
 *
 * 34 — the asset table has a derived Criticality column.
 * 32 — three-way interaction: single-click TITLE → quick-look panel;
 *      single-click ROW → select (action row); double-click ROW → full
 *      detail page. The panel carries a "Full view" button too.
 * 27 — ↑/↓ move the panel selection between assets while it's open.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT = 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx';
const PANEL = 'src/app/t/[tenantSlug]/(app)/assets/AssetDetailPanel.tsx';

describe('item 34 — asset Criticality column', () => {
    const src = read(CLIENT);
    it('declares a criticality column derived from C/I/A', () => {
        expect(src).toMatch(/id:\s*'criticality'/);
        expect(src).toContain('getAssetCriticality(');
    });
});

describe('item 32 — three-way asset interaction (title / row / double-click)', () => {
    const src = read(CLIENT);
    it('single-click on the TITLE opens the quick-look panel (title is a <button>)', () => {
        // A <button> so isClickOnInteractiveChild() skips the row's
        // select/navigate handlers — title clicks only open the panel.
        expect(src).toMatch(/<button[\s\S]{0,200}setSelectedAssetId\(row\.original\.id\)/);
        expect(src).toMatch(/data-testid=\{`asset-title-\$\{row\.original\.id\}`\}/);
    });
    it('single-click ROW selects (selectionEnabled on → action row replaces headers)', () => {
        // selectionEnabled on means single-click toggles the row's
        // selection (the SelectionToolbar appears); a regression back to
        // `selectionEnabled={false}` would make single-click navigate.
        expect(src).toContain('selectionEnabled');
        expect(src).not.toContain('selectionEnabled={false}');
    });
    it('double-click ROW opens the full detail page (onRowClick → navigate)', () => {
        // With selection on, onRowClick fires on DOUBLE click.
        //
        // This asserts the BEHAVIOUR (row action navigates to the asset
        // detail route), not the syntax. It used to pin the inline-arrow
        // form `onRowClick={(row) => router.push(...)}` — which made the
        // anti-pattern a REQUIREMENT: an inline arrow is a fresh identity
        // every render, so it rebuilds the table model between the two
        // clicks of a double-click and the gesture never completes. See
        // `datatable-stable-row-identity.test.ts`.
        expect(src).toMatch(/onRowClick=\{handleAssetRowClick\}/);
        expect(src).toMatch(
            /const handleAssetRowClick = useCallback\([\s\S]{0,200}router\.push\(tenantHref\(`\/assets\/\$\{row\.original\.id\}`\)\)/,
        );
        // The old single-click-opens-panel onRowClick is gone.
        expect(src).not.toContain('onRowClick={(row) => setSelectedAssetId(row.original.id)}');
    });
    it('opens the quick-look in a docked right-rail AsidePanel (like Controls/Tasks), not a modal Sheet', () => {
        // The rail is the `<AsidePanel>` primitive fed into the
        // ListPageShell.Body `aside` slot — a co-resident docked column
        // (Sheet only below xl), NOT a blocking overlay. A regression back to
        // the overlay `<Sheet>` would re-dim the page on a name click.
        expect(src).toContain('<AsidePanel');
        expect(src).toContain('<AssetDetailPanel');
        expect(src).toMatch(/<ListPageShell\.Body aside=\{assetQuickViewAside\}>/);
        expect(src).toMatch(/openOnMount/);
        // The overlay Sheet mount is gone.
        expect(src).not.toContain('<AssetDetailSheet');
    });
    it('the panel has a Full view button to the detail page', () => {
        const panel = read(PANEL);
        expect(panel).toContain('asset-panel-full-view');
        expect(panel).toMatch(/Full view/);
        expect(panel).toMatch(/\/assets\/\$\{asset\.id\}/);
    });
    it('asset name tints brand-color only on hover of the NAME (tintOn="self"), like controls', () => {
        // The asset name is its own <button>; tintOn="self" makes the brand-tone
        // hover fire only when the name is hovered (`hover:`), NOT on whole-row
        // hover — matching the controls table. (The component keeps the default
        // `group-hover/row:` mode for other no-href consumers.)
        const client = read('src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx');
        expect(client).toMatch(/<TableTitleCell tintOn="self">/);
        const titleCell = read('src/components/ui/table-title-cell.tsx');
        // self mode reuses the Link self-hover class; row mode still exists.
        expect(titleCell).toMatch(/tintOn === 'self' \? TITLE_CELL_LINK_HOVER : TITLE_CELL_ROW_HOVER/);
        expect(titleCell).toMatch(/group-hover\/row:text-\[var\(--brand-default\)\]/);
    });
    it('the title quick-look button hugs the NAME (inline-block), not the whole cell — cursor/hover scope matches Controls/Risks', () => {
        // Controls + Risks render the title as an INLINE <Link> whose
        // footprint is the text. The asset title is a quick-look <button>;
        // it must be `inline-block` (text-width), NOT the old full-cell
        // `block w-full` target — otherwise the pointer cursor AND the
        // brand-tint hover land anywhere in the cell instead of on the name.
        // Grab the className on the element carrying the asset-title
        // test id (the quick-look button).
        const m = src.match(
            /className="([^"]+)"\s*\n?\s*data-testid=\{`asset-title-/,
        );
        expect(m).not.toBeNull();
        const cls = m![1];
        expect(cls).toMatch(/inline-block/);
        // Hand cursor on the name — a <button> defaults to the arrow cursor,
        // unlike Risk's <Link>; cursor-pointer matches the Risk affordance.
        expect(cls).toMatch(/cursor-pointer/);
        // The old full-cell footprint is gone.
        expect(cls).not.toContain('block w-full');
        expect(cls).not.toMatch(/(^|\s)w-full(\s|$)/);
    });
});

describe('item 27 — arrow keys move between assets', () => {
    const src = read(CLIENT);
    it('registers ArrowDown / ArrowUp shortcuts gated on the open panel', () => {
        expect(src).toMatch(/useKeyboardShortcut\('ArrowDown'/);
        expect(src).toMatch(/useKeyboardShortcut\('ArrowUp'/);
        expect(src).toMatch(/enabled:\s*selectedAssetId != null/);
    });
});
