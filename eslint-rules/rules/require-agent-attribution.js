'use strict';

/**
 * `local/require-agent-attribution`
 *
 * Every Prisma CREATE against a table that attributes work to a registered
 * agent must name `agentId` in its `data` object.
 *
 * ── What the rule is protecting ──────────────────────────────────────
 *
 * `AgentProposal` and `WorkflowRun` are the two records an autonomous agent
 * leaves behind. `RegisteredAgent` is the register saying which agents a tenant
 * runs and what authority each holds. The pair is only worth having if every
 * runtime record RESOLVES to a register entry — otherwise "which agents are
 * running here?" has two answers, the register's and the truth's, and the
 * register is the one on the compliance report.
 *
 * The column is NULLABLE, because it had to be: it was added to populated
 * tables in the same transaction that back-filled it, and because a
 * human-started workflow run genuinely has no agent. So the type system cannot
 * ask for it. This rule asks instead.
 *
 * ── What it demands, exactly ─────────────────────────────────────────
 *
 * That `agentId` is MENTIONED — not that it is non-null. `agentId: null` for a
 * human-started run is the correct value, and a rule that refused it would push
 * writers toward inventing an agent to satisfy the linter, which is the failure
 * it exists to prevent. What it refuses is SILENCE: a write site that never
 * considered attribution at all, whose row is then indistinguishable from a
 * pre-register one.
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

/** The property that must appear. */
const REQUIRED_FIELD = 'agentId';

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
 * True when this object literal names the field, or spreads something that
 * might. See the header for why a spread is accepted.
 */
function namesField(objectExpression) {
    return objectExpression.properties.some((prop) => {
        if (prop.type === 'SpreadElement' || prop.type === 'ExperimentalSpreadProperty') return true;
        return propertyName(prop) === REQUIRED_FIELD;
    });
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
                'Require every create against an agent-attributed table to name agentId, so a runtime agent record always resolves to the register.',
        },
        schema: [],
        messages: {
            missingAttribution:
                "This `{{model}}.{{method}}` does not name `{{field}}`. Every agent runtime record must resolve to a RegisteredAgent, so set `{{field}}: ctx.agentId ?? null` — null is a legitimate value for a human-started record, silence is not.",
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
                    if (namesField(value)) continue;
                    context.report({
                        node: dataProp,
                        messageId: 'missingAttribution',
                        data: {
                            model,
                            method: node.callee.property.name,
                            field: REQUIRED_FIELD,
                        },
                    });
                }
            },
        };
    },
};
