/**
 * Mobile PR-1 — touch-target + input-affordance ratchet.
 *
 * On COARSE pointers (touch) every interactive primitive must present at least
 * a 44px hit target (WCAG 2.5.5 / Apple HIG). The fix lives on the shared
 * primitives (one change, app-wide) via Tailwind's `pointer-coarse:` variant,
 * plus a globals.css coarse block for native `.input` controls and the small
 * Radix toggle controls. This ratchet locks each site so the touch floor can't
 * silently regress.
 *
 * `min-h-11` / `min-w-11` = 2.75rem = 44px. `min-*` only RAISES, so the dense
 * desktop sizes (button h-7..h-10, input h-8..h-10) are untouched on fine
 * pointers — verified by the existing R20 density ratchets, which still pass.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read below is
// TypeScript/TSX, re-derived in this file rather than assumed from the paths.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const read = (p: string) => codeOf(readRaw(p));

describe("Mobile PR-1 — coarse-pointer touch targets", () => {
    it("Button cva base carries a 44px coarse-pointer min-height", () => {
        const src = read("src/components/ui/button-variants.ts");
        expect(src).toMatch(/pointer-coarse:min-h-11/);
    });

    it("Button icon size carries a 44px coarse-pointer min-width (square touch)", () => {
        const src = read("src/components/ui/button-variants.ts");
        // The `icon` size string must include the coarse min-width.
        expect(src).toMatch(/icon:\s*"[^"]*pointer-coarse:min-w-11[^"]*"/);
    });

    it("Input cva base carries a 44px coarse-pointer min-height", () => {
        const src = read("src/components/ui/input.tsx");
        expect(src).toMatch(/pointer-coarse:min-h-11/);
    });

    it("FilterSelect trigger carries a 44px coarse-pointer min-height", () => {
        const src = read("src/components/ui/filter/filter-select.tsx");
        expect(src).toMatch(/pointer-coarse:min-h-11/);
    });

    describe("globals.css coarse block", () => {
        const src = read("src/app/globals.css");
        const coarse = src.slice(src.indexOf("@media (pointer: coarse)"));

        it("native .input controls get a 44px floor on coarse pointers", () => {
            expect(coarse).toMatch(/\.input\s*\{[^}]*min-height:\s*44px/);
        });

        it("Radix toggle controls get a 44px transparent hit-target", () => {
            expect(coarse).toMatch(/\[role="checkbox"\]/);
            expect(coarse).toMatch(/\[role="radio"\]/);
            expect(coarse).toMatch(/\[role="switch"\]/);
            // The expansion is via a 44px ::before.
            expect(coarse).toMatch(/::before[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
        });
    });

    it("Input derives inputMode from type for the right mobile keyboard", () => {
        const src = read("src/components/ui/input.tsx");
        expect(src).toMatch(/TYPE_TO_INPUTMODE/);
        expect(src).toMatch(/inputMode=\{inputMode\}/);
        // email/tel/number/search/url are mapped.
        expect(src).toMatch(/email:\s*"email"/);
        expect(src).toMatch(/number:\s*"numeric"/);
    });
});
