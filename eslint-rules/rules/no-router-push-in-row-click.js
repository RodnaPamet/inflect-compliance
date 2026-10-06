'use strict';

/**
 * A row-activation handler navigates through `useGuardedPush`, not `router.push`.
 *
 * ── THE DEFECT (#3099, upstream vercel/next.js#99651) ────────────────────
 *
 * A cold row click during the hydration window issues its RSC request, gets a
 * 200, loads the destination's page chunk — and then the client router silently
 * does nothing. Measured on three independent captures: zero requests started
 * more than 1000 ms after the click, zero `console.error`, no document
 * navigation, no retry, and the URL unchanged (which is mechanical proof the
 * React transition never committed — `HistoryUpdater` is keyed on the router
 * state). The row is dead until the user clicks again.
 *
 * `src/lib/nav/use-guarded-push.ts` is the workaround: it samples
 * `location.pathname` at click time and re-issues the push once if the pathname
 * has not moved and the target differs from it. It also emits the only counter
 * this app has for how often the defect hits real users.
 *
 * ── WHY A LINT RULE RATHER THAN A CHOKE POINT ────────────────────────────
 *
 * `onRowClick` is typed `(row, e) => void`, and `DataTable` cannot tell a
 * navigation from a sheet-opener or a selection toggle — several live call sites
 * are exactly those. So there is nothing to put the fix behind: the seam has to
 * be a hook each navigating call site opts into, and a hook nobody is obliged
 * to use is a hook the eighteenth list page will forget. This is the obligation.
 *
 * CLAUDE.md asks for an ESLint rule rather than a `tests/guards/` regex when the
 * thing being policed is syntax. It is: a call expression at a position. A regex
 * over source text would be defeated by the handler being named
 * (`onRowClick={handleAssetRowClick}` — eleven of the eighteen migrated sites),
 * by a `useCallback` wrapper, and by a doc comment that merely mentions
 * `router.push` (this file has several).
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * The handler assigned to a row-activation prop, whether written inline, passed
 * by name and resolved through scope, wrapped in `useCallback`, or chosen by a
 * ternary — then any `router.push` / `router.replace` anywhere inside it,
 * including inside a nested callback.
 *
 * "Is this a router?" is answered two ways, both narrow: the object resolves
 * through scope to a `useRouter()` initialiser, or it is literally named
 * `router`. `someOtherThing.push(x)` is not flagged.
 *
 * ── WHAT IT CANNOT SEE, AND HOW THAT IS NOT HIDDEN ───────────────────────
 *
 * No data-flow analysis. A handler imported from another module, taken as a
 * prop, or produced by a helper call is opaque — the rule cannot open it. Those
 * positions are COUNTED rather than passed over: `{ reportUnanalysable: true }`
 * reports each under its own messageId, and
 * `tests/guards/row-click-navigation-uses-the-guarded-push.test.ts` holds the
 * set. `{ reportRowClicks: true }` reports every row-activation prop the rule
 * recognised, so that guard can floor the DENOMINATOR — "zero violations" and
 * "zero handlers found" are otherwise the same output, and only one of them
 * means anything. Both options are OFF in `eslint.config.mjs`; they report
 * facts, not findings.
 *
 * `onRowAuxClick` is deliberately NOT policed. A middle click opens a new tab
 * through `window.open` or an `<a target>`, which never enters the client
 * router, so the defect cannot reach it.
 */

/** Row ACTIVATION props — a primary or double click that opens the row. */
const ROW_ACTIVATION_PROPS = new Set(['onRowClick', 'onRowDoubleClick']);

/** The client-router methods that start a soft navigation. */
const NAVIGATING_METHODS = new Set(['push', 'replace']);

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Row-activation handlers navigate through useGuardedPush(), not router.push()',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    /**
                     * Repo-relative path fragments whose row handlers may call the
                     * raw router. EMPTY on main, and the empty list is the claim:
                     * all eighteen migrated call sites went through the hook with
                     * none needing an escape. Adding an entry is a decision — say
                     * in the same diff why that call site cannot tolerate a
                     * retry, because "it already worked" is not a reason (every
                     * one of the eighteen already worked, except under load).
                     */
                    allowRawPush: { type: 'array', items: { type: 'string' } },
                    /** Census: report handlers the rule could not open. */
                    reportUnanalysable: { type: 'boolean' },
                    /** Census: report every row-activation prop recognised. */
                    reportRowClicks: { type: 'boolean' },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            rawRouterPush:
                'A `{{prop}}` handler must navigate through `useGuardedPush()` from ' +
                '@/lib/nav/use-guarded-push, not `router.{{method}}()` directly. A cold row ' +
                "click during hydration gets its 200 and then the client router silently drops " +
                'the transition (#3099) — the hook notices and re-issues it once, and counts it.',
            unanalysableHandler:
                'census: `{{prop}}` handler could not be opened by this rule ({{kind}}).',
            rowActivationSeen: 'census: `{{prop}}` handler recognised.',
        },
    },

    create(context) {
        const options = context.options[0] || {};
        const allowRawPush = options.allowRawPush || [];
        const filename = (context.filename ?? context.getFilename()) || '';
        const normalized = filename.split('\\').join('/');
        if (allowRawPush.some((frag) => normalized.includes(frag))) return {};

        const sourceCode = context.sourceCode ?? context.getSourceCode();

        /** Every `router.push(...)` / `router.replace(...)` call in the file. */
        const navigatingCalls = [];
        /** `{ prop, expression }` per row-activation prop assignment. */
        const handlerAssignments = [];

        /** Resolve an Identifier to the single expression it was initialised with. */
        function initializerOf(identifier, scope) {
            let cursor = scope;
            while (cursor) {
                const variable = cursor.variables.find((v) => v.name === identifier.name);
                if (variable) {
                    const withInit = variable.defs.filter(
                        (d) => d.node && d.node.type === 'VariableDeclarator' && d.node.init,
                    );
                    // More than one initialiser means reassignment — out of scope
                    // for a rule that does no data-flow analysis.
                    if (withInit.length === 1) return withInit[0].node.init;
                    return null;
                }
                cursor = cursor.upper;
            }
            return null;
        }

        /**
         * The function nodes a row-activation handler expression resolves to,
         * plus a reason when it resolves to none.
         */
        function resolveHandler(expression, scope, depth) {
            if (!expression || depth > 4) return { functions: [], reason: 'too indirect' };

            if (
                expression.type === 'ArrowFunctionExpression' ||
                expression.type === 'FunctionExpression'
            ) {
                return { functions: [expression], reason: null };
            }

            // `useCallback(fn, deps)` / `useMemo(() => fn, deps)` — the shape
            // every stable-identity handler in this repo is written in.
            if (expression.type === 'CallExpression' && expression.arguments.length > 0) {
                const callee = expression.callee;
                const calleeName =
                    callee.type === 'Identifier'
                        ? callee.name
                        : callee.type === 'MemberExpression' &&
                            callee.property.type === 'Identifier'
                          ? callee.property.name
                          : null;
                if (calleeName === 'useCallback' || calleeName === 'useMemo') {
                    return resolveHandler(expression.arguments[0], scope, depth + 1);
                }
                return { functions: [], reason: 'call to a helper this rule cannot open' };
            }

            // `cond ? a : b` — both arms are handlers.
            if (expression.type === 'ConditionalExpression') {
                const left = resolveHandler(expression.consequent, scope, depth + 1);
                const right = resolveHandler(expression.alternate, scope, depth + 1);
                const functions = left.functions.concat(right.functions);
                return {
                    functions,
                    reason: functions.length > 0 ? null : 'conditional of opaque arms',
                };
            }

            if (expression.type === 'Identifier') {
                const init = initializerOf(expression, scope);
                if (!init) {
                    return { functions: [], reason: 'identifier bound elsewhere' };
                }
                return resolveHandler(init, scope, depth + 1);
            }

            // A member expression (`props.onRowClick`), a literal `undefined`,
            // anything else the rule has no path into.
            return { functions: [], reason: 'not a function expression' };
        }

        /** Does `node` sit anywhere inside `ancestor`? */
        function isInside(node, ancestor) {
            let cursor = node.parent;
            while (cursor) {
                if (cursor === ancestor) return true;
                cursor = cursor.parent;
            }
            return false;
        }

        /**
         * The scope is captured HERE, at the assignment, not re-derived at
         * `Program:exit`. A named handler is declared in the component
         * function's scope, so resolving it from the Program scope finds
         * nothing and the rule reports a hole for every real call site it was
         * written to catch — green, and blind. Measured: three cases flipped.
         */
        function record(prop, expression, node) {
            if (!expression) return;
            const scope = sourceCode.getScope
                ? sourceCode.getScope(node)
                : context.getScope();
            handlerAssignments.push({ prop, expression, scope });
        }

        return {
            // `onRowClick={…}` on a JSX element.
            JSXAttribute(node) {
                if (node.name.type !== 'JSXIdentifier') return;
                if (!ROW_ACTIVATION_PROPS.has(node.name.name)) return;
                if (!node.value || node.value.type !== 'JSXExpressionContainer') return;
                record(node.name.name, node.value.expression, node);
            },

            // `onRowClick: …` / `onRowClick,` inside an object LITERAL — the
            // `table={{ … }}` bag `EntityListPage` forwards to `DataTable`.
            // ObjectPattern (destructuring inside the table primitives) is a
            // different node type and is correctly invisible here.
            Property(node) {
                if (node.parent.type !== 'ObjectExpression') return;
                const name =
                    node.key.type === 'Identifier'
                        ? node.key.name
                        : node.key.type === 'Literal'
                          ? String(node.key.value)
                          : null;
                if (name === null || !ROW_ACTIVATION_PROPS.has(name)) return;
                record(name, node.value, node);
            },

            CallExpression(node) {
                const callee = node.callee;
                if (callee.type !== 'MemberExpression' || callee.computed) return;
                if (callee.property.type !== 'Identifier') return;
                if (!NAVIGATING_METHODS.has(callee.property.name)) return;
                if (callee.object.type !== 'Identifier') return;

                const scope = sourceCode.getScope
                    ? sourceCode.getScope(node)
                    : context.getScope();
                const init = initializerOf(callee.object, scope);
                const fromUseRouter =
                    init &&
                    init.type === 'CallExpression' &&
                    init.callee.type === 'Identifier' &&
                    init.callee.name === 'useRouter';
                if (!fromUseRouter && callee.object.name !== 'router') return;

                navigatingCalls.push({ node, method: callee.property.name });
            },

            'Program:exit'() {
                // One finding per offending CALL, even when two props share a
                // handler — the defect is the call, not the wiring.
                const reported = new Set();

                for (const { prop, expression, scope } of handlerAssignments) {
                    if (options.reportRowClicks) {
                        context.report({
                            node: expression,
                            messageId: 'rowActivationSeen',
                            data: { prop },
                        });
                    }

                    const { functions, reason } = resolveHandler(expression, scope, 0);
                    if (functions.length === 0) {
                        if (options.reportUnanalysable) {
                            context.report({
                                node: expression,
                                messageId: 'unanalysableHandler',
                                data: { prop, kind: reason || 'unknown' },
                            });
                        }
                        continue;
                    }

                    for (const fn of functions) {
                        for (const call of navigatingCalls) {
                            if (call.node === fn || !isInside(call.node, fn)) continue;
                            if (reported.has(call.node)) continue;
                            reported.add(call.node);
                            context.report({
                                node: call.node,
                                messageId: 'rawRouterPush',
                                data: { prop, method: call.method },
                            });
                        }
                    }
                }
            },
        };
    },
};
