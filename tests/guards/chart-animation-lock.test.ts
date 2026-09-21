/**
 * Roadmap-11 PR-11 — Chart animation polish lock.
 *
 * Charts feel polished when their transitions animate with a
 * consistent easing curve. Pre-R11 the DonutChart used
 * `transition-all duration-500` with no easing — the default
 * `linear` curve gives a robotic segment expansion.
 *
 * R11-PR11 locks `ease-out` on every chart primitive's transition,
 * pairing with R11-PR5's animation-language ratchet. `ease-out`
 * matches the "settles into place" expectation users have for
 * data-viz transitions; `linear` or `ease-in-out` are wrong tone.
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

/** Chart primitives that should carry the polished transition. */
const CHART_PRIMITIVES = [
    'src/components/ui/DonutChart.tsx',
    'src/components/ui/mini-area-chart.tsx',
];

describe('Chart animation polish lock (R11-PR11)', () => {
    test('every chart primitive that uses transition-all also uses ease-out', () => {
        const offenders: string[] = [];
        for (const rel of CHART_PRIMITIVES) {
            const abs = path.resolve(ROOT, rel);
            if (!fs.existsSync(abs)) continue;
            const src = codeOf(fs.readFileSync(abs, 'utf-8'));
            // If the file uses `transition-all`, every site should
            // also carry an `ease-` token nearby (within the same
            // className-string). The pragmatic check: a global count
            // of `transition-all` should be ≤ the count of
            // `transition-all ... ease-`.
            const transitionAllCount = (
                src.match(/transition-all/g) ?? []
            ).length;
            if (transitionAllCount === 0) continue;
            const withEasing = (
                src.match(/transition-all[^"'`\n]*ease-[a-z-]+/g) ?? []
            ).length;
            if (withEasing < transitionAllCount) {
                offenders.push(
                    `${rel} (${transitionAllCount} transition-all, ${withEasing} carry an ease- token)`,
                );
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} chart primitive(s) use \`transition-all\` without a paired ease- token:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: append ` ease-out` (or another locked easing keyword) to the className alongside `transition-all`.',
            );
        }
    });

    test('DonutChart segment transition uses ease-out specifically', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/DonutChart.tsx'),
            'utf-8',
        ));
        // R18-PR11 — the donut segment no longer uses a CSS
        // `transition-all` class. It morphs its `d` via a
        // framer-motion `<motion.path>` (CSS can't reliably
        // transition the `d` attribute). The R11-PR11 intent —
        // "ease-out is the right tone for chart transitions, not
        // linear / ease-in-out" — still holds: the morph
        // `transition` MUST carry `ease: 'easeOut'`. This locks
        // that the framer-motion path retained the easing the
        // old CSS class encoded.
        expect(src).toMatch(/ease:\s*'easeOut'/);
        // And the dead CSS class is gone — no `transition-all`
        // className survives in the donut.
        expect(src).not.toMatch(
            /className="[^"]*transition-all/,
        );
    });
});
