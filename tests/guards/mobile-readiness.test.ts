/**
 * Roadmap-11 PR-9 — Mobile readiness baseline.
 *
 * Two locks today; the full mobile-responsive sweep is the
 * follow-up. PR-9 establishes the foundation:
 *
 *   1. **Viewport metadata.** The root layout MUST export a Next.js
 *      `viewport` object with `width: 'device-width'` +
 *      `initialScale: 1`. Without it, Next 14+ doesn't emit the
 *      viewport meta tag and mobile devices render the page at
 *      desktop width (980px) and scale down — every UI element
 *      becomes microscopic. Even if every component is responsive,
 *      the missing meta tag erases that work.
 *
 *   2. **No `maximum-scale: 1`.** Setting `maximum-scale: 1`
 *      prevents user pinch-zoom — an accessibility regression
 *      flagged by WCAG 2.1 SC 1.4.4 (Resize text). Some legacy
 *      "fix iOS auto-zoom on input focus" patterns set it; we use
 *      a different, accessibility-safe fix (16px+ input font-size).
 *
 * Direction of travel: follow-up PRs ratchet more mobile invariants
 * (DataTable stack-on-narrow, FilterToolbar wrap order, EmptyState
 * sm-variant baseline).
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

describe('Mobile readiness baseline (R11-PR9)', () => {
    test('root layout exports a Next.js `viewport` object', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/app/layout.tsx'),
            'utf-8',
        ));
        // Lock the export. Next.js looks for `export const viewport =`
        // OR `export function generateViewport` — we use the const
        // form because the values are static.
        expect(src).toMatch(/export\s+const\s+viewport\s*:\s*Viewport\b/);
    });

    test('viewport sets width: device-width + initialScale: 1', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/app/layout.tsx'),
            'utf-8',
        ));
        const block = src.match(/export\s+const\s+viewport[\s\S]+?\};/)?.[0] ?? '';
        expect(block).toMatch(/width:\s*['"]device-width['"]/);
        expect(block).toMatch(/initialScale:\s*1\b/);
    });

    test('viewport does NOT set `maximumScale: 1` (a11y)', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/app/layout.tsx'),
            'utf-8',
        ));
        const block = src.match(/export\s+const\s+viewport[\s\S]+?\};/)?.[0] ?? '';
        // maximumScale: 1 disables pinch-zoom — never set it.
        // Higher values (or omitting the field) are fine.
        expect(block).not.toMatch(/maximumScale:\s*1\b/);
        // Explicitly verify the canonical accessible value is set.
        expect(block).toMatch(/maximumScale:\s*[2-9]\b/);
    });
});
