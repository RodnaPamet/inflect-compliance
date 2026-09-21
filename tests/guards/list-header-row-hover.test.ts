/**
 * v2-PR-12 — List header trio + DataTable row hover ratchet.
 *
 * Two contracts in one PR (both list-page surface concerns):
 *
 *   1. EntityListPage exposes the eyebrow + title + description
 *      "trio" via its header config. The PageHeader primitive
 *      (v2-PR-5) already supports the slot; this PR threads it
 *      through the list-page shell so consumers can adopt the
 *      v2 polish copy convention (uppercase resource name above
 *      the title, narrative description below).
 *
 *   2. DataTable rows with `onRowClick` paint a brand-coloured
 *      left-border affordance on hover so clickable rows hint at
 *      navigation without a column header saying "Open". (`<tr>`
 *      elements don't render direct CSS borders — the inset
 *      box-shadow is the canonical workaround. The motion-language
 *      ratchet has table.tsx exempted with a written reason.)
 *
 * Pairs with:
 *   - src/components/layout/EntityListPage.tsx (header trio props)
 *   - src/components/layout/PageHeader.tsx (the eyebrow slot)
 *   - src/components/ui/table/table.tsx (the row hover affordance)
 *   - tests/guards/motion-language-discipline.test.ts (the
 *     box-shadow exemption for table.tsx)
 */
import * as fs from "fs";
import * as path from "path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");

describe("v2-PR-12 EntityListPage header trio", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/layout/EntityListPage.tsx"),
        "utf8",
    ));

    it("EntityListPageHeader declares both `eyebrow` and `description` slots", () => {
        // Both are optional (`?:`); `title` stays required.
        expect(src).toMatch(/\beyebrow\?:/);
        expect(src).toMatch(/\bdescription\?:/);
    });

    it("threads `eyebrow` into the PageHeader render", () => {
        expect(src).toMatch(/eyebrow=\{header\.eyebrow\}/);
    });

    it("`description` wins over `count` when both are passed", () => {
        // Migration-friendly fallback: pages that haven't migrated
        // to the new vocabulary keep their existing `count` line;
        // pages that have, drop into the new slot cleanly.
        expect(src).toMatch(/header\.description\s*\?\?\s*header\.count/);
    });
});

describe("v2-PR-12 DataTable row hover affordance", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/ui/table/table.tsx"),
        "utf8",
    ));

    it("renders a brand-coloured left-border on hover for clickable rows", () => {
        // R13-PR13 — the inset box-shadow recipe moved from the
        // row (`<tr>`) to the first non-utility cell. CSS table
        // painting paints cell backgrounds (`bg-bg-muted` on
        // hover) on top of any row-level shadow, so the
        // row-level approach flickered. The cell-level shadow
        // paints on the cell's own context and stays visible.
        //
        // R13-PR15 — `:first-of-type` was replaced by an explicit
        // `isFirstContent` boolean (computed at render time as
        // the first non-utility column id). `:first-of-type`
        // pointed at the select column once R12-PR1 made it
        // default-on, so the shadow rule never fired anywhere.
        // The brand-default token is the colour.
        expect(src).toMatch(
            /group-hover\/row:shadow-\[inset_2px_0_0_var\(--brand-default\)\]/,
        );
    });

    it("uses the v2-PR-4 motion language (transition-colors duration-150)", () => {
        // The hover affordance sits on the same motion as every
        // other clickable surface — bg/border colour transitions
        // only, no transform. After R13-PR13 the row no longer
        // owns the shadow itself, but it still owns the
        // cursor-pointer + colour-transition affordance that
        // anchors the motion language.
        //
        // R13-PR14 widened the gate from `onRowClick &&` to
        // `(onRowClick || selectionEnabled) &&` because
        // selection-enabled rows are interactive (single click
        // toggles selection). Match either form.
        const rowBlock = src.match(
            /(?:onRowClick\s*&&|\(\s*onRowClick\s*\|\|\s*selectionEnabled\s*\)\s*&&)\s*\n?\s*"[^"]*cursor-pointer\s+select-none[^"]*"/,
        );
        expect(rowBlock).not.toBeNull();
        const rowClass = rowBlock![0];
        expect(rowClass).toMatch(/transition-colors/);
        expect(rowClass).toMatch(/duration-150/);
        expect(rowClass).toMatch(/ease-out/);
    });

    it("hover affordance is gated on `onRowClick` or `selectionEnabled` (no affordance on truly read-only rows)", () => {
        // Read-only rows (no onRowClick AND selection disabled)
        // must not signal "click me". After R13-PR14 the gate
        // accepts either onRowClick OR selectionEnabled — both
        // map to "row is interactive". The cell-level shadow
        // inherits the gate via `group-hover/row`.
        expect(src).toMatch(
            /\(\s*onRowClick\s*\|\|\s*selectionEnabled\s*\)\s*&&\s*\n?\s*"cursor-pointer\s+select-none/,
        );
    });

    it("hover + selected shadows attach to the row's TRUE leftmost cell (2026-05-19)", () => {
        // R13-PR15 originally gated the inset-2px hover + selected
        // shadows on `isFirstContent` — the first non-utility
        // column. With selection mounted, that put the brand
        // accent at the LEFT EDGE OF COLUMN 2 (the first data
        // column), leaving the select-checkbox column (column 1)
        // accent-less. The user asked 2026-05-19 to move both
        // accents to the row's actual leftmost cell so the brand
        // edge reads as "this row" rather than "the data starts
        // here".
        //
        // New predicate: `columnId === "select"` OR
        // `(isFirstContent && !hasSelectBefore)`. When the select
        // column is mounted, the SELECT cell carries the accent;
        // when it's not, the first content cell carries it.
        // Either way, the leftmost visible cell wins.
        //
        // This ratchet locks BOTH the hover and selected shadow
        // rules to the same predicate so they speak in one voice.
        // A future regression that reverts either back to plain
        // `isFirstContent &&` fails here.
        const hoverRule = src.match(
            /\(columnId\s*===\s*"select"\s*\|\|\s*\(isFirstContent\s*&&\s*!hasSelectBefore\)\)\s*&&\s*\n?\s*clickable\s*&&\s*\n?\s*"group-hover\/row:shadow-\[inset_2px_0_0_var\(--brand-default\)\]"/,
        );
        expect(hoverRule).not.toBeNull();

        const selectedRule = src.match(
            /\(columnId\s*===\s*"select"\s*\|\|\s*\(isFirstContent\s*&&\s*!hasSelectBefore\)\)\s*&&\s*\n?\s*"group-data-\[selected=true\]\/row:shadow-\[inset_2px_0_0_var\(--brand-default\)\]"/,
        );
        expect(selectedRule).not.toBeNull();
    });
});
