'use strict';

/**
 * A focus indicator in the shared UI is drawn SOLID — no opacity modifier.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * WCAG 1.4.11 asks 3:1 of a focus indicator against what is next to it. A
 * translucent ring has no ratio of its own: it blends with whatever surface it
 * lands on, so the number moves with the card, the page and the theme. The row
 * rings in `table.tsx`, `virtual-table-body.tsx` and `data-table-cards.tsx`
 * were the accent at `/40`. That measured about 1.7:1 on Inflect's light card,
 * about 2.2:1 on its dark one, and 2.8:1 on playerz.bg's midnight card. Every
 * one of those is under the floor, while each theme's solid accent clears it
 * (4.18:1, 7.26:1, 12.02:1). Nothing failed, because no test measured a ring
 * at an alpha.
 *
 * The colour a focus indicator is drawn in is a token's job (`--accent-*`,
 * `--ring`, `--focus-ring`), and the token is measured. An opacity modifier
 * written at the call site quietly opts out of that measurement.
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * The same strings and the same focus-variant class tokens as
 * `no-brand-focus-indicator`: a `focus:` / `focus-visible:` / `focus-within:`
 * (also `group-` / `peer-`, stacked) ring, ring-offset, shadow, outline or
 * border utility whose value carries an opacity modifier — `/40`, `/[0.4]` —
 * on a named colour or an arbitrary value. `ring-[var(--accent-default)]/40`
 * and `ring-border-error/50` are flagged; `ring-2`, `ring-offset-2` and a solid
 * `ring-[var(--accent-default)]` are not.
 *
 * ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────
 *
 * Alpha INSIDE a value (`shadow-[0_0_0_3px_rgba(…,0.2)]`, or a token whose
 * value is itself translucent, such as `--ring` on Inflect's dark theme). Those
 * are token or value decisions, and a contrast test has to read the value to
 * judge them. This rule polices the modifier, the one form that hides from that.
 */

/** A variant (one `x:` link of the chain) that means "this element is focused". */
const FOCUS_VARIANT = /^(?:group-|peer-)?focus(?:-visible|-within)?(?:\/[\w-]+)?$/;

/** The utilities that draw a focus indicator. */
const INDICATOR_UTILITY = /^-?(?:ring(?:-offset)?|shadow|outline|border(?:-[a-z]{1,2})?)-(.+)$/;

/** A colour value with an opacity modifier: `name/40`, `[…]/40`, `[…]/[0.4]`. */
const TRANSLUCENT_VALUE = /^(?:\[[^\]]*\]|[a-z][\w.-]*)\/(?:\d+(?:\.\d+)?|\[[^\]]+\])$/;

/** Split a class token on the `:` separators that sit outside square brackets. */
function splitClass(token) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < token.length; i++) {
        const ch = token[i];
        if (ch === '[') depth++;
        else if (ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === ':' && depth === 0) {
            parts.push(token.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(token.slice(start));
    return { variants: parts.slice(0, -1), utility: parts[parts.length - 1] };
}

/** The offending class, or null. */
function translucentFocusClass(token) {
    const { variants, utility } = splitClass(token);
    if (!variants.some((v) => FOCUS_VARIANT.test(v))) return null;
    const bare = utility.replace(/^!/, '').replace(/!$/, '');
    const m = INDICATOR_UTILITY.exec(bare);
    if (!m) return null;
    return TRANSLUCENT_VALUE.test(m[1]) ? token : null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'A focus indicator is drawn solid: no opacity modifier on its ring, shadow, outline or border colour',
        },
        schema: [],
        messages: {
            translucentFocus:
                '"{{cls}}" draws a focus indicator at partial opacity, so its contrast depends on the surface ' +
                'beneath it. At /40 the row rings measured 1.7:1 to 2.8:1 against the 3:1 WCAG 1.4.11 asks. ' +
                'Draw it solid (ring-[var(--accent-default)]), and change the TOKEN if the colour is too strong.',
        },
    },

    create(context) {
        function check(node, text) {
            if (typeof text !== 'string' || !text.includes('focus')) return;
            for (const token of text.split(/\s+/)) {
                if (!token) continue;
                const cls = translucentFocusClass(token);
                if (cls) context.report({ node, messageId: 'translucentFocus', data: { cls } });
            }
        }

        return {
            Literal(node) {
                check(node, node.value);
            },
            TemplateElement(node) {
                check(node, node.value.cooked);
            },
        };
    },
};
