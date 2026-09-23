/**
 * Document scroll lock — global CSS contract.
 *
 * The list-page-shell architecture depends on html/body being locked
 * to viewport height with overflow: hidden at md+ (≥768px). Without
 * this lock, document scrolling is possible and the
 * "page scrolls instead of card" regression silently returns — the
 * flex chain inside the AppShell still tries to do the right thing,
 * but a missing class anywhere lets the inner-div's overflow-y-auto
 * catch the spillover and visually scroll the page.
 *
 * The lock must be paired with a print escape so printers see the
 * full document, not just the viewport-visible area.
 *
 * Mobile (<md) is intentionally NOT locked — natural document scroll
 * stays so touch behaviour is predictable.
 */

import * as fs from 'fs';
import * as path from 'path';

import { cssCodeOf } from '../helpers/source-blocks';

const GLOBALS_CSS = path.resolve(__dirname, '../../src/app/globals.css');

describe('document scroll lock — globals.css contract', () => {
    // Masked at the READ SEAM (#2246). `cssCodeOf` blanks /* … */ while
    // preserving length and line count, so a rule that was COMMENTED OUT can
    // no longer satisfy an assertion about it — and offsets still line up for
    // anything matching on position.
    const css = cssCodeOf(fs.readFileSync(GLOBALS_CSS, 'utf-8'));

    test('html and body are height-locked + overflow-hidden at md+', () => {
        // Match the @media (min-width: 768px) block and assert the
        // html/body rules are inside it. Whitespace-tolerant.
        const mdBlock = css.match(
            /@media\s*\(\s*min-width:\s*768px\s*\)\s*\{[\s\S]*?\n\}/,
        );
        expect(mdBlock).not.toBeNull();
        const block = mdBlock![0];
        expect(block).toMatch(/html\s*,\s*body\s*\{/);
        expect(block).toMatch(/height:\s*100%/);
        expect(block).toMatch(/overflow:\s*hidden/);
    });

    test('print mode releases the lock (full document prints)', () => {
        // Look for an @media print rule that resets html/body to
        // auto height + visible overflow. Without this, printing
        // would only output the viewport-visible region.
        const printBlocks = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/g);
        expect(printBlocks).not.toBeNull();
        const hasReleaseRule = printBlocks!.some(
            (b) =>
                /html\s*,\s*body/.test(b) &&
                /height:\s*auto\s*!important/.test(b) &&
                /overflow:\s*visible\s*!important/.test(b),
        );
        expect(hasReleaseRule).toBe(true);
    });

    test('mobile (<md) is NOT in the lock block', () => {
        // Defence against a future "simplify" that drops the
        // @media wrapper and locks html/body unconditionally.
        // That would break mobile touch scrolling.
        const unconditionalLock = /^html\s*,\s*body\s*\{[^}]*overflow:\s*hidden/m;
        expect(css).not.toMatch(unconditionalLock);
    });
});
