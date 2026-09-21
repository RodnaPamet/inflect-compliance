/**
 * v2-PR-12 follow-through (2026-05-13) — trailing chevron-right
 * affordance on clickable DataTable rows.
 *
 * The original v2-PR-12 PR description claimed "chevron-right +
 * brand-coloured left border on hover". Only the brand-coloured
 * left edge actually shipped (#374); the chevron was missing —
 * `table.tsx:400` had a stale comment referencing a chevron-cell
 * that didn't exist. The roadmap audit on 2026-05-13 surfaced
 * this gap.
 *
 * The fix is symmetric with the leading SELECT column: when the
 * consumer passes `onRowClick`, the table appends a thin trailing
 * column whose cell renders `<ChevronRight>` at `opacity-0` →
 * `opacity-60` on `group-hover/row`. Decoration only —
 * `aria-hidden`, `pointer-events-none`, never sortable, never
 * hideable.
 *
 * This ratchet locks the four load-bearing pieces:
 *
 *   1. `CHEVRON_COLUMN_WIDTH` constant exists alongside the other
 *      column-width constants.
 *   2. `ChevronRight` is imported from the Nucleo icon family
 *      (NOT lucide — the table primitive stays inside the
 *      curated icon set).
 *   3. The chevron column has id `__row-chevron`, enableHiding +
 *      enableSorting are false, the cell is `aria-hidden` +
 *      `pointer-events-none`.
 *   4. The chevron column is gated on `props.onRowClick` — pages
 *      that don't wire `onRowClick` don't render the affordance.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const TABLE_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/ui/table/table.tsx'),
    'utf8',
));

describe('DataTable row chevron-right affordance (v2-PR-12 follow-through)', () => {
    it('declares CHEVRON_COLUMN_WIDTH constant', () => {
        expect(TABLE_SRC).toMatch(/CHEVRON_COLUMN_WIDTH\s*=\s*\d+/);
    });

    it('imports ChevronRight from the Nucleo icon family (not lucide)', () => {
        // The table primitive stays inside the curated Nucleo icon
        // set — lucide is allowlisted across the sidebar/topbar
        // chrome but DataTable consumers expect a stable icon
        // footprint.
        expect(TABLE_SRC).toMatch(
            /import\s*\{\s*ChevronRight\s*\}\s*from\s*['"]\.\.\/icons\/nucleo\/chevron-right['"]/,
        );
        expect(TABLE_SRC).not.toMatch(
            /import\s*\{[^}]*\bChevronRight\b[^}]*\}\s*from\s*['"]lucide-react['"]/,
        );
    });

    it('appends the chevron column when props.onRowClick is set', () => {
        // The column is gated on `props.onRowClick` so list pages
        // that don't wire click-to-navigate don't render the
        // affordance. Mirror shape of the leading selection
        // column (`...(selectionEnabled ? [...] : [])`).
        expect(TABLE_SRC).toMatch(
            /\.\.\.\(\s*props\.onRowClick\s*\?\s*\[/,
        );
    });

    it('chevron column has id `__row-chevron`', () => {
        expect(TABLE_SRC).toMatch(/id:\s*['"]__row-chevron['"]/);
    });

    it('chevron column is not sortable + not hideable', () => {
        // Match within a slice that starts at `id: "__row-chevron"`
        // and ends at the first `cell:` (after which the cell render
        // function begins). Both `enableHiding: false` +
        // `enableSorting: false` MUST appear in that slice.
        const idIdx = TABLE_SRC.indexOf("id: '__row-chevron'");
        const fallbackIdx =
            idIdx === -1 ? TABLE_SRC.indexOf('id: "__row-chevron"') : idIdx;
        expect(fallbackIdx).toBeGreaterThan(-1);
        const slice = TABLE_SRC.slice(fallbackIdx, fallbackIdx + 600);
        expect(slice).toMatch(/enableHiding:\s*false/);
        expect(slice).toMatch(/enableSorting:\s*false/);
    });

    it('chevron cell is aria-hidden + pointer-events-none (decoration only)', () => {
        // The chevron is purely visual — it does NOT intercept
        // clicks (so the row's onRowClick can fire when the user
        // clicks anywhere on the row including the chevron's
        // column), and it does NOT participate in screen-reader
        // navigation (the row's own labelling already conveys
        // "this is clickable" via the cursor-pointer + keyboard
        // interaction).
        const idIdx = TABLE_SRC.indexOf("id: '__row-chevron'");
        const fallbackIdx =
            idIdx === -1 ? TABLE_SRC.indexOf('id: "__row-chevron"') : idIdx;
        const slice = TABLE_SRC.slice(fallbackIdx, fallbackIdx + 1500);
        expect(slice).toMatch(/aria-hidden=['"]true['"]/);
        expect(slice).toMatch(/pointer-events-none/);
    });

    it('chevron fades in on `group-hover/row` (opacity 0 → 60)', () => {
        // `group/row` is the named group set on the <tr> by the
        // row renderer. The chevron cell consumes
        // `group-hover/row:opacity-60` to fade in only when its
        // own row is hovered — without the `/row` qualifier the
        // chevron would react to ANY group-hover state inside the
        // table chrome (e.g. column-header hover).
        const idIdx = TABLE_SRC.indexOf("id: '__row-chevron'");
        const fallbackIdx =
            idIdx === -1 ? TABLE_SRC.indexOf('id: "__row-chevron"') : idIdx;
        const slice = TABLE_SRC.slice(fallbackIdx, fallbackIdx + 1500);
        expect(slice).toMatch(/\bopacity-0\b/);
        expect(slice).toMatch(/group-hover\/row:opacity-60/);
        // Transition must be opacity-only — no compositor work,
        // no layout shift. R12 motion-language compliance.
        expect(slice).toMatch(/transition-opacity/);
    });

    it('uses Nucleo ChevronRight at 16×16 inside the cell', () => {
        const idIdx = TABLE_SRC.indexOf("id: '__row-chevron'");
        const fallbackIdx =
            idIdx === -1 ? TABLE_SRC.indexOf('id: "__row-chevron"') : idIdx;
        const slice = TABLE_SRC.slice(fallbackIdx, fallbackIdx + 1500);
        expect(slice).toMatch(
            /<ChevronRight\s+width=\{16\}\s+height=\{16\}\s*\/>/,
        );
    });
});
