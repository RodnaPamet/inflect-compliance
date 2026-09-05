'use strict';

/**
 * `local/require-agent-attribution`
 *
 * Every Prisma CREATE against a table that attributes work to a registered
 * agent must name BOTH attribution columns in its `data` object: `agentId`
 * (which agent) and `policyCardVersion` (under which version of that agent's
 * declared policy).
 *
 * ── What the rule is protecting ──────────────────────────────────────
 *
 * `AgentProposal` and `WorkflowRun` are the two records an autonomous agent
 * leaves behind. `RegisteredAgent` is the register saying which agents a tenant
 * runs and what authority each holds, and `AgentPolicyCardVersion` is the
 * immutable statement of what one of them was allowed to do. The set is only
 * worth having if every runtime record RESOLVES to both — otherwise "which
 * agents are running here?" has two answers, the register's and the truth's,
 * and "what was it allowed to do when it did that?" has only today's answer,
 * which is the wrong one exactly when somebody has edited the card.
 *
 * Both columns are NULLABLE, because both had to be: each was added to
 * populated tables in the same transaction that back-filled them, and a
 * human-started workflow run genuinely has neither an agent nor a card. So the
 * type system cannot ask for them. This rule asks instead.
 *
 * ── What it demands, exactly ─────────────────────────────────────────
 *
 * That each field is MENTIONED — not that it is non-null. `agentId: null` for a
 * human-started run is the correct value, and a rule that refused it would push
 * writers toward inventing an agent to satisfy the linter, which is the failure
 * it exists to prevent. `policyCardVersion` has the same shape one level over:
 * `NO_POLICY_CARD` (0) is the right value when no card governed the row, and it
 * is a DIFFERENT fact from the NULL a row written before pinning carries. What
 * the rule refuses is SILENCE: a write site that never considered attribution at
 * all, whose row is then indistinguishable from a pre-register one.
 *
 * A spread (`...data`) counts as naming it. That is a real hole and it is
 * deliberate: following a spread to its source is cross-statement data flow,
 * which this rule does not do, and flagging every spread would make the rule
 * unusable in the repository layer. The `tests/guards` companion covers the two
 * known seams by running this rule over the files git actually lists, so a new
 * seam that hides behind a spread is caught by review rather than here.
 *
 * ── Why a rule and not a regex under tests/guards ────────────────────
 *
 * A regex over source text cannot tell `db.agentProposal.create({ data: {…} })`
 * from the same words inside a comment or a string, and it dies on renaming,
 * reformatting and helper extraction. The AST survives all of those. Per
 * `eslint-rules/README.md`, this needs more than a `no-restricted-syntax`
 * selector because it must reason across nodes inside the call (find the `data`
 * property, then inspect its properties).
 */

/**
 * Prisma model accessors whose rows attribute work to an agent. Keyed by the
 * camelCase accessor name as it appears on the client.
 *
 * ADDING A TABLE: put the accessor here and add the column. Do NOT add a table
 * whose rows are not agent work — the message below tells the reader the row
 * "attributes work to an agent", and a table where that is false would make the
 * rule's own explanation wrong.
 */
const AGENT_ATTRIBUTED_MODELS = new Set(['agentProposal', 'workflowRun']);

/** Create-shaped Prisma methods. `createManyAndReturn` included for completeness. */
const CREATE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

/**
 * The properties that must appear.
 *
 * Two, not one, and they are checked together rather than by two rules: they
 * are the same decision seen from two angles (which principal, under which
 * policy), a write site that forgot one has almost always forgotten the other,
 * and one report listing both is one fix rather than two round trips.
 */
const REQUIRED_FIELDS = ['agentId', 'policyCardVersion'];

/** `data:` for create/createMany; upsert carries `create:` and `update:`. */
const DATA_KEYS = new Set(['data', 'create']);

function propertyName(prop) {
    if (prop.type !== 'Property') return null;
    if (prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

/**
 * The required fields this object literal does NOT name.
 *
 * A spread satisfies EVERY field, not just one: following it to its source is
 * cross-statement data flow, which this rule does not do, so a spread is opaque
 * for all of them alike. See the header for why that hole is deliberate.
 */
function missingFields(objectExpression) {
    const named = new Set();
    for (const prop of objectExpression.properties) {
        if (prop.type === 'SpreadElement' || prop.type === 'ExperimentalSpreadProperty') return [];
        const name = propertyName(prop);
        if (name !== null) named.add(name);
    }
    return REQUIRED_FIELDS.filter((f) => !named.has(f));
}

/**
 * The model accessor for `<anything>.<model>.<method>(…)`, or null when the
 * callee is not that shape.
 */
function modelAccessorOf(callee) {
    if (callee.type !== 'MemberExpression' || callee.computed) return null;
    if (callee.property.type !== 'Identifier') return null;
    if (!CREATE_METHODS.has(callee.property.name)) return null;

    const object = callee.object;
    if (object.type !== 'MemberExpression' || object.computed) return null;
    if (object.property.type !== 'Identifier') return null;
    return object.property.name;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require every create against an agent-attributed table to name agentId and policyCardVersion, so a runtime agent record always resolves to the register and to the policy version in force when it ran.',
        },
        schema: [],
        messages: {
            missingAttribution:
                "This `{{model}}.{{method}}` does not name `{{fields}}`. Every agent runtime record must resolve to a RegisteredAgent (`agentId: ctx.agentId ?? null`) and to the policy-card version in force when it ran (`policyCardVersion`, from `pinFromCard(inv.policyCard?.inForce ?? null)` or `await resolvePolicyCardPin(ctx.tenantId, ctx.agentId)`). `null` and `NO_POLICY_CARD` are legitimate values for a human-started record; silence is not, because a row that never answered is indistinguishable from one written before the column existed.",
        },
    },

    create(context) {
        return {
            CallExpression(node) {
                const model = modelAccessorOf(node.callee);
                if (!model || !AGENT_ATTRIBUTED_MODELS.has(model)) return;

                const arg = node.arguments[0];
                if (!arg || arg.type !== 'ObjectExpression') return;

                // A spread at the top level could carry the whole `data` object.
                if (arg.properties.some((p) => p.type === 'SpreadElement')) return;

                const dataProps = arg.properties.filter((p) => DATA_KEYS.has(propertyName(p)));
                // `createMany({ data: [...] })` and any shape whose payload is
                // not an object literal are out of reach — reported by neither
                // this rule nor a false green, because the guard companion
                // enumerates the real seams.
                for (const dataProp of dataProps) {
                    const value = dataProp.value;
                    if (value.type !== 'ObjectExpression') continue;
                    const missing = missingFields(value);
                    if (missing.length === 0) continue;
                    // ONE report naming every missing field, not one per field.
                    // A site that forgot both is one omission, and two errors on
                    // one line reads as two problems to fix separately.
                    context.report({
                        node: dataProp,
                        messageId: 'missingAttribution',
                        data: {
                            model,
                            method: node.callee.property.name,
                            fields: missing.map((f) => `\`${f}\``).join(' and '),
                        },
                    });
                }
            },
        };
    },
};
