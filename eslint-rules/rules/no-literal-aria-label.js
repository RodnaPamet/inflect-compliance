'use strict';

/**
 * An `aria-label` is read from the message catalogue, never written as a
 * literal in the markup.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * An accessible name is UI text a screen reader speaks. Written as a literal
 * it is English on a Bulgarian page, and nothing on screen shows it: the
 * mobile re-audit of 2026-11-23 found `aria-label="Next review date"` on the
 * new-risk date picker only because its harness reads accessible names
 * (#5884). It was the last one in the app; this keeps it the last.
 *
 * The remedy is the translator: `aria-label={t('…')}`, with the key in both
 * `messages/en.json` and `messages/bg.json`.
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * A JSX `aria-label` whose value is a string literal (`"…"`, `{'…'}`, or a
 * template literal with no expressions) containing a letter in any script.
 * A literal with no letter — a dash, an arrow, a digit — names nothing in a
 * language and is left alone, as is any computed value. A DOM call
 * (`setAttribute('aria-label', …)`) is not JSX and is not seen.
 */

const HAS_LETTER = /\p{L}/u;

function literalValue(attr) {
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
            description: 'Disallow a literal aria-label in JSX; read accessible names from the message catalogue.',
        },
        schema: [],
        messages: {
            literal:
                'aria-label "{{value}}" is a literal, so it is the same words in every language. Read it from the message catalogue: aria-label={t(\'…\')}.',
        },
    },
    create(context) {
        return {
            JSXAttribute(node) {
                if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'aria-label') return;
                const value = literalValue(node);
                if (value === null || !HAS_LETTER.test(value)) return;
                context.report({ node, messageId: 'literal', data: { value } });
            },
        };
    },
};
