/**
 * `local/require-agent-attribution` — RuleTester.
 *
 * The `valid` cases are the load-bearing half. An invalid-only suite passes
 * against a rule that flags every call expression in the repository, so each
 * narrowing the rule performs gets a case here that would go red if the
 * narrowing broke: the model allowlist, the create-method allowlist, the
 * data-key allowlist, and the deliberate spread hole.
 *
 * The rule requires TWO fields, and the pair is what most of the cases below
 * are about. A rule that reported only when BOTH were missing would pass an
 * invalid-only suite and every "names both" valid case, so each field gets its
 * own single-omission invalid case — the shape a real write site fails in when
 * a column is added and one seam is updated.
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
                name: 'names both attribution fields from the resolved context',
                code: `db.agentProposal.create({ data: { tenantId: t, agentId: ctx.agentId ?? null, policyCardVersion: pin } });`,
            },
            {
                name: 'an explicit null and the no-card sentinel are correct values — a human-started run has neither',
                code: `db.workflowRun.create({ data: { tenantId: t, agentId: null, policyCardVersion: NO_POLICY_CARD } });`,
            },
            {
                name: 'order does not matter — the rule reads names, not positions',
                code: `db.workflowRun.create({ data: { policyCardVersion: 3, tenantId: t, agentId: a } });`,
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
                name: 'upsert names both fields in its create branch',
                code: `db.agentProposal.upsert({ where: { id }, create: { agentId: null, policyCardVersion: 0 }, update: { status: s } });`,
            },
            {
                name: 'a bare identifier argument carries no object literal to inspect',
                code: `db.agentProposal.create(args);`,
            },
        ],
        invalid: [
            {
                name: 'a create that never considered attribution at all',
                code: `db.agentProposal.create({ data: { tenantId: t, kind: 'RISK' } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                name: 'the same hole on the workflow side',
                code: `db.workflowRun.create({ data: { tenantId: t, workflowKey: k } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                // The realistic regression: a column is added and one of the
                // two seams is updated. A rule that only fired when BOTH were
                // absent would pass this, and pass every valid case above.
                name: 'names the agent but not the policy version it ran under',
                code: `db.workflowRun.create({ data: { tenantId: t, agentId: a } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                name: 'names the policy version but not the agent',
                code: `db.agentProposal.create({ data: { tenantId: t, policyCardVersion: 2 } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                // ONE report for two missing fields, not two. The count is the
                // assertion: a per-field report would make this `errors: 2`.
                name: 'both missing is still one omission to fix',
                code: `tx.agentProposal.create({ data: { tenantId: t } });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
            {
                name: 'upsert whose create branch forgot them',
                code: `db.workflowRun.upsert({ where: { id }, create: { tenantId: t }, update: {} });`,
                errors: [{ messageId: 'missingAttribution' }],
            },
        ],
    });
});
