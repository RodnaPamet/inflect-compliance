/**
 * Controls — inline task-row expansion.
 *
 * Locks the WIRING that no rendered test can see: which slot the Controls
 * table opts in to, and that the expanded rows fetch the control's linked
 * tasks from the unified work-item endpoint.
 *
 * WHAT MOVED OUT OF HERE (2026-08-08, roadmap P3.2 + P3.8)
 * --------------------------------------------------------
 * This file used to regex `table.tsx` for the primitive's internals —
 * `getExpandedRowModel()`, `renderExpandedRow && row.getIsExpanded()`,
 * `data-expanded-subrow`, and the chevron's `(!!a || !!b)` condition. Two
 * problems with that:
 *
 *   1. It asserted the DataTable's own behaviour through its source text,
 *      which `tests/rendered/data-table-row-expansion.test.tsx` now asserts by
 *      rendering — chevron per expandable row, default-off, per-row gating,
 *      and the column-id alignment that is the whole point of the slot.
 *   2. It pinned `renderExpandedRow`, a SECOND expansion slot (one full-width
 *      colSpan cell) with no consumer anywhere in the product. Removing dead
 *      code from a shared primitive failed a Controls ratchet — the ratchet
 *      was the only thing keeping it alive.
 *
 * What stays is the part that is genuinely structural: a page's choice of
 * which primitive slot to use, and the endpoint its sub-rows read.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("Controls — row expansion", () => {
    it("the DataTable primitive still exposes the aligned sub-row slot", () => {
        // Presence only — the BEHAVIOUR is covered by the rendered test. This
        // guards against the slot being removed while a page still passes it,
        // which would silently render nothing.
        const table = read("src/components/ui/table/table.tsx");
        expect(table).toMatch(/renderAlignedSubRows/);
        expect(table).toMatch(/getRowCanExpand/);
    });

    it("Controls table opts in via the ALIGNED slot: getRowCanExpand + renderAlignedSubRows", () => {
        const src = read("src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx");
        expect(src).toMatch(/getRowCanExpand: getControlCanExpand/);
        expect(src).toMatch(/renderAlignedSubRows: renderControlTaskSubRows/);
        expect(src).toMatch(/<ControlTaskRows/);
        // The aligned rows receive the visible column ids + the shared evidence
        // renderer (so the Evidence cell matches the control row exactly).
        expect(src).toMatch(/columnIds=\{columnIds\}/);
        expect(src).toMatch(/renderEvidence=\{renderTaskEvidence\}/);
    });

    it("expanded task rows lazy-fetch the control's linked tasks + emit aligned <td>s", () => {
        const src = read("src/components/controls-shared/ControlTaskRows.tsx");
        expect(src).toMatch(/linkedEntityType=CONTROL&linkedEntityId=/);
        // One <td> per visible column id — the alignment mechanism.
        expect(src).toMatch(/columnIds\.map\(\(columnId\)/);
    });
});
