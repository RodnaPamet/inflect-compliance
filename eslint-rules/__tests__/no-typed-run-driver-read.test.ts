/**
 * `local/no-typed-run-driver-read` — RuleTester.
 *
 * The `valid` cases are the load-bearing half, as the README asks: an
 * invalid-only suite passes against a rule that flags every `workflowRun` call.
 * Each narrowing the rule performs — the method set, a `select` that leaves the
 * column out, the exact `omit` shape, the `_count` skip, the `runs` delegate
 * scoping and the `where` filter that is not a read — has a case here that goes
 * red if it breaks.
 *
 * The invalid cases are the shapes the eleven sites #4241 measured took before the
 * fix (a bare `findFirst`, an `include` without `omit`, an `update` returning
 * the row, a `select` naming the column), plus the near-misses that look like
 * the fix and are not: `omit` naming the wrong column or saying `false`.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-typed-run-driver-read');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/no-typed-run-driver-read', () => {
    ruleTester.run('no-typed-run-driver-read', rule, {
        valid: [
            {
                name: 'a whole-row read that omits the column',
                code: `db.workflowRun.findFirst({ where: { id, tenantId }, omit: { driver: true } });`,
            },
            {
                name: 'omit combines with include, which is how the run page reads',
                code: `db.workflowRun.findFirst({ where: { id }, omit: { driver: true }, include: { steps: { orderBy: { seq: 'asc' } } } });`,
            },
            {
                name: 'a select that leaves the column out',
                code: `db.workflowRun.findMany({ where: { tenantId }, select: { id: true, status: true } });`,
            },
            {
                name: 'a select that says driver: false is a select without it',
                code: `db.workflowRun.findFirst({ where: { id }, select: { id: true, driver: false } });`,
            },
            {
                name: 'a select beside a spread decides on its own — the reaper pages this way',
                code: `db.workflowRun.findMany({ where: w, select: { id: true }, take: 50, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });`,
            },
            {
                name: 'a record-returning write that omits the column',
                code: `db.workflowRun.update({ where: { id }, data: { status: 'FAILED' }, omit: { driver: true } });`,
            },
            {
                name: 'a create that selects its id',
                code: `db.workflowRun.create({ data: { tenantId, agentId: null, policyCardVersion: 0 }, select: { id: true } });`,
            },
            {
                name: 'count-shaped calls return no row',
                code: `db.workflowRun.count({ where: { tenantId } }); db.workflowRun.updateMany({ where: { id }, data: { status: 'PAUSED' } }); db.workflowRun.aggregate({ _sum: { costTokens: true } });`,
            },
            {
                name: 'grouping by another column',
                code: `db.workflowRun.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } });`,
            },
            {
                name: 'another model is none of this rule’s business',
                code: `db.risk.findMany({ where: { tenantId } });`,
            },
            {
                name: 'a relation filter in a where is not a read of the run',
                code: `db.workflowStep.count({ where: { tenantId, run: { agentId } } }); db.workflowStep.findMany({ where: { run: { agentId } }, select: { id: true } });`,
            },
            {
                name: 'a relation read of a run that selects around the column',
                code: `db.agentProposal.findMany({ where: { tenantId }, include: { run: { select: { id: true, status: true } } } });`,
            },
            {
                name: 'a relation read of a run that omits the column',
                code: `db.workflowStep.findMany({ where: { tenantId }, include: { run: { omit: { driver: true } } } });`,
            },
            {
                name: 'a relation COUNT returns a number',
                code: `db.registeredAgent.findMany({ include: { _count: { select: { runs: true } } } });`,
            },
            {
                name: '`runs` on a control test plan is ControlTestRun, not WorkflowRun',
                code: `db.controlTestPlan.findFirst({ where: { id }, include: { runs: { orderBy: { createdAt: 'desc' }, take: 10 } } });`,
            },
            {
                name: 'a relation the query explicitly leaves out',
                code: `db.agentProposal.findFirst({ where: { id }, include: { run: false } });`,
            },
        ],
        invalid: [
            {
                name: 'the run store: a whole-row read with no select and no omit',
                code: `db.workflowRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'the run page: an include returns every scalar of the run too',
                code: `db.workflowRun.findFirst({ where: { id }, include: { steps: true } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'the run list',
                code: `db.workflowRun.findMany({ where: { tenantId }, take: 50, include: { _count: { select: { proposals: true } } } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'an update RETURNS the row, so it fails after the statement ran',
                code: `db.workflowRun.update({ where: { id }, data: { status: 'FAILED' } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a delete returns the row it deleted',
                code: `db.workflowRun.delete({ where: { id } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a bare call returns whole rows',
                code: `db.workflowRun.findMany();`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'selecting the column names it to the typed client',
                code: `db.workflowRun.findFirst({ where: { id }, select: { id: true, driver: true } });`,
                errors: [{ messageId: 'selectsDriver' }],
            },
            {
                name: 'an omit of a different column is not the fix',
                code: `db.workflowRun.findFirst({ where: { id }, omit: { contextJson: true } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'omit: { driver: false } keeps the column',
                code: `db.workflowRun.findFirst({ where: { id }, omit: { driver: false } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a select or an argument held in a variable cannot be checked',
                code: `db.workflowRun.findFirst({ where: { id }, select: RUN_FIELDS }); db.workflowRun.findFirst(args);`,
                errors: [{ messageId: 'unverifiable' }, { messageId: 'unverifiable' }],
            },
            {
                name: 'a top-level spread with no select or omit beside it',
                code: `db.workflowRun.findMany({ ...args });`,
                errors: [{ messageId: 'unverifiable' }],
            },
            {
                name: 'grouping by the column returns it',
                code: `db.workflowRun.groupBy({ by: ['status', 'driver'], _count: { _all: true } });`,
                errors: [{ messageId: 'groupsByDriver' }],
            },
            {
                name: 'a parent row that includes its run whole',
                code: `db.agentProposal.findMany({ where: { tenantId }, include: { run: true } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a parent row that includes its run with only an orderBy',
                code: `db.tenant.findUnique({ where: { id }, include: { workflowRuns: { take: 5 } } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a relation select that names the column',
                code: `db.discoveredAgentAttribution.findFirst({ select: { id: true, run: { select: { id: true, driver: true } } } });`,
                errors: [{ messageId: 'selectsDriver' }],
            },
            {
                name: '`runs` on the register IS WorkflowRun',
                code: `db.registeredAgent.findFirst({ where: { id }, include: { runs: true } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a run reached through another relation',
                code: `db.agentProposal.findMany({ include: { step: { include: { run: true } } } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
            {
                name: 'a run reached back from its own relation',
                code: `db.workflowRun.findFirst({ where: { id }, omit: { driver: true }, include: { proposals: { include: { run: true } } } });`,
                errors: [{ messageId: 'returnsDriver' }],
            },
        ],
    });
});
