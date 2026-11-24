'use strict';

/**
 * An icon is spaced by its container's gap, never pulled with a negative margin.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * Thirty-one create buttons carried `<Plus className="-ml-0.5 -mr-2.5" />`.
 * The `<Button>` primitive already spaces its `icon` slot from the label with
 * `gap-tight` (8 px); the `-mr-2.5` (-10 px) cancelled that gap and then some,
 * so the glyph touched the first letter: "+Одит", "+Доказателство" (#5880).
 * The margin was a leftover from a layout that no longer exists, copied from
 * one button to the next because it looked deliberate. Nothing on the page
 * says it is wrong until you read the label closely, on a phone, in Bulgarian.
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * A JSX element whose name is bound by an import from an ICON module —
 * `lucide-react`, or any specifier with an `icons` path segment
 * (`@inflect/ui/components/ui/icons/glyphs`, `…/icons/glyphs/plus`,
 * `@/components/icons/AppIcon`) — whose `className` contains a negative
 * margin utility: `-m-`, `-mx-`, `-my-`, `-mt-`, `-mr-`, `-mb-`, `-ml-`,
 * `-ms-`, `-me-`, with or without variant prefixes (`md:-ml-1`) and an
 * important marker (`!-ml-1`, `-ml-1!`).
 *
 * The class is read from a string, a template literal's static parts, a
 * `cn()` / `clsx()` / `cx()` / `classNames()` call, string concatenation, and
 * a ternary or `&&` between those.
 *
 * NOT flagged, on purpose (each has a `valid` case):
 *
 *   - a positive margin (`ml-1`, `mr-2`) and a negative non-margin utility
 *     (`-translate-y-px`, `-rotate-90`, `-mt` on a non-icon `<div>`);
 *   - a component not imported from an icon module, even one named `Plus`;
 *   - a class part the rule cannot read (an identifier, a member, any other
 *     call): it may be anything, so it is left alone.
 *
 * ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────
 *
 * An icon re-exported through a module with no `icons` segment, a class held
 * in a constant, and an icon wrapped in a span that carries the margin. A
 * green run proves the visible shape is absent, not that every glyph in the
 * tree is spaced by a gap.
 */

const CLASS_HELPERS = new Set(['cn', 'clsx', 'cx', 'classNames']);

// `[variant:]*[!]-m{,x,y,t,r,b,l,s,e}-<value>[!]`
const NEGATIVE_MARGIN = /^(?:[\w\[\]&>*:=.\-/]+:)?!?-m[xytrblse]?-[^\s]+$/;

function isIconSource(source) {
    if (typeof source !== 'string') return false;
    if (source === 'lucide-react' || source.startsWith('lucide-react/')) return true;
    return source.split('/').includes('icons');
}

/** Collect the statically readable class strings of an expression. */
function classStrings(node, out) {
    if (!node) return;
    switch (node.type) {
        case 'Literal':
            if (typeof node.value === 'string') out.push(node.value);
            return;
        case 'TemplateLiteral':
            for (const q of node.quasis) out.push(q.value.cooked ?? q.value.raw);
            for (const e of node.expressions) classStrings(e, out);
            return;
        case 'JSXExpressionContainer':
            classStrings(node.expression, out);
            return;
        case 'ConditionalExpression':
            classStrings(node.consequent, out);
            classStrings(node.alternate, out);
            return;
        case 'LogicalExpression':
            classStrings(node.right, out);
            if (node.operator !== '&&') classStrings(node.left, out);
            return;
        case 'BinaryExpression':
            if (node.operator === '+') {
                classStrings(node.left, out);
                classStrings(node.right, out);
            }
            return;
        case 'CallExpression':
            if (node.callee.type === 'Identifier' && CLASS_HELPERS.has(node.callee.name)) {
                for (const a of node.arguments) classStrings(a, out);
            }
            return;
        case 'ArrayExpression':
            for (const el of node.elements) classStrings(el, out);
            return;
        default:
            return;
    }
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Refuse a negative margin on an icon; the container gap (e.g. the Button icon slot) spaces it.',
        },
        schema: [],
        messages: {
            negativeMarginIcon:
                '`{{icon}}` carries the negative margin `{{cls}}`. An icon is spaced by its container — pass it through `<Button icon={…}>` (which sets `gap-tight`) and drop the margin. A negative margin glues the glyph to its label (#5880).',
        },
    },

    create(context) {
        const iconNames = new Set();
        return {
            ImportDeclaration(node) {
                if (!isIconSource(node.source.value)) return;
                for (const spec of node.specifiers) iconNames.add(spec.local.name);
            },
            JSXOpeningElement(node) {
                if (node.name.type !== 'JSXIdentifier') return;
                const name = node.name.name;
                if (!iconNames.has(name)) return;
                for (const attr of node.attributes) {
                    if (attr.type !== 'JSXAttribute' || !attr.value) continue;
                    if (attr.name.type !== 'JSXIdentifier' || attr.name.name !== 'className') continue;
                    const strings = [];
                    classStrings(attr.value, strings);
                    for (const s of strings) {
                        for (const cls of s.split(/\s+/)) {
                            if (cls && NEGATIVE_MARGIN.test(cls)) {
                                context.report({
                                    node: attr,
                                    messageId: 'negativeMarginIcon',
                                    data: { icon: name, cls },
                                });
                                return;
                            }
                        }
                    }
                }
            },
        };
    },
};
