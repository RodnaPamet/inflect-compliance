/**
 * The agent runs page's server half (#4472) — what it reads and hands the client.
 *
 *   - The list reads ONE PAST its cap, so a cut list is a fact: it used to keep
 *     the usecase's default 50 with nothing on screen to say more existed.
 *   - Each row carries the workflow's NAME, as the run's own page does, rather
 *     than only its key.
 *   - Each workflow carries its `requiredInput`, so the client can build the
 *     start form from the definition's declaration.
 */
import * as React from 'react';

const getTenantCtxMock = jest.fn();
const listWorkflowRunsMock = jest.fn();

jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/workflow-runs', () => ({
    listWorkflowRuns: (...a: unknown[]) => listWorkflowRunsMock(...a),
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient', () => ({
    AgentRunsClient: () => null,
}));

import AgentRunsPage from '@/app/t/[tenantSlug]/(app)/agents/runs/page';
import { makeRequestContext } from '../helpers/make-context';

type ClientProps = {
    runs: Array<{ id: string; workflowKey: string; workflowName: string; pendingProposals: number }>;
    truncated: boolean;
    workflows: Array<{ key: string; name: string; requiredInput?: readonly string[] }>;
};

async function render(): Promise<ClientProps> {
    const el = (await AgentRunsPage({ params: Promise.resolve({ tenantSlug: 'acme' }) })) as React.ReactElement<ClientProps>;
    return el.props;
}

const run = (i: number, workflowKey = 'audit-prep') => ({
    id: `run-${i}`,
    workflowKey,
    status: 'COMPLETED',
    stepCount: 1,
    costTokens: 10,
    driver: 'STATIC',
    startedAt: new Date('2026-10-01T10:00:00Z'),
    completedAt: null,
    approvalExpiresAt: null,
    summary: null,
    _count: { proposals: i % 3 },
});

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));
});

describe('the run list', () => {
    it('reads one past the cap, and reports a cut list as truncated', async () => {
        listWorkflowRunsMock.mockResolvedValue(Array.from({ length: 51 }, (_, i) => run(i)));
        const props = await render();
        expect(listWorkflowRunsMock).toHaveBeenCalledWith(expect.anything(), { take: 51 });
        expect(props.runs).toHaveLength(50);
        expect(props.truncated).toBe(true);
    });

    it('a list of exactly the cap is not truncated', async () => {
        listWorkflowRunsMock.mockResolvedValue(Array.from({ length: 50 }, (_, i) => run(i)));
        const props = await render();
        expect(props.runs).toHaveLength(50);
        expect(props.truncated).toBe(false);
    });

    it('names each run by its workflow, and by its key when nothing is registered under it', async () => {
        listWorkflowRunsMock.mockResolvedValue([run(1, 'audit-prep'), run(2, 'profile:abc')]);
        const props = await render();
        expect(props.runs.map((r) => r.workflowName)).toEqual(['Audit prep', 'profile:abc']);
    });

    it('projects the pending-proposal count the paused-run hint reads', async () => {
        listWorkflowRunsMock.mockResolvedValue([run(2)]);
        const props = await render();
        expect(props.runs[0].pendingProposals).toBe(2);
    });
});

describe('the workflows offered', () => {
    it('carry their declared requiredInput', async () => {
        listWorkflowRunsMock.mockResolvedValue([]);
        const props = await render();
        const byKey = Object.fromEntries(props.workflows.map((w) => [w.key, w.requiredInput]));
        expect(byKey['audit-prep']).toEqual(['frameworkKey']);
        expect(byKey['audit-narrative']).toEqual(['periodLabel']);
        expect(byKey['diagnostic']).toEqual([]);
    });
});
