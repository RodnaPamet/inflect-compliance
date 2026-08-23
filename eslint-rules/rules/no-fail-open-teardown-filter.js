'use strict';

/**
 * `local/no-fail-open-teardown-filter`
 *
 * Bans the teardown shape that emptied tables in #2107 / #2113 / #2114:
 * a `deleteMany` / `updateMany` inside an `afterAll` / `afterEach` hook
 * whose `where` filter reads a bare `let` fixture id.
 *
 * ── The mechanism ────────────────────────────────────────────────────
 *
 * Jest runs `afterAll` even when `beforeAll` THREW. A fixture id held in
 * a bare `let` is therefore still `undefined` in teardown on every setup
 * failure — and Prisma DROPS an undefined filter value rather than
 * rejecting it. Measured against this repo's own client on the shared
 * test database (see the note in `tests/integration/db-helper.ts`):
 *
 *     user.count()                             -> 306  (every row)
 *     user.count({ where: { id: undefined } }) -> 306  (every row)
 *     user.count({ where: { id: 'no-such' } }) ->   0
 *
 * So `deleteMany({ where: { id: someUnassignedLet } })` is
 * `DELETE FROM "User"` with no predicate. It does not throw — it
 * SUCCEEDS, so the surrounding `try { … } catch` is no protection and
 * the run stays green while the shared database is emptied. It fails
 * OPEN, the opposite of the intuition that an undefined filter matches
 * nothing.
 *
 * The repo's idiom for the fix is a truthiness guard around the call:
 *
 *     if (tenantA) {
 *         await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
 *     }
 *
 * ── WHAT THIS RULE CANNOT SEE (read this before trusting it) ─────────
 *
 * Whether a variable is assigned on every path that reaches the
 * `deleteMany` is a DATA-FLOW fact. This rule performs no data-flow
 * analysis whatsoever. It matches a SYNTACTIC SHAPE and nothing more:
 *
 *   - It does not know whether `beforeAll` can actually throw, so it
 *     flags teardowns that are fine in practice.
 *   - It does not track assignments. `let id; id = 'x';` at module scope
 *     is still "a bare let" to this rule.
 *   - It only recognises ONE guard shape — the call sitting inside the
 *     `consequent` of an `if` / ternary that tests the same variable, or
 *     on the right of an `&&` that tests it. An early return
 *     (`if (!id) return;`) IS a correct guard and this rule still flags
 *     the call, because recognising it would require the statement-order
 *     reasoning the rule deliberately does not do.
 *   - It only inspects `Identifier` filter values. `where: { id: fix.id }`
 *     and `where: { id: getId() }` are invisible to it, so a green rule
 *     is NOT a proof that a teardown is safe.
 *
 * Every one of those biases points the same way ON PURPOSE: the rule
 * fails CLOSED. It flags things that are fine rather than staying quiet
 * about things that are not, because the cost of a false positive is one
 * `if (…)` and the cost of a false negative is an emptied table in a
 * database every other suite in the run is sharing.
 *
 * ── Two shapes it deliberately leaves alone ──────────────────────────
 *
 *   `where: { id: { in: [a, b] } }`  — an ARRAY LITERAL. Prisma validates
 *     array members and THROWS on an undefined element, so this shape
 *     already fails closed on its own. Not flagged.
 *
 *   `where: { id: { in: ids } }`     — an IDENTIFIER standing for the
 *     whole array. If `ids` is undefined the filter is dropped exactly
 *     like a bare scalar. This IS flagged. There is no live instance of
 *     it in the repo today; #2114 recorded the trap precisely because
 *     spot-checking the two safe `in` shapes leads to the wrong
 *     conclusion that wrapping in `in` is the protection.
 */

/** Prisma methods whose filter, when dropped, mutates every row. */
const UNBOUNDED_MUTATORS = new Set(['deleteMany', 'updateMany']);

/** Jest / Playwright teardown hooks. */
const TEARDOWN_HOOKS = new Set(['afterAll', 'afterEach']);

/**
 * Walk a node's own child nodes. Skips `parent` (cyclic) and any
 * non-node value.
 */
function eachChildNode(node, visit) {
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item.type === 'string') visit(item);
            }
        } else if (value && typeof value.type === 'string') {
            visit(value);
        }
    }
}

/** Collect every Identifier node in a subtree. */
function collectIdentifiers(node, out = []) {
    if (node.type === 'Identifier') out.push(node);
    eachChildNode(node, (child) => collectIdentifiers(child, out));
    return out;
}

/**
 * Resolve a name to its `Variable` by walking the scope chain outward
 * from the innermost scope containing `node`. Name-based rather than
 * reference-based so shorthand properties (`{ tenantId }`), where the
 * key and the value are the SAME node, resolve like any other read.
 * Walking outward from the innermost scope preserves shadowing.
 */
function resolveVariable(sourceCode, node, name) {
    for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const found = scope.variables.find((v) => v.name === name);
        if (found) return found;
    }
    return null;
}

/**
 * True when `variable` is declared `let`/`var` with NO initializer —
 * the "bare let" of the incident. A `const`, or a `let` with an
 * initializer, cannot be undefined at teardown; a function parameter or
 * an import cannot either.
 */
function isBareLet(variable) {
    if (!variable || variable.defs.length !== 1) return false;
    const def = variable.defs[0];
    if (def.type !== 'Variable') return false;
    if (def.parent.kind !== 'let' && def.parent.kind !== 'var') return false;
    return def.node.type === 'VariableDeclarator' && def.node.init === null;
}

/**
 * The ONE guard shape this rule recognises: `node` sits in the truthy
 * branch of a construct whose test mentions `variable`.
 *
 * Conservative by design — see the header. Anything else (early return,
 * `else` branch, a helper that throws) reads as unguarded.
 */
function isGuarded(sourceCode, node, variable, stopAt) {
    let child = node;
    let parent = node.parent;
    while (parent && child !== stopAt) {
        let test = null;
        if (
            (parent.type === 'IfStatement' ||
                parent.type === 'ConditionalExpression') &&
            parent.consequent === child
        ) {
            test = parent.test;
        } else if (
            parent.type === 'LogicalExpression' &&
            parent.operator === '&&' &&
            parent.right === child
        ) {
            test = parent.left;
        }
        if (test) {
            for (const id of collectIdentifiers(test)) {
                if (
                    id.name === variable.name &&
                    resolveVariable(sourceCode, id, id.name) === variable
                ) {
                    return true;
                }
            }
        }
        child = parent;
        parent = parent.parent;
    }
    return false;
}

/**
 * The nearest enclosing function that was passed straight to a teardown
 * hook, or null. Matches `afterAll(fn)` and `test.afterAll(fn)`
 * (Playwright) alike.
 */
function enclosingTeardownCallback(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (
            current.type !== 'ArrowFunctionExpression' &&
            current.type !== 'FunctionExpression'
        ) {
            continue;
        }
        const call = current.parent;
        if (!call || call.type !== 'CallExpression') continue;
        if (!call.arguments.includes(current)) continue;
        const callee = call.callee;
        const name =
            callee.type === 'Identifier'
                ? callee.name
                : callee.type === 'MemberExpression' &&
                    callee.property.type === 'Identifier'
                  ? callee.property.name
                  : null;
        if (name && TEARDOWN_HOOKS.has(name)) return current;
    }
    return null;
}

/**
 * Every `Identifier` used as a filter VALUE inside a `where` object.
 *
 * Recurses through nested objects (`{ tenant: { id: x } }`,
 * `{ id: { in: x } }`) and deliberately does NOT recurse into array
 * literals — Prisma rejects an undefined array member, so that shape is
 * already safe.
 */
function collectFilterIdentifiers(node, out = []) {
    if (node.type !== 'ObjectExpression') return out;
    for (const property of node.properties) {
        if (property.type !== 'Property') continue;
        const value = property.value;
        if (value.type === 'Identifier') {
            out.push(value);
        } else if (value.type === 'ObjectExpression') {
            collectFilterIdentifiers(value, out);
        }
    }
    return out;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require a truthiness guard on a teardown deleteMany/updateMany whose filter reads a bare `let` fixture id — an undefined Prisma filter value is dropped, not matched, so the statement mutates every row.',
            recommended: true,
            url: 'https://github.com/inflect-compliance/inflect-compliance/blob/main/eslint-rules/README.md#no-fail-open-teardown-filter',
        },
        schema: [],
        messages: {
            failOpenFilter:
                "`{{name}}` is a bare `let`, so it is undefined in this teardown whenever setup threw — and Prisma DROPS an undefined filter value rather than rejecting it, making this `{{method}}` mutate EVERY row of the table. It will not throw; a surrounding try/catch is no protection. Guard the call: `if ({{name}}) { … }`. See the teardown note in tests/integration/db-helper.ts.",
        },
    },

    create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();

        return {
            CallExpression(node) {
                const callee = node.callee;
                if (
                    callee.type !== 'MemberExpression' ||
                    callee.property.type !== 'Identifier' ||
                    !UNBOUNDED_MUTATORS.has(callee.property.name)
                ) {
                    return;
                }

                const hook = enclosingTeardownCallback(node);
                if (!hook) return;

                const [arg] = node.arguments;
                if (!arg || arg.type !== 'ObjectExpression') return;
                const whereProperty = arg.properties.find(
                    (p) =>
                        p.type === 'Property' &&
                        !p.computed &&
                        ((p.key.type === 'Identifier' && p.key.name === 'where') ||
                            (p.key.type === 'Literal' && p.key.value === 'where')),
                );
                if (!whereProperty || whereProperty.value.type !== 'ObjectExpression') {
                    return;
                }

                const reported = new Set();
                for (const id of collectFilterIdentifiers(whereProperty.value)) {
                    const variable = resolveVariable(sourceCode, id, id.name);
                    if (!isBareLet(variable)) continue;
                    if (isGuarded(sourceCode, node, variable, hook)) continue;
                    if (reported.has(variable)) continue;
                    reported.add(variable);
                    context.report({
                        node: id,
                        messageId: 'failOpenFilter',
                        data: {
                            name: id.name,
                            method: callee.property.name,
                        },
                    });
                }
            },
        };
    },
};
