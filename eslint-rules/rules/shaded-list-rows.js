'use strict';

/**
 * A boxed list row draws its box from `<ShadedRow>`, not a hand-rolled class.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * Owner request, 2026-11-22: every card that lists two or more boxed rows
 * draws each row as its own SHADED box, through one shared style, with the
 * same look as the detail-page tab bar (`--bg-shaded` and the strong outline).
 * Before it, ~60 sites each wrote their own `rounded-lg border
 * border-border-subtle p-3`: a faint outline and no shade, which did not tell
 * one row from the next on either theme. `src/components/ui/shaded-row.tsx`
 * is the one style now; this rule keeps the next row from being hand-rolled
 * again, because a hand-rolled row LOOKS fine in review — it is only wrong
 * next to its neighbours.
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * An intrinsic `li`, `div`, `section` or `article` whose `className` is a
 * NEUTRAL BOX — a `rounded` / `rounded-{sm,md,lg,xl,2xl,[…]}` radius, a bare
 * `border`, and a neutral border tone (`border-border-subtle` or
 * `border-border-default`, with or without an opacity) — and which is a ROW:
 *
 *   - it is an `<li>`, anywhere (an `li` exists only in a list); or
 *   - it is what a `.map(…)` / `.flatMap(…)` callback returns, directly, from
 *     an arrow body, a `return`, or a branch of a ternary / `&&`.
 *
 * The class is read from a string, a template literal, a `cn()` / `clsx()` /
 * `cx()` call, string concatenation, and a ternary or `&&` between those.
 *
 * NOT flagged, on purpose — these are the exclusions the owner's request did
 * not reach, and each needs a `valid` test case:
 *
 *   - a box that carries a STATE: a `hover:` / `focus:` / `active:` / `aria-` /
 *     `data-` / `group-` variant, a `ring`, or a state tone
 *     (`border-border-emphasis|strong|error|warning|success|info|attention|danger`,
 *     `bg-bg-error|warning|success|info|attention|…-emphasis`). The shade says
 *     "one of a set"; a state says "this one is different";
 *   - a chip (`inline-flex` / `inline-block`), a pill (`rounded-full`) and a
 *     loading skeleton (`animate-pulse`): not rows;
 *   - a map root inside a `grid` container: tiles, not rows;
 *   - a `className` with a part the rule cannot read (an identifier, a member,
 *     any other call): that part may be a tone, so it is left alone.
 *
 * ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────
 *
 * A row rendered by its own component whose root is a `div` (an `li` root is
 * seen), a class held in a constant, and a box built with `cardVariants`. A
 * green run proves the visible shape is absent, not that every row in the tree
 * is shaded.
 */

const ROW_TAGS = new Set(['li', 'div', 'section', 'article']);
const MAP_METHODS = new Set(['map', 'flatMap']);
const CLASS_HELPERS = new Set(['cn', 'clsx', 'cx', 'classNames']);

const RADIUS = /^rounded(?:-(?:sm|md|lg|xl|2xl|3xl|\[[^\]]+\]))?$/;
const NEUTRAL_TONE = /^border-border-(?:subtle|default)(?:\/\d+)?$/;
const STATE_VARIANT = /^(?:[\w-]+:)*(?:hover|focus|focus-visible|focus-within|active|group-[\w-]+|peer-[\w-]+|aria-[^:]+|data-[^:]+):/;
const STATE_TONE =
    /^(?:border-border-(?:emphasis|strong|error|warning|success|info|attention|danger)|bg-bg-(?:error|warning|success|info|attention)|bg-bg-[\w-]+-emphasis|ring(?:-.*)?)(?:\/\d+)?$/;
const NOT_A_ROW = new Set(['inline-flex', 'inline-block', 'rounded-full', 'animate-pulse']);

/**
 * The class tokens a `className` value can hold, or `null` when part of it is
 * an expression the rule cannot read.
 */
function classTokens(node) {
    if (!node) return [];
    switch (node.type) {
        case 'Literal':
            return typeof node.value === 'string' ? node.value.split(/\s+/).filter(Boolean) : [];
        case 'JSXExpressionContainer':
            return classTokens(node.expression);
        case 'TemplateLiteral': {
            const out = [];
            for (const q of node.quasis) out.push(...q.value.cooked.split(/\s+/).filter(Boolean));
            for (const e of node.expressions) {
                const t = classTokens(e);
                if (t === null) return null;
                out.push(...t);
            }
            return out;
        }
        case 'ConditionalExpression': {
            const a = classTokens(node.consequent);
            const b = classTokens(node.alternate);
            return a === null || b === null ? null : [...a, ...b];
        }
        case 'LogicalExpression':
            return classTokens(node.right);
        case 'BinaryExpression': {
            if (node.operator !== '+') return null;
            const a = classTokens(node.left);
            const b = classTokens(node.right);
            return a === null || b === null ? null : [...a, ...b];
        }
        case 'CallExpression': {
            if (node.callee.type !== 'Identifier' || !CLASS_HELPERS.has(node.callee.name)) return null;
            const out = [];
            for (const arg of node.arguments) {
                const t = classTokens(arg);
                if (t === null) return null;
                out.push(...t);
            }
            return out;
        }
        default:
            return null;
    }
}

function isNeutralBox(tokens) {
    if (!tokens.some((t) => RADIUS.test(t))) return false;
    if (!tokens.includes('border')) return false;
    if (!tokens.some((t) => NEUTRAL_TONE.test(t))) return false;
    if (tokens.some((t) => NOT_A_ROW.has(t))) return false;
    if (tokens.some((t) => STATE_VARIANT.test(t) || STATE_TONE.test(t))) return false;
    return true;
}

function classNameAttr(opening) {
    return opening.attributes.find(
        (a) => a.type === 'JSXAttribute' && a.name && a.name.name === 'className',
    );
}

const PASS_THROUGH = new Set(['ConditionalExpression', 'LogicalExpression']);
const STATEMENT_PASS_THROUGH = new Set([
    'BlockStatement',
    'IfStatement',
    'SwitchCase',
    'SwitchStatement',
    'TryStatement',
]);

/** The `.map(...)` call whose callback returns `element` as its root, or null. */
function mapCallReturning(element) {
    let node = element;
    let parent = node.parent;
    while (parent && PASS_THROUGH.has(parent.type) && parent.test !== node && parent.left !== node) {
        node = parent;
        parent = node.parent;
    }
    let fn = null;
    if (parent && parent.type === 'ArrowFunctionExpression' && parent.body === node) {
        fn = parent;
    } else if (parent && parent.type === 'ReturnStatement') {
        let p = parent.parent;
        while (p && STATEMENT_PASS_THROUGH.has(p.type)) p = p.parent;
        if (p && (p.type === 'ArrowFunctionExpression' || p.type === 'FunctionExpression')) fn = p;
    }
    if (!fn) return null;
    const call = fn.parent;
    if (
        call &&
        call.type === 'CallExpression' &&
        call.arguments[0] === fn &&
        call.callee.type === 'MemberExpression' &&
        !call.callee.computed &&
        MAP_METHODS.has(call.callee.property.name)
    ) {
        return call;
    }
    return null;
}

/** The nearest enclosing JSX element of `node`, excluding `node` itself. */
function enclosingElement(node) {
    let p = node.parent;
    while (p && p.type !== 'JSXElement') p = p.parent;
    return p;
}

function isGridContainer(element) {
    if (!element) return false;
    const attr = classNameAttr(element.openingElement);
    if (!attr) return false;
    const tokens = classTokens(attr.value);
    return Array.isArray(tokens) && tokens.some((t) => /^(?:[\w-]+:)*grid$/.test(t));
}

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'A boxed list row draws its box from <ShadedRow> (@/components/ui/shaded-row), not a hand-rolled class',
        },
        schema: [],
        messages: {
            handRolledRow:
                'A boxed list row is a <ShadedRow> from @/components/ui/shaded-row (owner request 2026-11-22: ' +
                'each row its own shaded box, the tab bar\'s shade and strong outline), not a hand-rolled ' +
                '`rounded border border-border-{{tone}}` class. A row that carries a state keeps its own tone; ' +
                'see eslint-rules/rules/shaded-list-rows.js.',
        },
    },
    create(context) {
        return {
            JSXElement(element) {
                const opening = element.openingElement;
                if (opening.name.type !== 'JSXIdentifier') return;
                const tag = opening.name.name;
                if (!ROW_TAGS.has(tag)) return;
                const attr = classNameAttr(opening);
                if (!attr || !attr.value) return;
                const tokens = classTokens(attr.value);
                if (tokens === null || !isNeutralBox(tokens)) return;

                const call = mapCallReturning(element);
                if (tag !== 'li' && !call) return;
                if (call && isGridContainer(enclosingElement(call))) return;

                const tone = tokens.find((t) => NEUTRAL_TONE.test(t)).replace(/^border-border-/, '').replace(/\/\d+$/, '');
                context.report({ node: opening, messageId: 'handRolledRow', data: { tone } });
            },
        };
    },
};
