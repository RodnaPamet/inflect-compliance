/**
 * RQ4-2 — `ArrowLeft` icon ratchet.
 *
 * The back affordance (RQ4-4) renders `<ArrowLeft />`. This ratchet locks
 * the icon's existence + key structural attributes so a future "simplify
 * the icon set" PR can't silently drop it.
 *
 * Since #5772 the glyph is lucide-react's `ArrowLeft` under the local name,
 * in the `glyphs` set that replaced the Nucleo set (removed: its licence
 * prohibits redistribution, and this repository is public). The 18px default
 * size is what keeps it matching `ChevronLeft` and the rest of the set.
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
    '../../packages/ui/src/components/ui/icons/glyphs/arrow-left.tsx',
);
const CHEVRON_PATH = path.resolve(
    __dirname,
    '../../packages/ui/src/components/ui/icons/glyphs/chevron-left.tsx',
);
const BARREL_PATH = path.resolve(
    __dirname,
    '../../packages/ui/src/components/ui/icons/glyphs/index.ts',
);

describe('rq4-2 arrow-left icon', () => {
    it('the icon file exists', () => {
        expect(fs.existsSync(ICON_PATH)).toBe(true);
    });

    it('exports a named `ArrowLeft` component', () => {
        const source = codeOf(fs.readFileSync(ICON_PATH, 'utf-8'));
        expect(source).toMatch(/export\s+function\s+ArrowLeft\b/);
    });

    it('renders lucide-react ArrowLeft, which draws in currentColor', () => {
        const source = codeOf(fs.readFileSync(ICON_PATH, 'utf-8'));
        expect(source).toMatch(
            /import\s*\{\s*ArrowLeft\s+as\s+LucideArrowLeft\s*\}\s*from\s*["']lucide-react["']/,
        );
        expect(source).toMatch(/<LucideArrowLeft\b/);
    });

    it('defaults to 18px, matching ChevronLeft and the rest of the glyph set', () => {
        const source = codeOf(fs.readFileSync(ICON_PATH, 'utf-8'));
        expect(source).toMatch(/<LucideArrowLeft\s+size=\{18\}\s+\{\.\.\.props\}\s*\/>/);
        const chevron = codeOf(fs.readFileSync(CHEVRON_PATH, 'utf-8'));
        expect(chevron).toMatch(/<LucideChevronLeft\s+size=\{18\}\s+\{\.\.\.props\}\s*\/>/);
    });

    it('is re-exported from the glyph barrel', () => {
        const barrel = codeOf(fs.readFileSync(BARREL_PATH, 'utf-8'));
        expect(barrel).toMatch(/export \* from "\.\/arrow-left";/);
    });
});
