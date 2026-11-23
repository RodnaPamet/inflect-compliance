'use strict';

/**
 * An app page draws a checkbox, a radio or a range with the shared
 * primitives, never with a native `<input>`.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * The mobile re-audit of 2026-11-23 found native checkboxes, radios and
 * ranges on six pages, each 13-16px: too small to tap, painted by the
 * browser rather than the theme, and different from every other choice in
 * the product. The primitives fix all three at once:
 *
 *   - `<Checkbox>` (`@/components/ui/checkbox`) and `<RadioGroup>` +
 *     `<RadioGroupItem>` (`@/components/ui/radio-group`) render
 *     `role="checkbox"` / `role="radio"`, which `globals.css` gives a 44px
 *     hit area on a touch screen, and paint with the semantic tokens;
 *   - `<Slider>` (`@/components/ui/slider`) has a 26px thumb with the shared
 *     44px touch hit area, and the keyboard contract of a native range.
 *
 * Put the control in a `<label>` with its words, so the whole row answers a
 * tap (`<ShadedRow as="label">` for an option card).
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * A JSX `<input>` whose `type` is the literal `checkbox`, `radio` or `range`,
 * written as a string or as a string in braces (`type={'radio'}`), in any
 * letter case. A `type` the rule cannot read (`type={kind}`) is left alone,
 * and so is an `<input>` built with `createElement`. A green run proves the
 * literal shape is absent, not that no native choice control renders.
 */

const BANNED = new Map([
    ['checkbox', 'Checkbox from @/components/ui/checkbox'],
    ['radio', 'RadioGroup + RadioGroupItem from @/components/ui/radio-group'],
    ['range', 'Slider from @/components/ui/slider'],
]);

function literalType(attr) {
    const v = attr.value;
    if (!v) return null;
    if (v.type === 'Literal' && typeof v.value === 'string') return v.value;
    if (v.type === 'JSXExpressionContainer') {
        const e = v.expression;
        if (e.type === 'Literal' && typeof e.value === 'string') return e.value;
        if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return e.quasis[0].value.cooked;
    }
    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow native checkbox / radio / range inputs in app pages; use the Checkbox, RadioGroup and Slider primitives.',
        },
        schema: [],
        messages: {
            nativeChoice:
                'A native <input type="{{type}}"> is a 13-16px target painted by the browser. Use {{remedy}}, in a <label> with its words.',
        },
    },
    create(context) {
        return {
            JSXOpeningElement(node) {
                if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'input') return;
                for (const attr of node.attributes) {
                    if (attr.type !== 'JSXAttribute' || attr.name.name !== 'type') continue;
                    const raw = literalType(attr);
                    if (raw === null) continue;
                    const type = raw.trim().toLowerCase();
                    const remedy = BANNED.get(type);
                    if (remedy) {
                        context.report({ node: attr, messageId: 'nativeChoice', data: { type, remedy } });
                    }
                }
            },
        };
    },
};
