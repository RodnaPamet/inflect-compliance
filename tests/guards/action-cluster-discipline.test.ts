/**
 * v2-PR-14 — `<ActionCluster>` primitive contract.
 *
 * Codifies the detail-page header action hierarchy:
 *
 *   ≤ 1 primary action      — `primary?:`
 *   ≤ 1 secondary action    — `secondary?:`
 *   N overflow items        — `overflow?:` (destructive + utilities)
 *
 * Why a typed cluster:
 *   The TypeScript prop shape ENFORCES the cap — there's literally
 *   no way to pass two `primary` props or two `secondary` props to
 *   `<ActionCluster>`. Crowded action clusters become a TypeScript
 *   error, not a design lapse.
 *
 * Visual order (left → right):
 *   { secondary } { ⋯ overflow menu } { primary }
 *
 * Pairs with:
 *   - src/components/ui/ActionCluster.tsx (the primitive)
 *   - src/components/layout/EntityDetailLayout.tsx (the canonical
 *     home — detail page headers compose via this primitive)
 *   - <Button> variants from v2-PR-1
 *
 * Per-page consumer migration is deferred. The primitive is shipped
 * + ready; pages adopt it as they refactor.
 */
import * as fs from "fs";
import * as path from "path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");

describe("v2-PR-14 ActionCluster primitive contract", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/ui/ActionCluster.tsx"),
        "utf8",
    ));

    it("exports the component + props + action types", () => {
        expect(src).toMatch(/export\s+function\s+ActionCluster/);
        expect(src).toMatch(/export\s+interface\s+ActionClusterProps/);
        expect(src).toMatch(/export\s+interface\s+ActionClusterAction/);
        expect(src).toMatch(/export\s+interface\s+ActionClusterOverflowItem/);
    });

    it("declares the documented slot props", () => {
        expect(src).toMatch(/\bprimary\?:/);
        expect(src).toMatch(/\bsecondary\?:/);
        expect(src).toMatch(/\boverflow\?:/);
    });

    it("primary is a SINGLE optional action (not an array)", () => {
        // The contract forbids two co-equal primary actions — the
        // type system enforces this by making `primary` a single
        // optional ActionClusterAction (with a `variant` extension),
        // never an array.
        expect(src).toMatch(/primary\?:\s*ActionClusterAction\s*&/);
        expect(src).not.toMatch(/primary\?:\s*ReadonlyArray/);
        expect(src).not.toMatch(/primary\?:\s*ActionClusterAction\[\]/);
    });

    it("secondary is a SINGLE optional action (not an array)", () => {
        expect(src).toMatch(/secondary\?:\s*ActionClusterAction;/);
        expect(src).not.toMatch(/secondary\?:\s*ReadonlyArray/);
        expect(src).not.toMatch(/secondary\?:\s*ActionClusterAction\[\]/);
    });

    it("overflow is a ReadonlyArray of overflow items (typed cap)", () => {
        expect(src).toMatch(
            /overflow\?:\s*ReadonlyArray<ActionClusterOverflowItem>/,
        );
    });

    it("overflow items can carry a destructive tone", () => {
        expect(src).toMatch(/tone\?:\s*["']default["']\s*\|\s*["']destructive["']/);
    });

    it("primary variant is locked to 'primary' | 'destructive'", () => {
        // Forbids the "make my primary action ghost" anti-pattern.
        // The cluster is opinionated: primary is either the
        // recommended next step (variant=primary) or the
        // recommended destructive (variant=destructive). Nothing
        // else.
        expect(src).toMatch(
            /variant\?:\s*["']primary["']\s*\|\s*["']destructive["']/,
        );
    });

    it("renders a `MoreHorizontal` icon trigger for the overflow menu", () => {
        expect(src).toMatch(/MoreHorizontal/);
    });

    it("forwards stable test markers", () => {
        // The cluster wrapper carries data-action-cluster; the
        // overflow-menu trigger carries data-testid="action-cluster-
        // more" verbatim; primary + secondary buttons get
        // `action-cluster-${suffix}` test ids built from the
        // `testIdSuffix` arg of `renderTriggerAction`.
        expect(src).toContain("data-action-cluster");
        expect(src).toContain('"action-cluster-more"');
        // The renderTriggerAction calls pass "primary" / "secondary"
        // as the `testIdSuffix` arg, which interpolates into the
        // `action-cluster-${testIdSuffix}` template.
        expect(src).toMatch(/renderTriggerAction\(secondary,[^,]+,\s*"secondary"/);
        expect(src).toMatch(/renderTriggerAction\(primary,[^,]+,\s*"primary"/);
    });

    it("renders nothing when all slots are empty", () => {
        // The primitive doesn't spew chrome for nothing.
        expect(src).toMatch(
            /if\s*\(\s*!primary\s*&&\s*!secondary\s*&&\s*!hasOverflow\s*\)\s*return\s+null/,
        );
    });

    it("places primary on the right edge (visual order: secondary, more, primary)", () => {
        // Renders order in source — JSX renders in DOM order, and
        // for flex-row that means left-to-right. Asserting the
        // source order pins the visual contract.
        const secondaryIdx = src.search(/\{secondary\s*&&\s*renderTriggerAction/);
        const moreIdx = src.search(/\{hasOverflow\s*&&/);
        const primaryIdx = src.search(/\{primary\s*&&/);
        expect(secondaryIdx).toBeGreaterThan(0);
        expect(moreIdx).toBeGreaterThan(0);
        expect(primaryIdx).toBeGreaterThan(0);
        expect(secondaryIdx).toBeLessThan(moreIdx);
        expect(moreIdx).toBeLessThan(primaryIdx);
    });
});
