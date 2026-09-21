/**
 * Mobile PR-3 — popover / dropdown viewport-clamp ratchet.
 *
 * A floating surface (combobox dropdown, filter popover, menu, gear list,
 * notifications panel) must never be WIDER than the viewport on a phone, or it
 * forces horizontal scroll on the whole page. Two rules:
 *
 *   1. Any `w-screen` in a component className must be paired with a
 *      `max-w-[calc(100vw-…)]` clamp on the SAME element (`w-screen` is 100vw,
 *      which overflows by the scrollbar width + sub-pixel rounding).
 *   2. The known fixed-width floating surfaces carry an explicit viewport clamp.
 *
 * `max-w-screen-*` (a Tailwind max-WIDTH cap) is not `w-screen` and is fine.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), "utf8"));

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === "__tests__") continue;
            walk(full, acc);
        } else if (entry.name.endsWith(".tsx")) {
            acc.push(full);
        }
    }
    return acc;
}

describe("Mobile PR-3 — popover/dropdown viewport clamp", () => {
    it("every w-screen element is clamped to the viewport (no full-100vw overflow)", () => {
        const files = walk(path.join(ROOT, "src/components"));
        const offenders: string[] = [];
        for (const file of files) {
            const src = codeOf(fs.readFileSync(file, "utf8"));
            src.split("\n").forEach((line, i) => {
                // `\bw-screen\b` but NOT `max-w-screen-*` (a max-width cap).
                if (!/(^|[\s"'`])w-screen\b/.test(line)) return;
                if (/max-w-\[calc\(100vw/.test(line)) return; // clamped
                offenders.push(
                    `${path.relative(ROOT, file)}:${i + 1}`,
                );
            });
        }
        expect(offenders).toEqual([]);
    });

    it("the known fixed-width floating surfaces carry a viewport clamp", () => {
        const sites: Array<[string, RegExp]> = [
            ["src/components/ui/combobox/index.tsx", /max-w-\[calc\(100vw-1rem\)\]/],
            ["src/components/org-switcher.tsx", /w-\[260px\] max-w-\[calc\(100vw-1rem\)\]/],
            ["src/components/layout/notifications-bell.tsx", /w-\[340px\] max-w-\[calc\(100vw-1rem\)\]/],
        ];
        for (const [file, re] of sites) {
            expect(read(file)).toMatch(re);
        }
    });

    it("the numeric range panel is full-width on mobile (fixed width only at sm+)", () => {
        const src = read("src/components/ui/filter/filter-range-panel.tsx");
        expect(src).toMatch(/w-full[^"]*sm:min-w-\[282px\][^"]*sm:max-w-\[282px\]/);
    });
});
