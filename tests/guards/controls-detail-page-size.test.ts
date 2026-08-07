/**
 * The control detail page's DECOMPOSITION, measured by state — not by lines.
 *
 * WHY THE LINE CAP WENT
 * ---------------------
 * This file used to pin `[controlId]/page.tsx` at `MAX_LINES = 1404`, with
 * 21 lines of headroom and a documented history of three raises (+122)
 * against one drop (-106): net upward. Its failure message claimed "the page
 * is the largest in the codebase" — it was the 6th largest, and
 * `ControlsClient.tsx` on the SAME SURFACE is ~1,958 lines and was never
 * capped at all, so content could be moved from the capped file to the
 * uncapped one and the ratchet would call that progress.
 *
 * What a line cap actually incentivised, all three observable here:
 *
 *   1. DENSER CODE rather than less. Compare the one-line label builders at
 *      the top of this page with the same logic spread over eleven lines in
 *      ControlsClient.
 *   2. PRESENTATION-ONLY extraction. Only 2 of 8 tab bodies live in
 *      `_tabs/`, because JSX moves cheaply and state cannot follow it — so
 *      the controller stayed and the markup left.
 *   3. Extraction to ADJACENT rather than CORRECT locations. `EvidenceSubTable`
 *      was extracted into `_tabs/` "per the page-size ratchet", and that
 *      Next.js-private directory then became a FOUR-SURFACE public
 *      dependency (see tests/guards/route-import-boundaries.test.ts). The
 *      cap did not just fail to help; it produced the coupling.
 *
 * WHAT REPLACED IT
 * ----------------
 *   - `route-import-boundaries.test.ts` — where code lives, which is what
 *     the cap was a bad proxy for.
 *   - the state cap below — how much the page ORCHESTRATES, which is what
 *     makes a page hard to change. Moving JSX out does not move this number;
 *     moving a concern out does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const PAGE = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx',
);

/**
 * Ceiling on independent state hooks in the page component.
 *
 * Observed 24 at the time of writing (this counts `useState<T>(` generic
 * forms too, which a bare `useState(` grep misses — I set the cap from the
 * narrower count first and the test caught it). 26 leaves room for one
 * genuine new concern without leaving room for drift. Unlike a line cap, this cannot be
 * satisfied by relocating markup — only by moving a piece of state, and its
 * behaviour, somewhere that owns it.
 *
 * To LOWER it (good — the page shed a concern): change the number in the
 * same diff. To raise it: don't. Extract instead — that is the entire point
 * of measuring this rather than lines.
 */
const MAX_STATE_HOOKS = 26;

function pageSource(): string {
    return fs.readFileSync(PAGE, 'utf8');
}

function countMatches(src: string, re: RegExp): number {
    return (src.match(re) ?? []).length;
}

describe('control detail page — decomposition', () => {
    it('does not accumulate orchestration state', () => {
        const src = pageSource();
        const stateHooks = countMatches(src, /\buseState[<(]/g);

        expect({
            stateHooks,
            withinCap: stateHooks <= MAX_STATE_HOOKS,
            cap: MAX_STATE_HOOKS,
        }).toEqual({ stateHooks, withinCap: true, cap: MAX_STATE_HOOKS });
    });

    it('is not measured by line count any more', () => {
        // Guards the replacement itself. Re-adding a MAX_LINES constant here
        // would reinstate the incentive that produced the four-surface
        // coupling, so it has to be a deliberate, visible act.
        const self = fs.readFileSync(__filename, 'utf8');
        // (the identifier appears in this file only inside prose, hence the
        // split — the check is for a real constant declaration)
        const declaration = new RegExp('const\\s+MAX_' + 'LINES\\s*=');
        expect(declaration.test(self)).toBe(false);
    });

    it('the page still exists where the boundary guard expects it', () => {
        expect(fs.existsSync(PAGE)).toBe(true);
    });
});
