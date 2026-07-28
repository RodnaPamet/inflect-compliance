/**
 * B10 (2026-06-07) — dark-theme create-button contrast.
 *
 * The primary (create) button rendered WHITE text on the bright METRO-yellow
 * dark-theme fill — a low-contrast wash. Two fixes:
 *   1. label → `text-content-inverted` (deep navy "metro" blue in dark,
 *      off-white in light) instead of `text-white`.
 *   2. the dark primary fill deepened from the pale 0.55-alpha yellow
 *      (Still Surface later made the fill fully opaque, retiring the
 *      `--btn-glass-fill-primary` token this originally named)
 *      to a richer, more saturated gold at higher alpha.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const BV = read('src/components/ui/button-variants.ts');
const TOKENS = read('src/styles/tokens.css');

describe('B10 — dark create-button contrast', () => {
    it('the primary label uses the inverted (metro-navy) token, not white', () => {
        expect(BV).toMatch(
            /text-content-inverted/,
        );
        expect(BV).not.toMatch(/var\(--btn-gradient-primary\)\]\s+text-white/);
    });

    it('the primary fill is fully opaque — no translucent wash', () => {
        // B10's second fix deepened `--btn-glass-fill-primary` from a pale
        // 0.55-alpha yellow to 0.85, because a translucent brand fill let
        // the page tone bleed through and washed the label out.
        //
        // Still Surface (2026-07-28) removed the alpha problem at its
        // source: the primary fill is now an OPAQUE gradient between the
        // brand stops, so there is no alpha left to get wrong. The token
        // it referenced was retired with the rest of the glass suite.
        //
        // What still needs guarding is the invariant B10 actually cared
        // about — the label must sit on a solid brand surface, not a wash.
        expect(BV).toMatch(/var\(--brand-default\)/);
        expect(BV).toMatch(/var\(--brand-emphasis\)/);
        expect(BV).not.toMatch(/--btn-glass-fill-primary/);
        // And the retired translucent tokens must not come back.
        expect(TOKENS).not.toMatch(/--btn-glass-fill-primary/);
    });
});
