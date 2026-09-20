/**
 * UI roadmap 24 — setup wizard colors.
 *
 * The wizard used `text-content-inverted` (light text for dark surfaces) on
 * light card/tint surfaces — headings, the active step-nav label, the framework
 * name, the risk-register label — rendering near-invisible in the light theme.
 * Those now use `text-content-emphasis`. `text-content-inverted` is only valid
 * on the brand/success-filled icon circles.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const SRC = codeOf(fs.readFileSync(
    path.resolve(__dirname, '../../src/components/onboarding/OnboardingWizard.tsx'),
    'utf8',
));

describe('UI-24 — setup wizard text colors', () => {
    it('Headings do not use text-content-inverted (light text on light cards)', () => {
        expect(SRC).not.toMatch(/<Heading[^>]*text-content-inverted/);
    });
    it('the active step-nav row uses emphasis text, not inverted', () => {
        expect(SRC).toMatch(/bg-brand-subtle text-content-emphasis/);
        expect(SRC).not.toMatch(/bg-brand-subtle text-content-inverted/);
    });
    it('text-content-inverted survives ONLY on the brand/success icon circles', () => {
        // Each remaining occurrence must be on an <Icon>/lucide glyph (w-… class),
        // never on a text/span/heading element.
        const lines = SRC.split('\n').filter((l) => l.includes('text-content-inverted'));
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) {
            expect(l).toMatch(/className=.*w-\d/); // an icon size class → it's a glyph
            expect(l).not.toMatch(/<span|<p\b|<Heading/);
        }
    });
});
