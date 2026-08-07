/**
 * Controls — inline task-row expansion ratchet.
 *
 * Locks: the DataTable primitive supports expandable rows (tanstack expanded
 * model) via TWO sub-row slots — `renderExpandedRow` (full-width colSpan) and
 * `renderAlignedSubRows` (real <tr>/<td> rows aligned to the parent columns).
 * The Controls table opts in to the ALIGNED slot so each linked task lines up
 * under the control's category / status / owner / evidence columns. Default-off
 * contract: the chevron/sub-rows only render when a consumer passes one of the
 * two render props.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("Controls — row expansion", () => {
    it("DataTable primitive wires the tanstack expanded model + both sub-row slots", () => {
        const table = read("src/components/ui/table/table.tsx");
        expect(table).toMatch(/getExpandedRowModel\(\)/);
        expect(table).toMatch(/getRowCanExpand/);
        // colSpan slot (generic).
        expect(table).toMatch(/renderExpandedRow && row\.getIsExpanded\(\)/);
        expect(table).toMatch(/data-expanded-subrow/);
        // Aligned sub-rows slot (Controls) — passes the visible column ids.
        expect(table).toMatch(/renderAlignedSubRows && row\.getIsExpanded\(\)/);
        expect(table).toMatch(/c\.column\.id\)/);
    });

    it("the expand chevron renders when EITHER render prop is supplied", () => {
        const table = read("src/components/ui/table/table.tsx");
        expect(table).toMatch(
            /\(!!renderExpandedRow \|\| !!renderAlignedSubRows\)[\s\S]*row\.getCanExpand\(\)/,
        );
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
