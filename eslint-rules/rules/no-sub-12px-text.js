'use strict';

/**
 * `local/no-sub-12px-text` — no Tailwind font size under 12 px.
 *
 * Owner decision (2026-11-23, epic #5868): small text is 12 px everywhere,
 * desktop included. The type scale's floor is `text-xs` (12 px). The text a
 * phone could not read was never the scale's: it was an ARBITRARY size
 * written beside it — `text-[10px]` on a provenance line, `text-[11px]` on an
 * eyebrow, `text-[0.625rem]` on a filter count — 148 of them when the first
 * whole-product audit counted text under 12 px on 11 pages (#5924).
 *
 * This refuses an arbitrary font size under 12 px in any string a class list
 * can be built from: a JSX attribute, a `cn(...)` / `cva(...)` argument, a
 * constant, a template literal. It reads every whitespace-separated token,
 * so a variant (`md:`, `pointer-coarse:`, `[&_kbd]:`) or the important mark
 * (`!`) does not hide one:
 *
 *   text-[10px]  md:text-[11px]  [&_x]:text-[0.625rem]  !text-[9px]
 *
 * px under 12, and rem/em under 0.75 (12 px at the 16 px root), are refused.
 * `text-[0.76rem]` (12.16 px) and every named size pass. A colour
 * (`text-[var(--x)]`, `text-[#fff]`) is not a size and is not read.
 *
 * SVG chart text (`fontSize={10}` on a `<text>`) is not a class and is not
 * this rule's business: the phone audit measures HTML text, and a chart's
 * values are listed beside it on a phone (docs/charts.md, "Touch").
 */

const SIZE = /(?:^|:)!?text-\[(\d*\.?\d+)(px|rem|em)\]!?$/;

function tooSmall(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    return unit === 'px' ? n < 12 : n < 0.75;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Refuse a Tailwind font size under 12 px (the small-text floor is text-xs).',
        },
        schema: [],
        messages: {
            subTwelve:
                '`{{token}}` sets text under 12 px. Small text is 12 px everywhere (owner decision, 2026-11-23): use `text-xs`.',
        },
    },
    create(context) {
        function check(node, raw) {
            if (typeof raw !== 'string' || !raw.includes('text-[')) return;
            for (const token of raw.split(/\s+/)) {
                const m = SIZE.exec(token);
                if (m && tooSmall(m[1], m[2])) {
                    context.report({ node, messageId: 'subTwelve', data: { token } });
                }
            }
        }
        return {
            Literal(node) {
                check(node, node.value);
            },
            TemplateElement(node) {
                check(node, node.value && node.value.cooked);
            },
        };
    },
};
