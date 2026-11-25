'use strict';

/**
 * `local/no-person-identity-in-audit-payload`
 *
 * An audit row names a person by their USER ID, and by nothing else: no e-mail
 * address and no name, in `details` or in `detailsJson` (#5950, owner decision
 * 2026-11-25). A reader resolves the id while the person exists; after an
 * erasure only the id remains.
 *
 * ── Why the row cannot carry them ────────────────────────────────────
 *
 * Two properties of the audit trail, both deliberate, make an address or a
 * name in a row permanent and public to the tenant's tooling:
 *
 *   - The trail is IMMUTABLE and hash-chained. A DSAR erasure can move
 *     `userId` to NULL; it cannot rewrite `details` or `detailsJson`, because
 *     the entry hash covers them. Whatever a row says about a person when it
 *     is written, it says for ever.
 *   - `detailsJson` is STREAMED to the tenant's SIEM (Epic C.4), whose
 *     contract is an opaque `userId`, never an e-mail address.
 *
 * So the person is named by id: `detailsJson.targetUserId` (the convention a
 * DSAR erasure already reads), or the row's own `entityId` when that is the
 * person's record. A person with no account yet (an invitee, a vendor's
 * respondent) is named by the record that holds the address (the invite, the
 * assessment), which a reader resolves while it exists.
 *
 * ── What the rule reads ──────────────────────────────────────────────
 *
 * The PAYLOAD of an audit write:
 *
 *   - the `details`, `detailsJson`, `metadata`, `metadataJson` and `diffJson`
 *     members of an object passed to one of the writers in `WRITERS`;
 *   - the value of any property named `detailsJson`, wherever it is written,
 *     so a wrapper that takes `{ detailsJson }` and forwards it is covered
 *     without being named here;
 *   - the argument at the index the `payloadArgs` option names, for a wrapper
 *     whose positional argument becomes `detailsJson` (configured in
 *     `eslint.config.mjs`).
 *
 * Inside the payload it reports:
 *
 *   - a property KEY that names a person's address or name (`email`,
 *     `ownerEmail`, `displayName`, `fullName`, `givenName`, `userName`, …);
 *   - a VALUE that reads one — an identifier (`normalizedEmail`) or a member
 *     (`membership.user.email`, `employee.fullName`), including one
 *     interpolated into a template;
 *   - `<person>.name`, where the object is person-shaped (`user`,
 *     `membership.user`, `subjectUser`, `employee`, …). A bare `.name` is NOT
 *     reported: a control's, a vendor's or a campaign's name is not a person,
 *     and those are the names an audit row is for.
 *
 * An identifier is followed one step to a local `const` whose initialiser is a
 * template, an object, an array, a concatenation, `??`/`||` or a conditional,
 * so `const summary = \`… ${m.prior.fullName}\`; logEvent(…, { details:
 * summary })` is caught. It is followed only where the payload uses its WHOLE
 * value (`details: summary`, `${summary}`, `JSON.stringify(obj)`): an
 * identifier that is the object of a member read (`auditor.id`, `after[f]`)
 * contributes one member, which the member check judges, so its initialiser
 * is not read. Arguments of a call whose callee name contains `hash`
 * (`hashEmailForLog(email)`) are not read: a digest is not an address.
 *
 * ── Why a rule and not a regex under tests/guards ────────────────────
 *
 * The shape is syntactic (a property and the expressions under it), and the
 * same words appear in comments and strings across these files. The AST tells
 * them apart; a regex does not. It needs more than a `no-restricted-syntax`
 * selector because it walks a subtree from several entry points and follows a
 * `const` to its initialiser.
 */

const WRITERS = new Set([
    'logEvent',
    'appendAuditEntry',
    'appendAuditEntryWithin',
    'appendAuditEntryOrQueue',
    'appendOrgAuditEntry',
    'logAudit',
    'buildAuditEntry',
]);

/** Members of a writer's payload that are stored in the row. */
const PAYLOAD_KEYS = new Set(['details', 'detailsJson', 'metadata', 'metadataJson', 'diffJson']);

/**
 * A name that holds a person's e-mail address or name. `email`, any camelCase
 * `…Email` (`ownerEmail`, `respondentEmail`, `normalizedEmail`, `workEmail`),
 * and the name fields a directory, SCIM or an HRIS carries.
 */
const PERSON_FIELD =
    /^(email|[a-z][A-Za-z0-9]*Email|displayName|fullName|givenName|familyName|middleName|preferredName|legalName|firstName|lastName|userName|username)$/;

/** An object whose `.name` is a person's name. */
const PERSON_OBJECT =
    /^(user|users|member|members|membership|owner|subject|invitee|employee|person|people|auditor|assignee|reviewer|actor|closer|requester|respondent|contact|approver|decider|recipient|manager)$|[a-z0-9](User|Member|Membership|Employee|Owner|Person|Auditor|Assignee|Reviewer|Requester|Respondent|Contact|Approver|Invitee)$/;

const FOLLOWED_INITIALISERS = new Set([
    'TemplateLiteral',
    'ObjectExpression',
    'ArrayExpression',
    'BinaryExpression',
    'LogicalExpression',
    'ConditionalExpression',
]);

function calleeName(callee) {
    if (!callee) return null;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
        return callee.property.name;
    }
    return null;
}

function keyName(prop) {
    if (prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
    return null;
}

/** The last name segment of a member chain's object: `membership.user` → `user`. */
function lastSegment(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name;
    if (node.type === 'ChainExpression') return lastSegment(node.expression);
    if (node.type === 'TSNonNullExpression') return lastSegment(node.expression);
    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'An audit row names a person by user id only: no e-mail address or name in details or detailsJson (#5950).',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    payloadArgs: {
                        type: 'object',
                        additionalProperties: { type: 'integer', minimum: 0 },
                    },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            personIdentity:
                '`{{what}}` puts a person\'s e-mail address or name into an audit row\'s {{field}}. ' +
                'An audit row is immutable and streamed to the tenant\'s SIEM, so it names a person by id only ' +
                '(#5950): use `targetUserId` (or the record\'s id) and let the reader resolve it.',
        },
    },

    create(context) {
        const payloadArgs = (context.options[0] && context.options[0].payloadArgs) || {};
        const sourceCode = context.sourceCode || context.getSourceCode();
        const visitorKeys = sourceCode.visitorKeys;
        const reported = new Set();
        const checkedRoots = new Set();

        function report(node, what, field) {
            // By range: a shorthand `{ email }` is a key and a value at the
            // same position, and one finding is enough.
            const at = `${node.range[0]}:${node.range[1]}`;
            if (reported.has(at)) return;
            reported.add(at);
            context.report({ node, messageId: 'personIdentity', data: { what, field } });
        }

        /** The `const` initialiser an identifier refers to, if it is one worth following. */
        function followedInit(identifier) {
            let scope = sourceCode.getScope ? sourceCode.getScope(identifier) : context.getScope();
            while (scope) {
                const variable = scope.set.get(identifier.name);
                if (variable) {
                    if (variable.defs.length !== 1) return null;
                    const def = variable.defs[0];
                    if (def.type !== 'Variable' || !def.node.init) return null;
                    if (def.parent && def.parent.kind !== 'const') return null;
                    return FOLLOWED_INITIALISERS.has(def.node.init.type) ? def.node.init : null;
                }
                scope = scope.upper;
            }
            return null;
        }

        function walk(node, field, followed) {
            if (!node || typeof node.type !== 'string') return;

            switch (node.type) {
                case 'Property': {
                    const key = keyName(node);
                    if (key && PERSON_FIELD.test(key)) report(node.key, key, field);
                    // The key itself is a name, not a read: walk the value only.
                    walk(node.value, field, followed);
                    return;
                }
                case 'MemberExpression': {
                    if (!node.computed && node.property.type === 'Identifier') {
                        const prop = node.property.name;
                        if (PERSON_FIELD.test(prop)) {
                            report(node, sourceCode.getText(node), field);
                            return;
                        }
                        if (prop === 'name') {
                            const owner = lastSegment(node.object);
                            if (owner && PERSON_OBJECT.test(owner)) {
                                report(node, sourceCode.getText(node), field);
                                return;
                            }
                        }
                    }
                    // The object contributes one member, not its whole value:
                    // judge its own name, never follow it to its initialiser.
                    if (node.object.type === 'Identifier') {
                        if (PERSON_FIELD.test(node.object.name)) report(node.object, node.object.name, field);
                    } else {
                        walk(node.object, field, followed);
                    }
                    if (node.computed) walk(node.property, field, followed);
                    return;
                }
                case 'Identifier': {
                    if (PERSON_FIELD.test(node.name)) {
                        report(node, node.name, field);
                        return;
                    }
                    if (!followed.has(node.name)) {
                        const init = followedInit(node);
                        if (init) {
                            const next = new Set(followed);
                            next.add(node.name);
                            walk(init, field, next);
                        }
                    }
                    return;
                }
                case 'CallExpression': {
                    const name = calleeName(node.callee);
                    // A digest of an address is not the address.
                    if (name && /hash/i.test(name)) return;
                    walk(node.callee, field, followed);
                    for (const arg of node.arguments) walk(arg, field, followed);
                    return;
                }
                case 'Literal':
                    return;
                default:
                    break;
            }

            const keys = visitorKeys[node.type] || [];
            for (const key of keys) {
                const child = node[key];
                if (Array.isArray(child)) {
                    for (const c of child) walk(c, field, followed);
                } else if (child && typeof child.type === 'string') {
                    walk(child, field, followed);
                }
            }
        }

        function checkRoot(node, field) {
            if (!node || checkedRoots.has(node)) return;
            checkedRoots.add(node);
            walk(node, field, new Set());
        }

        function checkPayloadObject(obj) {
            for (const prop of obj.properties) {
                if (prop.type !== 'Property') continue;
                const key = keyName(prop);
                if (key && PAYLOAD_KEYS.has(key)) checkRoot(prop.value, key);
            }
        }

        return {
            CallExpression(node) {
                const name = calleeName(node.callee);
                if (!name) return;
                if (WRITERS.has(name)) {
                    for (const arg of node.arguments) {
                        if (arg.type === 'ObjectExpression') checkPayloadObject(arg);
                    }
                }
                if (Object.prototype.hasOwnProperty.call(payloadArgs, name)) {
                    const arg = node.arguments[payloadArgs[name]];
                    if (arg) checkRoot(arg, `${name}() argument ${payloadArgs[name]}`);
                }
            },
            Property(node) {
                if (keyName(node) === 'detailsJson') checkRoot(node.value, 'detailsJson');
            },
        };
    },
};
