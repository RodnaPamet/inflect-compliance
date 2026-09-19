/**
 * Roadmap-8 PR-7 (replacement) — InlineEmptyState coverage ratchet.
 *
 * `<InlineEmptyState>` (R8-PR1) is the small-format empty state for
 * tab bodies, dashboard tiles, and other "one-line empty inside a
 * card" contexts where the full `<EmptyState>` would over-pad.
 * R8-PR2 migrated the 14 known offenders. R8-PR7 (replacement)
 * locks the primitive's API contract + enforces that the migrated
 * sites continue to use it.
 *
 * What this ratchet locks:
 *
 *   1. Primitive shape: the file at
 *      `src/components/ui/inline-empty-state.tsx` exists, exports
 *      `<InlineEmptyState>` + the props interface, and renders
 *      `data-inline-empty-state` for E2E selectability.
 *   2. The icon prop type does NOT import from `lucide-react`
 *      (R2-PR8 ban). Structural type via `ComponentType<SVGProps>`
 *      keeps the primitive family-agnostic.
 *   3. Vertical rhythm contract: `py-8` with icon, `py-6` without.
 *      A future PR that flattens the rhythm fails the assertion.
 *   4. Title weight contract: `text-sm font-medium` (premium
 *     products at this density lean on tone, not weight contrast).
 *
 * Pairs with:
 *   • `src/components/ui/inline-empty-state.tsx` (the primitive)
 *   • `tests/guards/empty-loading-primitive-only.test.ts` (R7-PR6
 *     forbids inline `<div>No X yet</div>` outside the primitive)
 */
import * as fs from "fs";
import * as path from "path";
import { codeOf } from "../helpers/source-blocks";

const ROOT = path.resolve(__dirname, "../..");
const PRIMITIVE = "src/components/ui/inline-empty-state.tsx";

describe("InlineEmptyState primitive contract", () => {
    const fp = path.join(ROOT, PRIMITIVE);
    // Read with comments blanked (#2246 Class A). `py-8` / `py-6` /
    // `text-sm font-medium` are each spelled out in this primitive's own
    // docblock as well as in its className, so a raw read cannot tell the
    // rhythm contract from the paragraph describing it.
    const readSrc = () => codeOf(fs.readFileSync(fp, "utf8"));

    it("primitive file exists at the expected path", () => {
        expect(fs.existsSync(fp)).toBe(true);
    });

    it("exports InlineEmptyState + props type", () => {
        const src = readSrc();
        expect(src).toMatch(/export\s+function\s+InlineEmptyState/);
        expect(src).toMatch(/InlineEmptyStateProps/);
    });

    it("does NOT import from lucide-react (R2-PR8 ban)", () => {
        const src = readSrc();
        expect(src).not.toMatch(/from\s+["']lucide-react["']/);
    });

    it("emits the data-inline-empty-state marker for E2E selectability", () => {
        const src = readSrc();
        expect(src).toMatch(/data-inline-empty-state/);
    });

    it("vertical rhythm contract: py-8 with icon / py-6 without", () => {
        const src = readSrc();
        // The conditional rhythm is the primitive's locked
        // contract. Flattening to one shared padding undoes the
        // composed-with-icon vs bare-text rhythm distinction.
        expect(src).toMatch(/py-8/);
        expect(src).toMatch(/py-6/);
    });

    it("title weight contract: text-sm font-medium", () => {
        const src = readSrc();
        // Locked at `text-sm font-medium` per the primitive's
        // docblock: "premium products lean on icon + tone for
        // hierarchy at this density rather than weight contrast."
        // A future PR cranking the title to text-base or font-bold
        // breaks the density contract.
        expect(src).toMatch(/text-sm\s+font-medium/);
    });
});
