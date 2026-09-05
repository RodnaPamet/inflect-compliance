'use strict';

/**
 * `local/require-mcp-tool-authorization`
 *
 * Two halves of one invariant: an MCP tool DECLARES the authorization the
 * equivalent human route applies, and never performs its own.
 *
 * ── What the rule is protecting ──────────────────────────────────────
 *
 * `/api/mcp` runs every tool through one funnel, and the funnel is where the
 * shared gate lives — `assertPermission`, the same function `requirePermission`
 * calls, plus the same `assertCanRead` / `assertCanWrite` policies the human
 * usecases apply. That arrangement is only worth having while it is the ONLY
 * arrangement. A tool that carries its own check is a second authorization path
 * over the same `PermissionSet`, free to drift from the human route it mirrors —
 * and, worse, a tool that can perform a check is a tool that can skip one.
 *
 * So a tool descriptor is DATA: it names the keys, the funnel enforces them.
 * This rule asks for the data and refuses the code.
 *
 * ── What it demands, exactly ─────────────────────────────────────────
 *
 * 1. An object literal that is structurally an MCP tool descriptor — it names
 *    `name`, `description`, `inputSchema`, and either `run` (a read tool) or
 *    `kind` (a propose tool) — must also name `authorize`.
 *
 *    Recognition is STRUCTURAL, not by variable name or file path. A tool
 *    renamed, moved between files, or built by a helper is still a tool; a
 *    `const config = { name, description }` that happens to share two of the
 *    property names is not, because it carries neither `run` nor `kind`.
 *
 * 2. In a file that declares at least one such descriptor, calling an
 *    authorization primitive directly is a violation. The banned list is the
 *    repo's own gate vocabulary; the funnel calls all of it, and a tool file
 *    calling any of it has taken the decision back.
 *
 *    Scoped to files that declare a tool rather than to a directory, so the rule
 *    survives the tools moving — a path-keyed check reports full coverage of
 *    whatever is still where it expects.
 *
 * ── Why a rule and not a regex under tests/guards ────────────────────
 *
 * A regex cannot tell an `authorize` PROPERTY from the word appearing in a
 * comment or a description string — and these tools are documented in prose that
 * uses the word constantly. It also cannot see that a call is a call rather than
 * an import of the same identifier. The AST can, and it survives the renaming
 * and reformatting a regex does not. Per `eslint-rules/README.md` this needs more
 * than a `no-restricted-syntax` selector, because it has to reason across nodes:
 * find the descriptor shape, then check a sibling property; and gate the second
 * half of the rule on the first half having matched somewhere in the file.
 */

/** Properties every MCP tool descriptor carries. */
const REQUIRED_SHAPE = ['name', 'description', 'inputSchema'];

/** One of these tells a read tool from a propose tool; either identifies a tool. */
const DISCRIMINATORS = ['run', 'kind'];

/** The property that must be present. */
const REQUIRED_FIELD = 'authorize';

/**
 * Authorization primitives a tool file must not call.
 *
 * ADDING ONE: it belongs here if calling it decides whether a request proceeds.
 * It does NOT belong here if it merely reads a flag for display — the message
 * below says the tool "authorized itself", and a formatter would make that
 * wrong.
 */
const AUTHZ_PRIMITIVES = new Set([
    'assertPermission',
    'requirePermission',
    'hasPermission',
    'assertCanRead',
    'assertCanWrite',
    'assertCanAdmin',
    'assertCanAudit',
    'enforceApiKeyScope',
    'enforceMcpCapability',
]);

function propertyName(prop) {
    if (prop.type !== 'Property') return null;
    if (prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

function namedProperties(objectExpression) {
    const names = new Set();
    let hasSpread = false;
    for (const prop of objectExpression.properties) {
        if (prop.type === 'SpreadElement' || prop.type === 'ExperimentalSpreadProperty') {
            hasSpread = true;
            continue;
        }
        const n = propertyName(prop);
        if (n !== null) names.add(n);
    }
    return { names, hasSpread };
}

/** True when this object literal is structurally an MCP tool descriptor. */
function isToolDescriptor(names) {
    return (
        REQUIRED_SHAPE.every((k) => names.has(k)) &&
        DISCRIMINATORS.some((k) => names.has(k))
    );
}

/** The callee's simple name, for `f(…)` and `ns.f(…)` alike. */
function calleeName(callee) {
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
        return callee.property.name;
    }
    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require every MCP tool descriptor to declare the authorization its human equivalent applies, and forbid a tool file from performing its own.',
        },
        schema: [],
        messages: {
            missingAuthorize:
                'This MCP tool descriptor does not name `{{field}}`. Every tool must declare the authorization its equivalent human route applies — the keys, the basis, and the route it mirrors — so the one funnel can enforce it. A tool with no declaration is a tool nothing checks.',
            selfAuthorized:
                'This file declares an MCP tool and calls `{{callee}}` directly. Authorization for a tool call belongs in the funnel (`authorizeToolCall`), which applies the same gate the human route uses and writes the one AUTHZ_DENIED row. A tool that can perform a check is a tool that can skip one — declare `authorize` instead.',
        },
    },

    create(context) {
        const descriptorNodes = [];
        const authzCalls = [];

        return {
            ObjectExpression(node) {
                const { names, hasSpread } = namedProperties(node);
                if (!isToolDescriptor(names)) return;
                descriptorNodes.push(node);
                // A spread could carry `authorize`. Accepted, for the same
                // reason `require-agent-attribution` accepts one: following it
                // to its source is cross-statement data flow this rule does not
                // do, and flagging every spread would make the rule unusable
                // wherever a tool is built from a shared base.
                if (hasSpread || names.has(REQUIRED_FIELD)) return;
                context.report({
                    node,
                    messageId: 'missingAuthorize',
                    data: { field: REQUIRED_FIELD },
                });
            },

            CallExpression(node) {
                const name = calleeName(node.callee);
                if (name && AUTHZ_PRIMITIVES.has(name)) {
                    authzCalls.push({ node, name });
                }
            },

            'Program:exit'() {
                // The second half only applies to a file that declares a tool.
                if (descriptorNodes.length === 0) return;
                for (const call of authzCalls) {
                    context.report({
                        node: call.node,
                        messageId: 'selfAuthorized',
                        data: { callee: call.name },
                    });
                }
            },
        };
    },
};
