/**
 * Roadmap-8 PR-11 — page-action coverage ratchet.
 *
 * Two primitives sit on the shelf for page-header action clusters:
 *
 *   • `<PageActions>` (Roadmap-3 PR-1) — locks the geometry of the
 *     cluster: `flex flex-wrap-reverse items-center justify-end
 *     gap-tight min-h-9`. Every cluster shares the same right-edge
 *     spacing and wrap behaviour.
 *
 *   • `<ActionCluster>` (v2-PR-14) — TypeScript-typed primitive
 *     enforcing ≤1 primary + ≤1 secondary + N overflow items. The
 *     prop shape makes "two primaries" a compile-time error rather
 *     than a design lapse.
 *
 * Both are well-built. Both have zero in-app adopters. R7-PR1's
 * primary-action budget catches some of the symptoms of overcrowded
 * clusters but doesn't enforce the cluster itself.
 *
 * This ratchet is the structural lock for the future migration:
 *   1. Both primitives exist and export the expected API.
 *   2. The PageActions primitive carries the locked geometry
 *      (`flex flex-wrap-reverse items-center justify-end gap-tight
 *      min-h-9`) — a future "let's tighten this" PR can't silently
 *      change the recipe without updating the assertion.
 *   3. ActionCluster's typed `primary?: ActionItem` /
 *      `secondary?: ActionItem` prop shape is preserved — a future
 *      PR can't widen the type to `primary?: ActionItem |
 *      ActionItem[]` and reopen the regression.
 *
 * Migration of consumer pages onto these primitives is left as
 * follow-up work — the consumer migration registry pattern from
 * R7-PR9 is the right shape when/if a future round picks it up.
 */
import * as fs from "fs";
import * as path from "path";
import { codeOf } from "../helpers/source-blocks";

const ROOT = path.resolve(__dirname, "../..");
// Comments blanked at the READ, string literals kept (#2246 Class A):
// every geometry class below (`gap-tight`, `min-h-9`, `justify-end`)
// also appears in this primitive's own docblock, so a raw read is
// satisfied by the prose that DESCRIBES the recipe after the recipe
// itself is gone.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("page-actions primitive coverage", () => {
    it("PageActions primitive exists and exports the expected API", () => {
        const src = read("src/components/layout/PageActions.tsx");
        expect(src).toMatch(/export\s+function\s+PageActions/);
    });

    it("PageActions geometry contract is locked", () => {
        const src = read("src/components/layout/PageActions.tsx");
        // The recipe lives in the primitive's outer wrapper. A
        // future PR that drops `flex-wrap-reverse` (which keeps
        // primary visually rightmost when the cluster wraps) or
        // tightens `gap-tight` to a different scale fails this
        // assertion before the regression ships.
        expect(src).toMatch(/flex\s+flex-wrap-reverse/);
        expect(src).toMatch(/justify-end/);
        expect(src).toMatch(/gap-tight/);
        expect(src).toMatch(/min-h-9/);
    });

    it("ActionCluster primitive exists and exports the typed cap", () => {
        const src = read("src/components/ui/ActionCluster.tsx");
        expect(src).toMatch(/export\s+function\s+ActionCluster/);
    });

    it("ActionCluster prop shape preserves the ≤1 primary + ≤1 secondary cap", () => {
        const src = read("src/components/ui/ActionCluster.tsx");
        // The TypeScript prop shape is the cap — `primary?: ActionItem`
        // (singular) means the compiler rejects two primaries. A
        // future PR widening to `primary?: ActionItem | ActionItem[]`
        // OR `primary?: ActionItem[]` reopens the regression door.
        // Match the singular optional shape; both `ActionItem` and
        // namespaced `Cluster.Action`-style types are fine, but the
        // value type cannot be an array.
        const match = src.match(/primary\?\s*:\s*(?!.*\[\])([A-Za-z][\w.<>,\s]*)/);
        expect(match).not.toBeNull();
        // Same for secondary.
        const sec = src.match(/secondary\?\s*:\s*(?!.*\[\])([A-Za-z][\w.<>,\s]*)/);
        expect(sec).not.toBeNull();
    });

    it("PageHeader threads its actions slot through PageActions", () => {
        // The whole point of having PageActions is that the
        // <PageHeader actions={...}> slot routes through it
        // automatically — so existing call sites get the locked
        // geometry without changing. A future PR that bypasses
        // PageActions in PageHeader would silently re-fragment the
        // cluster recipe.
        const src = read("src/components/layout/PageHeader.tsx");
        expect(src).toMatch(/PageActions/);
    });
});
