/**
 * Mobile PR-2 — responsive DataTable ratchet.
 *
 * Below `md`, every `<DataTable>` swaps the wide table for a stacked card list
 * so it can't overflow / truncate on phones. This locks the wiring so a
 * refactor can't silently drop the mobile rendering.
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

describe("Mobile PR-2 — responsive DataTable", () => {
    const dt = read("src/components/ui/table/data-table.tsx");
    const cards = read("src/components/ui/table/data-table-cards.tsx");
    // The hook's canonical home is the shared hooks dir (mobile PR-4 promoted
    // it; table/use-is-below-md re-exports for back-compat).
    const hook = read("src/components/ui/hooks/use-is-below-md.ts");

    it("DataTable gates the card view on useIsBelowMd and real rows", () => {
        expect(dt).toMatch(/const belowMd = useIsBelowMd\(\)/);
        expect(dt).toMatch(
            /belowMd && data\.length > 0 && !error && !loading/,
        );
        expect(dt).toMatch(/<DataTableCards/);
    });

    it("the breakpoint hook is SSR/jsdom-safe (starts false, max-width:767.98px)", () => {
        // Starting false keeps the desktop table the default under jsdom +
        // first paint — existing table tests don't need to change.
        expect(hook).toMatch(/useState\(false\)/);
        expect(hook).toMatch(/max-width: 767\.98px/);
    });

    it("card values wrap (break-words), never truncate a cell value", () => {
        expect(cards).toMatch(/break-words/);
        expect(cards).not.toMatch(/\btruncate\b/);
    });

    it("the card list renders from the shared tanstack table instance", () => {
        expect(cards).toMatch(/table\.getRowModel\(\)\.rows/);
        expect(cards).toMatch(/row\.getVisibleCells\(\)/);
    });
});
