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
 */
import * as fs from 'fs';
import * as path from 'path';

import type { getTenantSecurityConfig } from '@/app-layer/usecases/tenant-security-settings';
import type { listAgentTools } from '@/app-layer/usecases/agent-tool-exposure';
import type { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import type { KillSwitchRecord, listKillSwitches } from '@/app-layer/usecases/agent-kill-switch';
import type { getWorkflowRun, listWorkflowRuns, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import type { RunStepFeed } from '@/app-layer/usecases/workflow-run-steps';
import type { RiskKpiCounts } from '@/app-layer/repositories/RiskRepository';
import type { RunStepFeedRow } from '@/lib/agentic/run-step-projection';
import { assertRequiredInputPresent } from '@/app-layer/usecases/workflow-runs';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

interface ContractRoute {
    method: string;
    path: string;
    route: string;
    credential: 'agent-key' | 'session';
    status: number;
    body: unknown;
}
const CONTRACT = JSON.parse(read('evals/inspect/fixtures/product-contract.json')) as {
    routes: Record<string, ContractRoute>;
};
const R = CONTRACT.routes;

type StartRun = Awaited<ReturnType<typeof startWorkflowRun>>;
type StoredRun = NonNullable<Awaited<ReturnType<typeof getWorkflowRun>>>;
type ListedRuns = Awaited<ReturnType<typeof listWorkflowRuns>>;
type SecurityConfig = Awaited<ReturnType<typeof getTenantSecurityConfig>>;
type AgentTools = Awaited<ReturnType<typeof listAgentTools>>;
type ListedProposal = Awaited<ReturnType<typeof listAgentProposals>>[number];
type KillList = Awaited<ReturnType<typeof listKillSwitches>>;

// What product.py and ledger.py read, field by field, each checked against
// the type the product returns.
const READS = {
    startRun: ['runId'] as const satisfies readonly (keyof StartRun)[],
    getRun: ['status', 'errorMessage', 'costTokens', 'stepCount', 'startedAt', 'completedAt'] as const satisfies readonly (keyof StoredRun)[],
    getSteps: ['steps', 'hasMore', 'cursor'] as const satisfies readonly (keyof RunStepFeed)[],
    step: ['seq', 'kind', 'status', 'tool', 'guardVerdict', 'guardRuleIds', 'costTokens', 'inputJson', 'outputJson', 'decisionDigest', 'delegation', 'proposals', 'at'] as const satisfies readonly (keyof RunStepFeedRow)[],
    stepProposal: ['id', 'kind', 'status'] as const satisfies readonly (keyof RunStepFeedRow['proposals'][number])[],
    riskKpi: ['total'] as const satisfies readonly (keyof RiskKpiCounts)[],
    securitySettings: ['aiResidency'] as const satisfies readonly (keyof SecurityConfig)[],
    agentTools: ['granted'] as const satisfies readonly (keyof AgentTools)[],
    grantedTool: ['toolName'] as const satisfies readonly (keyof AgentTools['granted'][number])[],
    proposal: ['id', 'status', 'createdEntityId'] as const satisfies readonly (keyof ListedProposal)[],
    killList: ['inForce'] as const satisfies readonly (keyof KillList)[],
    killRecord: ['id', 'agentId', 'engagedAt', 'liftedAt'] as const satisfies readonly (keyof KillSwitchRecord)[],
};
// The run list is a bare array: product.py counts its rows.
const listedRunsIsAnArray: readonly unknown[] = [] as unknown as ListedRuns;

const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>);

describe('each route the harness calls exists and serves the method', () => {
    it.each(Object.entries(R))('%s', (_name, r) => {
        const exported = [...read(r.route).matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)].map((m) => m[1]);
        expect(exported).toContain(r.method);
    });

    it('starts runs with the agent key and reads everything else as the OWNER', () => {
        const agentKeyRoutes = Object.entries(R).filter(([, r]) => r.credential === 'agent-key').map(([name]) => name);
        expect(agentKeyRoutes.sort()).toEqual(['startRun', 'startRunMissingInput', 'startRunUnknownWorkflow']);
    });
});

describe('each field the harness reads is in the product type and in the fixture', () => {
    it('the run start answers { runId, status, workflowKey, stepFailures }, never { id }', () => {
        const full = ['runId', 'status', 'workflowKey', 'stepFailures'] as const satisfies readonly (keyof StartRun)[];
        expect(keysOf(R.startRun.body).sort()).toEqual([...full].sort());
        expect(keysOf(R.startRun.body)).toEqual(expect.arrayContaining([...READS.startRun]));
        expect(R.startRun.status).toBe(201);
    });

    it('the run, its step feed and the proposals on a step', () => {
        expect(keysOf(R.getRun.body)).toEqual(expect.arrayContaining([...READS.getRun]));
        const feed = R.getSteps.body as RunStepFeed;
        expect(keysOf(feed)).toEqual(expect.arrayContaining([...READS.getSteps]));
        expect(keysOf(feed.steps[0])).toEqual(expect.arrayContaining([...READS.step]));
        expect(keysOf(feed.steps[0].proposals[0])).toEqual(expect.arrayContaining([...READS.stepProposal]));
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
        const page = /\btake: opts\.take \?\? (\d+)/.exec(functionBodyOf(read('src/app-layer/usecases/workflow-runs.ts'), 'listWorkflowRuns'))?.[1];
        const harnessPage = /^RUN_LIST_PAGE = (\d+)$/m.exec(read('evals/inspect/inflect_inspect/product.py'))?.[1];
        expect(page).toBeDefined();
        expect(harnessPage).toBe(page);
    });
});

describe('the admission sentence task 10 reads its missing keys from', () => {
    it('is the sentence assertRequiredInputPresent throws', () => {
        let message = '';
        try {
            assertRequiredInputPresent({ key: 'ad-hoc-question', requiredInput: ['question'] }, {});
        } catch (err) {
            message = (err as Error).message;
        }
        const body = R.startRunMissingInput.body as { error: { message: string } };
        expect(body.error.message).toBe(message);
        expect(R.startRunMissingInput.status).toBe(400);
    });
});
