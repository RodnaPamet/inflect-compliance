/**
 * RQ4-2 — `ArrowLeft` icon ratchet.
 *
 * The back affordance (RQ4-4) renders `<ArrowLeft />`. This ratchet locks
 * the icon's existence + key structural attributes so a future "simplify
 * the icon set" PR can't silently drop it.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ICON_PATH = path.resolve(
    __dirname,
    '../../src/components/ui/icons/nucleo/arrow-left.tsx',
);
const BARREL_PATH = path.resolve(
    __dirname,
    '../../src/components/ui/icons/nucleo/index.ts',
);

describe('rq4-2 arrow-left icon', () => {
    it('the icon file exists', () => {
        expect(fs.existsSync(ICON_PATH)).toBe(true);
    });

    it('exports a named `ArrowLeft` component', () => {
        const source = codeOf(fs.readFileSync(ICON_PATH, 'utf-8'));
        expect(source).toMatch(/export\s+function\s+ArrowLeft\b/);
    });

    it('renders an SVG that uses currentColor (matches design token theming)', () => {
        const source = codeOf(fs.readFileSync(ICON_PATH, 'utf-8'));
        expect(source).toMatch(/<svg/);
        expect(source).toMatch(/currentColor/);
        expect(source).toMatch(/strokeWidth="1\.5"/);
    });

    it('uses an 18x18 viewBox matching ChevronLeft and the rest of the nucleo set', () => {
        const source = codeOf(fs.readFileSync(ICON_PATH, 'utf-8'));
        expect(source).toMatch(/viewBox="0 0 18 18"/);
        expect(source).toMatch(/height="18"/);
        expect(source).toMatch(/width="18"/);
    });

    it('is re-exported from the nucleo barrel', () => {
        const barrel = codeOf(fs.readFileSync(BARREL_PATH, 'utf-8'));
        expect(barrel).toMatch(/export \* from "\.\/arrow-left";/);
    });
});
