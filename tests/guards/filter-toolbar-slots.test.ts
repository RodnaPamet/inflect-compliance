/**
 * v2-PR-7 — `<FilterToolbar>` slots ratchet.
 *
 * Asserts the canonical reading order on every list page:
 *
 *   [search + filter button] [active pills] [secondary] [primary]
 *
 * Where `secondary` carries icon-only ghost actions (column
 * visibility, bulk export, settings) and `primary` is reserved for
 * the SINGLE primary action of the page (the "Create X" button).
 *
 * Why this is a ratchet:
 *   - The previous toolbar had only one right-edge slot (`actions`).
 *     Pages crowded primary CTAs into the page header instead, which
 *     diluted hierarchy: header buttons should navigate, toolbar
 *     buttons should mutate.
 *   - The slot lock keeps premium feel — never two "Create" buttons
 *     side-by-side, never a primary swimming inside an icon row.
 *
 * Pairs with:
 *   - src/components/filters/FilterToolbar.tsx (the slots)
 *   - src/components/layout/EntityListPage.tsx (the consumer
 *     interface — `filters.toolbarPrimary` threads into the slot)
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

describe("v2-PR-7 FilterToolbar slot contract", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/filters/FilterToolbar.tsx"),
        "utf8",
    ));

    it("declares both `actions` and `primary` slot props", () => {
        expect(src).toMatch(/\bactions\?:/);
        expect(src).toMatch(/\bprimary\?:/);
    });

    it("destructures `primary` in the function signature", () => {
        expect(src).toMatch(/function\s+FilterToolbar\(\{[\s\S]*?\bprimary,/);
    });

    it("renders both slot wrappers with stable test ids", () => {
        // Each slot has a wrapping div with a data-testid so consumer
        // tests can target the cluster regardless of the inner shape.
        expect(src).toContain('data-testid="filter-toolbar-secondary"');
        expect(src).toContain('data-testid="filter-toolbar-primary"');
    });

    it("renders secondary BEFORE primary (canonical reading order)", () => {
        const secondaryIdx = src.indexOf(
            'data-testid="filter-toolbar-secondary"',
        );
        const primaryIdx = src.indexOf(
            'data-testid="filter-toolbar-primary"',
        );
        expect(secondaryIdx).toBeGreaterThan(0);
        expect(primaryIdx).toBeGreaterThan(0);
        expect(secondaryIdx).toBeLessThan(primaryIdx);
    });

    it("renders the consumer `actions` node in the secondary slot (holds BOTH gears)", () => {
        // R-filter-gear (2026-06-07): the secondary slot is a ReactNode
        // pass-through, so a list page mounts BOTH gears as a fragment —
        // `actions={<>{filterGear}{columnsGear}</>}`. The slot rendering
        // `{actions}` verbatim is what lets the two-child fragment land
        // (the rendered two-child assertion lives in
        // `checklist-gear-primitive.test.tsx`).
        const secondaryIdx = src.indexOf(
            'data-testid="filter-toolbar-secondary"',
        );
        const secondaryBlock = src.slice(secondaryIdx, secondaryIdx + 400);
        expect(secondaryBlock).toMatch(/\{actions\}/);
    });
});

describe("v2-PR-7 EntityListPage exposes the slots", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/layout/EntityListPage.tsx"),
        "utf8",
    ));

    it("EntityListPageFilters declares `toolbarPrimary` slot", () => {
        expect(src).toMatch(/\btoolbarPrimary\?:/);
        expect(src).toMatch(/\btoolbarActions\?:/);
    });

    it("threads `filters.toolbarPrimary` into the FilterToolbar primary slot", () => {
        expect(src).toMatch(/primary=\{filters\.toolbarPrimary\}/);
    });
});
