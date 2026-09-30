/**
 * THE TWO TOKENS THAT EXIST BECAUSE OF A CONTRAST FLOOR (T01, #3014).
 *
 * `--content-brand` and `--border-strong` are not new shades for their own sake.
 * Each exists because the token a developer would otherwise reach for does not
 * meet WCAG:
 *
 *   · brand FILL tokens rendered as TEXT — `--brand-default` on light is
 *     #D04A02, which is 4.03:1 on `--bg-page`. Below the 4.5:1 AA minimum for
 *     body text (1.4.3). Brand-coloured text on light was already failing.
 *   · form-control EDGES — 1.4.11 asks 3:1 of a control boundary, and neither
 *     `--border-default` (1.74:1 dark) nor `--border-emphasis` (2.44:1 dark,
 *     1.59:1 light) reaches it on `--bg-default`.
 *
 * So the RATIO is the contract, not the hex. This computes it from the real
 * declarations rather than trusting a number in a comment — a comment cannot
 * fail when somebody edits the value beside it, and the only reason these
 * tokens exist is the floor they clear.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Comments STRIPPED before anything is matched.
 *
 * Not defensive tidying — the first version of this file counted three
 * `--bg-default` declarations because the light block contains the prose
 * "cream surface (`--bg-default: #FAF7F2`) has lower contrast". A ratio
 * assertion reading that would have measured a colour mentioned in a sentence,
 * and reported a pass or a failure about nothing. The population control below
 * is what caught it.
 */
const CSS = fs
    .readFileSync(path.join(process.cwd(), 'src/styles/tokens.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * The value of `name` inside the Nth block that declares it.
 *
 * `tokens.css` declares the dark palette on bare `:root` and overrides it in the
 * light block, so the SAME token name appears twice and order distinguishes
 * them. Reading "the first match" would silently test the dark value twice.
 */
function tokenValues(name: string): string[] {
    // Anchored to a line start so only a real declaration matches.
    const re = new RegExp(`^\\s*--${name}:\\s*(#[0-9A-Fa-f]{6})`, 'gm');
    return [...CSS.matchAll(re)].map((m) => m[1]);
}

const DARK = 0;
const LIGHT = 1;

describe('the tokens exist to clear a floor, so the floor is what is asserted', () => {
    it('declares each token in BOTH themes — the population control', () => {
        // Without this, every ratio assertion below could be satisfied by a
        // single dark declaration while the light theme had none.
        expect(tokenValues('content-brand')).toHaveLength(2);
        expect(tokenValues('border-strong')).toHaveLength(2);
        expect(tokenValues('bg-page')).toHaveLength(2);
        expect(tokenValues('bg-default')).toHaveLength(2);
    });

    it.each([
        ['dark', DARK],
        ['light', LIGHT],
    ])('--content-brand is AA text (>= 4.5:1) on both grounds in the %s theme', (_t, i) => {
        const brand = tokenValues('content-brand')[i];
        expect(contrast(brand, tokenValues('bg-page')[i])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(brand, tokenValues('bg-default')[i])).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
        ['dark', DARK],
        ['light', LIGHT],
    ])('--border-strong is a AA control edge (>= 3:1) in the %s theme', (_t, i) => {
        expect(
            contrast(tokenValues('border-strong')[i], tokenValues('bg-default')[i]),
        ).toBeGreaterThanOrEqual(3);
    });

    it('and the tokens it replaces really do fall short — why they exist at all', () => {
        // The negative control. If `--brand-default` and `--border-emphasis` had
        // passed, these two tokens would be duplication rather than a fix, and
        // every assertion above would still be green.
        const brandFill = tokenValues('brand-default')[LIGHT];
        expect(contrast(brandFill, tokenValues('bg-page')[LIGHT])).toBeLessThan(4.5);

        const emphasis = tokenValues('border-emphasis')[DARK];
        expect(contrast(emphasis, tokenValues('bg-default')[DARK])).toBeLessThan(3);
    });
});
