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

    it("DataTable gates the card view on useIsBelowMd, and mounts the cards", () => {
        // ONLY the two things this file can say better than a render: that the
        // breakpoint hook is what decides, and that the card component is
        // mounted at all.
        //
        // The rest of the gate — real rows, not loading, not errored — used to
        // be pinned here as one source-text literal,
        // `/belowMd && data\.length > 0 && !error && !loading/`. That pinned a
        // SPELLING rather than the gate: inserting `collapsesToCards` (the
        // `mobileFallback` escape hatch) reddened it, by ADDING a condition to
        // the very gate it protects. Splitting it per conjunct fixed that and
        // bought three Class D ambiguous needles instead — `/!error/` and
        // `/!loading/` each match twice in this file, so either conjunct could
        // be deleted from the gate and a survivor elsewhere would satisfy the
        // assertion.
        //
        // So the conditions are asserted as BEHAVIOUR instead, in
        // `tests/rendered/data-table-mobile-fallback.test.tsx`: the collapse
        // happens with the prop omitted, `'scroll'` keeps the table, and
        // loading / errored / empty each keep the table's own chrome. A render
        // cannot be satisfied by a survivor somewhere else in the file.
        expect(dt).toMatch(/const belowMd = useIsBelowMd\(\)/);
        expect(dt).toMatch(/<DataTableCards/);
    });

    it("the mobile fallback DEFAULTS to cards, so omitting it is the safe case", () => {
        // `mobileFallback="scroll"` is an escape hatch for a genuinely
        // desktop-only table. If the default ever flipped, every DataTable in
        // the app would start horizontal-scrolling on a phone — the card
        // branch would simply stop being taken, with nothing else here to
        // notice. Both needles are unique in the file.
        expect(dt).toMatch(/mobileFallback\?: "card" \| "scroll"/);
        expect(dt).toMatch(/\(mobileFallback \?\? "card"\) === "card"/);
    });

    it("the mobile fallback DEFAULTS to cards, so omitting it is the safe case", () => {
        // `mobileFallback="scroll"` is an escape hatch for a genuinely
        // desktop-only table. If the default ever flipped, every DataTable on
        // the app would start horizontal-scrolling on a phone and nothing
        // else here would notice — the card branch would simply stop being
        // taken. The rendered proof is in
        // `tests/rendered/data-table-mobile-fallback.test.tsx`, which asserts
        // the collapse with the prop OMITTED; this is the structural half.
        expect(dt).toMatch(/mobileFallback\?: "card" \| "scroll"/);
        expect(dt).toMatch(/\(mobileFallback \?\? "card"\) === "card"/);
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
        // `getVisibleCells()` WITHOUT the `row.` receiver. The receiver was in
        // the needle and the needle lost the thread at a reformat: chaining a
        // `.filter()` onto the call put `row` and `.getVisibleCells()` on
        // separate lines, and this went red with nothing about the behaviour
        // changed. Nothing but a tanstack row has this method, so the claim
        // survives dropping the token — and the line above is what actually
        // pins "the SHARED instance".
        expect(cards).toMatch(/getVisibleCells\(\)/);
    });
});
