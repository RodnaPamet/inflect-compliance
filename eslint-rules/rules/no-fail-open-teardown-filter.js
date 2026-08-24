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
 * Those biases point the same way ON PURPOSE — flag something fine rather than
 * stay quiet about something that is not, because a false positive costs one
 * `if (…)` and a false negative costs an emptied table in a database every
 * other suite in the run is sharing.
 *
 * BUT "the rule fails CLOSED" is NOT true as an absolute, and the first version
 * of this header said it was. Three shapes were measured failing OPEN and have
 * since been fixed — a negated guard (`if (!x)`, strictly worse than no guard),
 * an `AND`/`NOT` combinator array, and `where: <bare let>`. What remains open,
 * stated rather than implied away:
 *
 *   - Only `Identifier` filter values are inspected. `where: { id: fix.id }`
 *     and `where: { id: getId() }` are invisible.
 *   - Reachability is not analysed. Whether the hook that assigns the variable
 *     can actually throw before it is a data-flow question this rule does not
 *     ask; it flags the SHAPE.
 *
 * So a green rule is not a proof that a teardown is safe. It is a proof that
 * this one syntactic shape is absent.
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
/**
 * Does `test` require `variable` to be TRUTHY for the guarded branch to run?
 *
 * POLARITY IS THE WHOLE POINT, and the first version of this rule ignored it —
 * it accepted any test that MENTIONED the variable. That made it silent on
 *
 *     if (!tenantA) { await prisma.risk.deleteMany({ where: { tenantId: tenantA } }); }
 *
 * which is strictly WORSE than no guard: the delete runs exactly when the
 * filter is undefined. Also silent on `if (tenantA === undefined)` and
 * `if (someFlag || tenantA === null)`.
 *
 * Accepts only three shapes, and treats everything else as UNGUARDED so the
 * rule reports rather than stays quiet:
 *
 *   if (x)                     the identifier is the whole test
 *   if (x && …) / if (… && x)  an operand of an && chain, all of which must hold
 *   if (x !== undefined)       explicit non-nullish, either operand order
 *   if (x != null)
 *
 * A disjunction is rejected even when an operand is positive: in `if (a || x)`
 * the branch can run with `x` falsy. So is any shape reached through a `!`.
 */
function guardsPositively(sourceCode, test, variable) {
    const isOurs = (n) =>
        n &&
        n.type === 'Identifier' &&
        n.name === variable.name &&
        resolveVariable(sourceCode, n, n.name) === variable;

    // if (x)
    if (isOurs(test)) return true;

    // if (x && …) — recurse into BOTH operands; either may carry the check,
    // and every operand of an && must hold for the branch to run.
    if (test.type === 'LogicalExpression' && test.operator === '&&') {
        return (
            guardsPositively(sourceCode, test.left, variable) ||
            guardsPositively(sourceCode, test.right, variable)
        );
    }

    // if (x !== undefined) / if (x != null), either operand order
    if (
        test.type === 'BinaryExpression' &&
        (test.operator === '!==' || test.operator === '!=')
    ) {
        const nullish = (n) =>
            (n.type === 'Identifier' && n.name === 'undefined') ||
            (n.type === 'Literal' && n.value === null);
        if (isOurs(test.left) && nullish(test.right)) return true;
        if (isOurs(test.right) && nullish(test.left)) return true;
    }

    return false;
}

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
        if (test && guardsPositively(sourceCode, test, variable)) {
            return true;
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
 * Recurses through nested objects (`{ tenant: { id: x } }`, `{ id: { in: x } }`)
 * and through array literals whose ELEMENTS ARE OBJECTS — the `AND` / `OR` /
 * `NOT` combinator shape.
 *
 * The array distinction is measured, not assumed, and the first version of this
 * rule drew it in the wrong place. It skipped EVERY array literal, justified as
 * "Prisma rejects an undefined array member". That is true only of a SCALAR
 * member. Against this repo's client (331 rows):
 *
 *     { id: { in: [undefined] } }   -> THROWS          (scalar member, safe)
 *     { OR:  [{ id: undefined }] }  ->   0             (safe, by luck)
 *     { AND: [{ id: undefined }] }  -> 331, EVERY ROW  (fails OPEN)
 *     { NOT: [{ id: undefined }] }  -> 331, EVERY ROW  (fails OPEN)
 *
 * So an array of scalars is genuinely safe and is still skipped; an array of
 * objects is not, and is now recursed into. Generalising from the `in:` case to
 * "any array literal" is the same over-generalisation
 * `tests/integration/db-helper.ts` warns about one level down — two of three
 * `in` shapes are safe, and the safe ones teach the wrong rule.
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
        } else if (value.type === 'ArrayExpression') {
            // Objects inside AND/OR/NOT; scalar members are Prisma's to reject.
            for (const el of value.elements) {
                if (el && el.type === 'ObjectExpression') {
                    collectFilterIdentifiers(el, out);
                }
            }
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
                if (!whereProperty) return;

                // `where: filter` with `filter` a bare `let` fails open exactly
                // like an inline scalar — measured `where: undefined` -> 331 of
                // 331 rows. The first version returned early on any non-object
                // `where`, so this was silent; 47 teardown calls already use
                // `where: <identifier>` (all `const` today), so the first one
                // written as a `let` would have been unprotected.
                const candidates =
                    whereProperty.value.type === 'Identifier'
                        ? [whereProperty.value]
                        : whereProperty.value.type === 'ObjectExpression'
                          ? collectFilterIdentifiers(whereProperty.value)
                          : [];
                if (candidates.length === 0) return;

                const reported = new Set();
                for (const id of candidates) {
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
