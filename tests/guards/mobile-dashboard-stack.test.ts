/**
 * Mobile PR-4 — dashboard + charts mobile ratchet.
 *
 * Locks: (a) DashboardGrid swaps the 12-col drag grid for a single-column
 * stack below md; (b) HeroMetric stays vertically stacked on mobile; (c) the
 * shared chart x-axis still derives tick density from width (so dense axes
 * don't overlap on narrow screens). (b)/(c) already held before this PR —
 * the ratchet keeps them from regressing as part of the mobile contract.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), "utf8"));

describe("Mobile PR-4 — dashboard + charts", () => {
    it("DashboardGrid renders a single-column stack below md (no RGL drag grid)", () => {
        const src = read("src/components/ui/dashboard-widgets/DashboardGrid.tsx");
        expect(src).toMatch(/const belowMd = useIsBelowMd\(\)/);
        expect(src).toMatch(/if \(belowMd\)/);
        expect(src).toMatch(/data-dashboard-stacked/);
        // The stack must NOT mount the drag/resize grid.
        const stackBranch = src.slice(
            src.indexOf("if (belowMd)"),
            src.indexOf("return (\n        <ResponsiveGridLayout"),
        );
        expect(stackBranch).not.toMatch(/ResponsiveGridLayout/);
    });

    it("HeroMetric stacks vertically on mobile, row at md+", () => {
        const src = read("src/components/ui/HeroMetric.tsx");
        expect(src).toMatch(/flex-col[^"]*md:flex-row/);
    });

    it("the shared chart x-axis derives tick density from width", () => {
        const src = read("src/components/ui/charts/x-axis.tsx");
        expect(src).toMatch(/pickXAxisTickCount\(width\)/);
    });
});
