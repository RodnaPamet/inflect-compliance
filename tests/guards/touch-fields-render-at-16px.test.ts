/**
 * On a touch device every text field renders at 16px or more, so iOS Safari
 * does not zoom the page when one takes focus (#5812).
 *
 * WHY THIS READS CSS RATHER THAN RENDERING
 * ────────────────────────────────────────
 * The behaviour lives in a `@media (pointer: coarse)` rule, and jsdom neither
 * evaluates media queries nor computes cascaded font sizes — a rendered test
 * would pass with the rule deleted. So this reads `src/app/globals.css` as a
 * postcss AST (the same parser the build uses, not a regex) and asserts the
 * three properties that make the rule work:
 *
 *   1. it is inside `@media (pointer: coarse)` and nothing narrower, so it
 *      applies to every touch device and to no mouse-driven desktop;
 *   2. it covers input, select, textarea and contenteditable editors;
 *   3. it is UNLAYERED. Tailwind v4 emits `text-sm` / `text-xs` inside
 *      `@layer utilities`, and an unlayered rule beats a layered one before
 *      specificity is compared. Moved into a layer, `text-sm` on `<Input>`
 *      would win again and every field would be back to 14px.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'postcss';
import type { AtRule, Declaration, Node, Rule } from 'postcss';

const CSS = fs.readFileSync(path.resolve(__dirname, '../../src/app/globals.css'), 'utf8');

function enclosingAtRules(node: Node): AtRule[] {
    const out: AtRule[] = [];
    for (let p = node.parent; p && p.type !== 'root'; p = p.parent as Node['parent']) {
        if (p.type === 'atrule') out.unshift(p as AtRule);
    }
    return out;
}

function px(value: string): number | null {
    const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
    if (!m) return null;
    return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}

/** Every rule that sets a font size of at least 16px. */
function sixteenPxRules(): Rule[] {
    const rules: Rule[] = [];
    parse(CSS).walkRules((rule) => {
        const size = rule.nodes.find(
            (n): n is Declaration => n.type === 'decl' && n.prop === 'font-size',
        );
        const value = size ? px(size.value) : null;
        if (value !== null && value >= 16) rules.push(rule);
    });
    return rules;
}

const REQUIRED_SELECTORS = ['input', 'select', 'textarea'];

describe('touch fields render at 16px', () => {
    const candidates = sixteenPxRules().filter((rule) =>
        REQUIRED_SELECTORS.every((s) => rule.selectors.map((x) => x.trim()).includes(s)),
    );

    it('one rule sets input, select and textarea to at least 16px', () => {
        expect(candidates).toHaveLength(1);
    });

    const rule = candidates[0];

    it('also covers contenteditable rich-text editors', () => {
        expect(rule.selectors.some((s) => s.includes('[contenteditable]'))).toBe(true);
    });

    it('applies to touch devices only, so desktop sizes do not change', () => {
        const atRules = enclosingAtRules(rule).map((a) => `@${a.name} ${a.params}`);
        expect(atRules).toEqual(['@media (pointer: coarse)']);
    });

    it('is unlayered, so it beats the text-sm / text-xs utilities', () => {
        expect(enclosingAtRules(rule).some((a) => a.name === 'layer')).toBe(false);
    });

    it('stays an element selector, so a third-party editor that sizes its own field by class keeps its size', () => {
        for (const s of rule.selectors) {
            expect(s.trim()).not.toMatch(/(^|[\s>+~])\./);
        }
        expect(rule.nodes.some((n) => n.type === 'decl' && n.important)).toBe(false);
    });
});
