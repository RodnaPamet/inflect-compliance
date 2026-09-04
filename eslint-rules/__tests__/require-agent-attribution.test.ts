/**
 * `local/require-agent-attribution` — RuleTester.
 *
 * The `valid` cases are the load-bearing half. An invalid-only suite passes
 * against a rule that flags every call expression in the repository, so each
 * narrowing the rule performs gets a case here that would go red if the
 * narrowing broke: the model allowlist, the create-method allowlist, the
 * data-key allowlist, and the deliberate spread hole.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../rules/require-agent-attribution');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/require-agent-attribution', () => {
    ruleTester.run('require-agent-attribution', rule, {
        valid: [
            {
                name: 'names agentId from the resolved context',
                code: `db.agentProposal.create({ data: { tenantId: t, agentId: ctx.agentId ?? null } });`,
            },
            {
                name: 'an explicit null is a correct value — a human-started run has no agent',
                code: `db.workflowRun.create({ data: { tenantId: t, agentId: null } });`,
            },
            {
                name: 'a spread might carry the field, and following it is data flow this rule does not do',
                code: `db.agentProposal.create({ data: { ...payload } });`,
            },
            {
                name: 'a top-level spread is equally out of reach',
                code: `db.workflowRun.create({ ...args });`,
            },
            {
                name: 'a table that is not agent-attributed is none of this rule’s business',
                code: `db.risk.create({ data: { tenantId: t, title: x } });`,
            },
            {
                name: 'reads are not writes',
                code: `db.agentProposal.findMany({ where: { tenantId: t } });`,
            },
            {
                name: 'an update is not a create — the attribution was decided at insert',
                code: `db.workflowRun.update({ where: { id }, data: { status: 'DONE' } });`,
            },
            {
                name: 'upsert names the field in its create branch',
                code: `db.agentProposal.upsert({ where: { id }, create: { agentId: null }, update: { status: s } });`,
            },
            {
                name: 'a bare identifier argument carries no object literal to inspect',
                code: `db.agentProposal.create(args);`,
            },
        ],
        invalid: [
            {
                name: 'a create that never considered attribution',
                code: `db.agentProposal.create({ data: { tenantId: t, kind: 'RISK' } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                name: 'the same hole on the workflow side',
                code: `db.workflowRun.create({ data: { tenantId: t, workflowKey: k } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                name: 'reached through a transaction handle rather than the client',
                code: `tx.agentProposal.create({ data: { tenantId: t } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                name: 'upsert whose create branch forgot it',
                code: `db.workflowRun.upsert({ where: { id }, create: { tenantId: t }, update: {} });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
        ],
    });
});
