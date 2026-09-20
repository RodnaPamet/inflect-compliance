/**
 * Mobile roadmap — capstone meta-ratchet ("guard the guards").
 *
 * The 5-PR mobile-friendliness roadmap (touch targets · responsive DataTable ·
 * viewport-safe popovers · dashboard stack · canvas fallback) each shipped a
 * structural guard. This capstone asserts every one of them still EXISTS and is
 * non-trivial, plus the responsive E2E spec carries its mobile coverage — so a
 * future PR can't quietly delete a mobile guard and let the regression class
 * back in. Mirrors the repo's other domain integrity ratchets
 * (ci-pipeline-integrity, verification-integrity, codebase-hygiene-integrity).
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
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

// Every mobile guard, with the roadmap PR / baseline that owns it.
const MOBILE_GUARDS: Record<string, string> = {
    "tests/guards/mobile-readiness.test.ts": "R11 baseline (viewport meta)",
    "tests/guards/r14-mobile-parity-discipline.test.ts": "R14 unified chrome",
    "tests/guards/p6b-touch-mobile.test.ts": "P6 canvas touch targets",
    "tests/guards/mobile-touch-targets.test.ts": "PR-1 touch ergonomics",
    "tests/guards/mobile-datatable-cards.test.ts": "PR-2 responsive DataTable",
    "tests/guards/mobile-popover-viewport-clamp.test.ts": "PR-3 popover clamps",
    "tests/guards/mobile-dashboard-stack.test.ts": "PR-4 dashboard stack",
    "tests/guards/mobile-canvas-fallback.test.ts": "PR-5 canvas fallback",
};

describe("Mobile roadmap integrity (capstone)", () => {
    it.each(Object.entries(MOBILE_GUARDS))(
        "guard exists + is non-trivial: %s (%s)",
        (file) => {
            expect(exists(file)).toBe(true);
            const src = read(file);
            expect(src).toMatch(/describe\(/);
            expect(src.length).toBeGreaterThan(400);
        },
    );

    it("the canonical < md viewport hook lives in the shared hooks barrel", () => {
        expect(exists("src/components/ui/hooks/use-is-below-md.ts")).toBe(true);
        expect(read("src/components/ui/hooks/index.ts")).toMatch(
            /useIsBelowMd/,
        );
    });

    it("the responsive E2E spec carries the mobile overflow sweep + touch emulation", () => {
        const spec = read("tests/e2e/responsive.spec.ts");
        expect(spec).toMatch(/hasTouch:\s*true/);
        expect(spec).toMatch(/no horizontal overflow/);
        // The sweep covers more than just controls.
        expect(spec).toMatch(/'risks', 'policies', 'vendors'/);
    });
});
