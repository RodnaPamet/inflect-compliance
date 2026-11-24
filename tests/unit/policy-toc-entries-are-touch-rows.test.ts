/**
 * On a touch screen each entry of a policy's Contents block is a 44px row
 * (#5924).
 *
 * The Contents block is built from the document's headings by
 * `enrichPolicyHtml` and styled by `.policy-content .policy-toc` in
 * `globals.css`: a list of links a line of text tall (19px), 4px apart. The
 * phone audit counted every entry as a tap target under 24px. A media query
 * cannot run in jsdom, so this reads the stylesheet's AST, parsed with the
 * same `postcss` the build uses, and asserts the rule a coarse pointer gets.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'postcss';
import type { Declaration, Node, Rule } from 'postcss';

const CSS = parse(fs.readFileSync(path.join(__dirname, '../../src/app/globals.css'), 'utf8'));

function enclosingMedia(node: Node): string[] {
    const out: string[] = [];
    for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'atrule' && (p as unknown as { name: string }).name === 'media') {
            out.push((p as unknown as { params: string }).params);
        }
    }
    return out;
}

function declarationsFor(selector: string, media: string): Record<string, string> {
    const decls: Record<string, string> = {};
    CSS.walkRules((rule: Rule) => {
        if (!rule.selectors.includes(selector)) return;
        if (!enclosingMedia(rule).includes(media)) return;
        rule.walkDecls((d: Declaration) => {
            decls[d.prop] = d.value;
        });
    });
    return decls;
}

describe('the policy Contents block on a coarse pointer', () => {
    it('makes each entry a row at least 44px tall', () => {
        const link = declarationsFor('.policy-content .policy-toc a', '(pointer: coarse)');
        expect(link['min-height']).toBe('2.75rem');
        // A box that can take a height: an inline link ignores min-height.
        expect(link.display).toBe('inline-flex');
    });

    it('drops the gap between entries, so the rows sit edge to edge rather than 52px apart', () => {
        expect(declarationsFor('.policy-content .policy-toc li', '(pointer: coarse)').margin).toBe('0');
    });

    it('leaves the desktop list as it was', () => {
        const atRest: Record<string, string> = {};
        CSS.walkRules((rule: Rule) => {
            if (!rule.selectors.includes('.policy-content .policy-toc a')) return;
            if (enclosingMedia(rule).length) return;
            rule.walkDecls((d) => {
                atRest[d.prop] = d.value;
            });
        });
        expect(atRest['min-height']).toBeUndefined();
        expect(atRest.display).toBeUndefined();
    });
});
