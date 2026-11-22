/**
 * The Inspect harness reads the product through its own REST routes
 * (`evals/inspect/inflect_inspect/product.py`). Its pytest stubs once invented
 * the shapes it parsed (a run start answering `{ id }`, a kill switch listed
 * under `switches`, a proposal read at a route that does not exist), so every
 * one of those reads passed against the stub and failed against the product.
 *
 * `evals/inspect/fixtures/product-contract.json` is now the one place those
 * shapes are written down. This test holds it to the product: each route file
 * exists and serves the method, and each field the harness reads is a key of
 * the type the product returns (the `satisfies` clauses are checked by
 * `npm run typecheck`; the runtime half checks the fixture carries them). The
 * pytest suite serves the same bodies to `HttpProduct` over HTTP.
 *
 * A Tool Runner run starts from an automation rule (owner decision,
 * 2026-11-13): the harness creates a task, reads the rule's execution for it
 * by the key `TASK_CREATED` carries, and finds the run among the agent's runs.
 * Those three reads are held here too.
 *
 * A Flue run is the ad-hoc question, which the OWNER asks at
 * `POST /agents/questions`: #5604 refuses `ad-hoc-question` on the generic
 * `POST /agent-runs` (`AD_HOC_QUESTION_USE_QUESTIONS_ROUTE`) for every caller,
 * and the questions route is a person's (`NOT_A_PERSON` for a key). So every
 * route here is called with the OWNER's session, and none with a key.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { getTenantSecurityConfig } from '@/app-layer/usecases/tenant-security-settings';
import type { listAgentTools } from '@/app-layer/usecases/agent-tool-exposure';
import type { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import type { KillSwitchRecord, listKillSwitches } from '@/app-layer/usecases/agent-kill-switch';
import type { getWorkflowRun, listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import type { askAdHocQuestion } from '@/app-layer/usecases/ad-hoc-question';
import type { RunStepFeed } from '@/app-layer/usecases/workflow-run-steps';
import type { RunDecisionRows } from '@/app-layer/usecases/ai-decision-log';
import type { RiskKpiCounts } from '@/app-layer/repositories/RiskRepository';
import type { RunStepFeedRow } from '@/lib/agentic/run-step-projection';
import type { createTask } from '@/app-layer/usecases/task';
import type { listRuleExecutions } from '@/app-layer/usecases/automation-executions';
import type { TaskCreatedData } from '@/app-layer/automation/event-contracts';
import { readAdHocQuestion } from '@/lib/agentic/ad-hoc-question-input';
import { badRequest, toApiErrorResponse } from '@/lib/errors/types';
import { z } from 'zod';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Comments blanked, strings kept: an assertion on code is not satisfied by a note about it.
const readCode = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

interface ContractRoute {
    method: string;
    path: string;
    route: string;
    credential: 'session';
    status: number;
    body: unknown;
}
const CONTRACT = JSON.parse(read('evals/inspect/fixtures/product-contract.json')) as {
    routes: Record<string, ContractRoute>;
};
const R = CONTRACT.routes;

type AskedQuestion = Awaited<ReturnType<typeof askAdHocQuestion>>;
type StoredRun = NonNullable<Awaited<ReturnType<typeof getWorkflowRun>>>;
type ListedRuns = Awaited<ReturnType<typeof listWorkflowRuns>>;
type SecurityConfig = Awaited<ReturnType<typeof getTenantSecurityConfig>>;
type AgentTools = Awaited<ReturnType<typeof listAgentTools>>;
type ListedProposal = Awaited<ReturnType<typeof listAgentProposals>>[number];
type KillList = Awaited<ReturnType<typeof listKillSwitches>>;
type CreatedTask = Awaited<ReturnType<typeof createTask>>;
type RuleExecutions = Awaited<ReturnType<typeof listRuleExecutions>>;

// What product.py and ledger.py read, field by field, each checked against
// the type the product returns.
const READS = {
    askQuestion: ['runId'] as const satisfies readonly (keyof AskedQuestion)[],
    getRun: ['status', 'errorMessage', 'costTokens', 'stepCount', 'startedAt', 'completedAt'] as const satisfies readonly (keyof StoredRun)[],
    getSteps: ['steps', 'hasMore', 'cursor'] as const satisfies readonly (keyof RunStepFeed)[],
    step: ['seq', 'kind', 'status', 'tool', 'guardVerdict', 'guardRuleIds', 'costTokens', 'inputJson', 'outputJson', 'decisionDigest', 'delegation', 'modelTurn', 'proposals', 'at'] as const satisfies readonly (keyof RunStepFeedRow)[],
    stepModelTurn: ['segment', 'call'] as const satisfies readonly (keyof NonNullable<RunStepFeedRow['modelTurn']>)[],
    // D-EV-8: the run's decision rows, joined to its MODEL_CALL steps by digest.
    runDecisions: ['rows', 'truncated'] as const satisfies readonly (keyof RunDecisionRows)[],
    runDecisionRow: ['inputDigest'] as const satisfies readonly (keyof RunDecisionRows['rows'][number])[],
    stepProposal: ['id', 'kind', 'status'] as const satisfies readonly (keyof RunStepFeedRow['proposals'][number])[],
    riskKpi: ['total'] as const satisfies readonly (keyof RiskKpiCounts)[],
    securitySettings: ['aiResidency'] as const satisfies readonly (keyof SecurityConfig)[],
    agentTools: ['granted'] as const satisfies readonly (keyof AgentTools)[],
    grantedTool: ['toolName'] as const satisfies readonly (keyof AgentTools['granted'][number])[],
    proposal: ['id', 'status', 'createdEntityId'] as const satisfies readonly (keyof ListedProposal)[],
    killList: ['inForce'] as const satisfies readonly (keyof KillList)[],
    killRecord: ['id', 'agentId', 'engagedAt', 'liftedAt'] as const satisfies readonly (keyof KillSwitchRecord)[],
    createdTask: ['key'] as const satisfies readonly (keyof CreatedTask)[],
    ruleExecutions: ['items'] as const satisfies readonly (keyof RuleExecutions)[],
    ruleExecution: ['id', 'status', 'triggerPayload'] as const satisfies readonly (keyof RuleExecutions['items'][number])[],
    // The execution's trigger payload is the TASK_CREATED event's data; the
    // harness names its execution by the task's key.
    taskCreatedData: ['key', 'title'] as const satisfies readonly (keyof TaskCreatedData)[],
    listedRun: ['id', 'workflowKey', 'parentExecutionId'] as const satisfies readonly (keyof ListedRuns[number])[],
};
// The run list is a bare array: product.py counts its rows.
const listedRunsIsAnArray: readonly unknown[] = [] as unknown as ListedRuns;

const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>);

describe('each route the harness calls exists and serves the method', () => {
    it.each(Object.entries(R))('%s', (_name, r) => {
        const exported = [...read(r.route).matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)].map((m) => m[1]);
        expect(exported).toContain(r.method);
    });

    it('calls every route as the OWNER and presents no key', () => {
        expect(Object.entries(R).filter(([, r]) => r.credential !== 'session').map(([name]) => name)).toEqual([]);
        expect(read('evals/inspect/inflect_inspect/product.py')).not.toContain('Authorization');
    });
});

describe('each field the harness reads is in the product type and in the fixture', () => {
    it('the question answers 202 { runId }: started, not answered', () => {
        const full = ['runId'] as const satisfies readonly (keyof AskedQuestion)[];
        expect(keysOf(R.askQuestion.body).sort()).toEqual([...full].sort());
        expect(keysOf(R.askQuestion.body)).toEqual(expect.arrayContaining([...READS.askQuestion]));
        expect(R.askQuestion.status).toBe(202);
        expect(R.askQuestion.route).toBe('src/app/api/t/[tenantSlug]/agents/questions/route.ts');
        expect(readCode('src/app/api/t/[tenantSlug]/agents/questions/route.ts')).toContain('return jsonResponse({ runId: started.runId }, { status: 202 });');
    });

    it('the run, its step feed and the proposals on a step', () => {
        expect(keysOf(R.getRun.body)).toEqual(expect.arrayContaining([...READS.getRun]));
        const feed = R.getSteps.body as RunStepFeed;
        expect(keysOf(feed)).toEqual(expect.arrayContaining([...READS.getSteps]));
        expect(keysOf(feed.steps[0])).toEqual(expect.arrayContaining([...READS.step]));
        expect(keysOf(feed.steps[0].proposals[0])).toEqual(expect.arrayContaining([...READS.stepProposal]));
        expect(keysOf(feed.steps[0].modelTurn)).toEqual(expect.arrayContaining([...READS.stepModelTurn]));
    });

    it("the run's decision rows (D-EV-8): every field the route returns, and no text", () => {
        const body = R.getRunDecisions.body as RunDecisionRows;
        const full = ['runId', 'rows', 'truncated'] as const satisfies readonly (keyof RunDecisionRows)[];
        expect(keysOf(body).sort()).toEqual([...full].sort());
        expect(keysOf(body)).toEqual(expect.arrayContaining([...READS.runDecisions]));
        const row = ['id', 'inputDigest', 'agentId', 'createdAt', 'humanOutcome'] as const satisfies readonly (keyof RunDecisionRows['rows'][number])[];
        expect(keysOf(body.rows[0]).sort()).toEqual([...row].sort());
        expect(keysOf(body.rows[0])).toEqual(expect.arrayContaining([...READS.runDecisionRow]));
        expect(R.getRunDecisions.path).toBe('/agent-runs/run_1/decisions');
        expect(readCode('evals/inspect/inflect_inspect/product.py')).toContain('self._ok("GET", f"/agent-runs/{urllib.parse.quote(run_id)}/decisions")');
    });

    it('the risk count is the unpaginated list’s kpiCounts.total', () => {
        const body = R.listRisks.body as { kpiCounts: Record<string, unknown> };
        expect(R.listRisks.path).toBe('/risks');
        expect(keysOf(body.kpiCounts)).toEqual(expect.arrayContaining([...READS.riskKpi]));
        expect(R.listRisks.route).toBe('src/app/api/t/[tenantSlug]/risks/route.ts');
        expect(codeOf(read('src/app/api/t/[tenantSlug]/risks/route.ts'))).toContain('return jsonResponse({ ...result, kpiCounts });');
    });

    it('residency, grants, proposals and the kill switch', () => {
        expect(keysOf(R.securitySettings.body)).toEqual(expect.arrayContaining([...READS.securitySettings]));
        const tools = R.agentTools.body as { granted: unknown[] };
        expect(keysOf(tools)).toEqual(expect.arrayContaining([...READS.agentTools]));
        expect(keysOf(tools.granted[0])).toEqual(expect.arrayContaining([...READS.grantedTool]));
        expect(Array.isArray(R.listProposals.body)).toBe(true);
        expect(keysOf((R.listProposals.body as unknown[])[0])).toEqual(expect.arrayContaining([...READS.proposal]));
        expect(keysOf(R.listKillsInForce.body)).toEqual(expect.arrayContaining([...READS.killList]));
        expect(keysOf(R.engageKill.body)).toEqual(expect.arrayContaining([...READS.killRecord]));
    });

    it('the run list is an array, capped at the page product.py refuses at', () => {
        expect(Array.isArray(R.listRuns.body)).toBe(true);
        expect(listedRunsIsAnArray).toEqual([]);
        expect(Array.isArray(R.listAgentRuns.body)).toBe(true);
        const page = /\btake: opts\.take \?\? (\d+)/.exec(functionBodyOf(read('src/app-layer/usecases/workflow-runs.ts'), 'listWorkflowRuns'))?.[1];
        const harnessPage = /^RUN_LIST_PAGE = (\d+)$/m.exec(read('evals/inspect/inflect_inspect/product.py'))?.[1];
        expect(page).toBeDefined();
        expect(harnessPage).toBe(page);
    });
});

describe('a Tool Runner run starts from its automation rule', () => {
    it('the trigger task, its rule execution and the agent run carry what the harness reads', () => {
        expect(R.createTask.status).toBe(201);
        expect(keysOf(R.createTask.body)).toEqual(expect.arrayContaining([...READS.createdTask]));
        const executions = R.ruleExecutions.body as { items: Array<{ triggerPayload: unknown }> };
        expect(keysOf(executions)).toEqual(expect.arrayContaining([...READS.ruleExecutions]));
        expect(keysOf(executions.items[0])).toEqual(expect.arrayContaining([...READS.ruleExecution]));
        expect(keysOf(executions.items[0].triggerPayload)).toEqual(expect.arrayContaining([...READS.taskCreatedData]));
        expect(keysOf((R.listAgentRuns.body as unknown[])[0])).toEqual(expect.arrayContaining([...READS.listedRun]));
    });

    it('the task create emits TASK_CREATED carrying the key and title, and the run list filters by agent', () => {
        const emit = codeOf(functionBodyOf(read('src/app-layer/usecases/task.ts'), 'createTask'));
        expect(emit).toContain("event: 'TASK_CREATED',");
        expect(emit).toContain('key: task.key,');
        expect(emit).toContain('title: task.title,');
        expect(codeOf(read('src/app/api/t/[tenantSlug]/agent-runs/route.ts'))).toContain("const agentId = sp.get('agentId')?.trim() || undefined;");
    });

    it('the INVOKE_AGENT dispatch starts the run as the AUTOMATION trigger', () => {
        expect(codeOf(read('src/app-layer/jobs/agent-invoke-dispatch.ts'))).toContain("profileTrigger: 'AUTOMATION',");
    });

    it('the harness never starts a run at the generic route', () => {
        // #5367 refuses a profile key there and #5604 the ad-hoc question.
        expect(Object.values(R).some((r) => r.method === 'POST' && r.path === '/agent-runs')).toBe(false);
        for (const name of ['createTask', 'ruleExecutions', 'listAgentRuns']) expect(R[name].credential).toBe('session');
    });
});

describe('a Flue run is the question the OWNER asks (#5604)', () => {
    it('the generic route refuses ad-hoc-question, so the harness asks at the questions route', () => {
        expect(readCode('src/app-layer/usecases/agent-profile-runs.ts')).toContain("'AD_HOC_QUESTION_USE_QUESTIONS_ROUTE',");
        expect(readCode('evals/inspect/inflect_inspect/product.py')).toContain('self._call("POST", "/agents/questions", run_input)');
        expect(readCode('src/app/api/t/[tenantSlug]/agents/questions/route.ts')).toContain("requirePermission<{ tenantSlug: string }>('controls.view',");
    });
});

describe('the refusals task 10 reads its missing keys from', () => {
    it('an absent question is the route schema’s VALIDATION_ERROR naming the field', () => {
        expect(R.askQuestionMissing.route).toBe('src/app/api/t/[tenantSlug]/agents/questions/route.ts');
        expect(readCode('src/app/api/t/[tenantSlug]/agents/questions/route.ts')).toContain('question: z.string(),');
        expect(readCode('src/app/api/t/[tenantSlug]/agents/questions/route.ts')).toContain('.strict();');
        const parsed = z.object({ question: z.string() }).strict().safeParse({});
        expect(parsed.success).toBe(false);
        const { payload, status } = toApiErrorResponse(parsed.error, 'req_1');
        expect(status).toBe(R.askQuestionMissing.status);
        expect(payload).toEqual(R.askQuestionMissing.body);
    });

    it('an empty question is refused by readAdHocQuestion, naming no missing key', () => {
        expect(readCode('src/app-layer/usecases/ad-hoc-question.ts')).toContain('throw badRequest(`${reading.refusal}: ${reading.detail}`);');
        const reading = readAdHocQuestion('');
        expect(reading.ok).toBe(false);
        if (reading.ok) return;
        const { payload, status } = toApiErrorResponse(badRequest(`${reading.refusal}: ${reading.detail}`), 'req_2');
        expect(status).toBe(R.askQuestionEmpty.status);
        expect(payload).toEqual(R.askQuestionEmpty.body);
    });
});
