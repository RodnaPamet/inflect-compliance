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
const getServerSessionMock = jest.fn();

// The session the EDGE reads — its primary role and `memberships[]` claim —
// as `getServerSession` hands it to the page.
jest.mock('next-auth', () => ({ getServerSession: (...a: unknown[]) => getServerSessionMock(...a) }));
jest.mock('@/auth', () => ({ authOptions: {} }));

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
    startAbilities: { discoveredAgents: boolean; askPage: boolean; frameworks: boolean };
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

/** A session whose claim says `role` in this tenant. */
const sessionAs = (role: string) => ({ user: { id: 'user-1', role, memberships: [{ slug: 'acme', role, tenantId: 't-1' }] } });

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));
    getServerSessionMock.mockResolvedValue(sessionAs('ADMIN'));
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

describe('what the start forms may offer this caller (#4472)', () => {
    const asRole = async (role: 'OWNER' | 'ADMIN' | 'AI_ADMIN' | 'AUDITOR') => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext(role));
        getServerSessionMock.mockResolvedValue(sessionAs(role));
        listWorkflowRunsMock.mockResolvedValue([]);
        return (await render()).startAbilities;
    };

    it.each(['OWNER', 'ADMIN', 'AI_ADMIN'] as const)('offers %s the discovered-agent picker: the edge admits it and it holds the key', async (role) => {
        expect((await asRole(role)).discoveredAgents).toBe(true);
    });

    it('does not offer it to an AUDITOR: the key is held, but the edge refuses the route', async () => {
        expect((await asRole('AUDITOR')).discoveredAgents).toBe(false);
    });

    it('reads the MEMBERSHIP role the edge reads, not a custom role’s base', async () => {
        // A READER membership with a custom role built on ADMIN: `ctx.role` is
        // the base, ADMIN, but the edge reads READER and refuses the route.
        const admin = makeRequestContext('ADMIN');
        getTenantCtxMock.mockResolvedValue(admin);
        getServerSessionMock.mockResolvedValue(sessionAs('READER'));
        listWorkflowRunsMock.mockResolvedValue([]);
        expect((await render()).startAbilities.discoveredAgents).toBe(false);
    });

    it('does not offer it to an ADMIN membership whose custom role holds neither inventory key', async () => {
        const base = makeRequestContext('ADMIN');
        getTenantCtxMock.mockResolvedValue(
            makeRequestContext('ADMIN', {
                appPermissions: {
                    ...base.appPermissions,
                    admin: { ...base.appPermissions.admin, agent_registry: false, agent_registry_view: false },
                },
            }),
        );
        listWorkflowRunsMock.mockResolvedValue([]);
        expect((await render()).startAbilities.discoveredAgents).toBe(false);
    });

    it('offers nothing without a session', async () => {
        getServerSessionMock.mockResolvedValue(null);
        listWorkflowRunsMock.mockResolvedValue([]);
        expect((await render()).startAbilities.discoveredAgents).toBe(false);
    });

    it('links to the Ask page exactly when its own gate, controls.view, is held', async () => {
        listWorkflowRunsMock.mockResolvedValue([]);
        expect((await render()).startAbilities.askPage).toBe(true);
        const base = makeRequestContext('ADMIN');
        getTenantCtxMock.mockResolvedValue(
            makeRequestContext('ADMIN', {
                appPermissions: { ...base.appPermissions, controls: { ...base.appPermissions.controls, view: false } },
            }),
        );
        expect((await render()).startAbilities.askPage).toBe(false);
    });

    it('offers the framework picker exactly when frameworks.view, the catalogue’s only check, is held (#4533)', async () => {
        listWorkflowRunsMock.mockResolvedValue([]);
        // The roles the page admits; every built-in role holds frameworks.view.
        for (const role of ['OWNER', 'ADMIN', 'AI_ADMIN', 'AUDITOR'] as const) {
            getTenantCtxMock.mockResolvedValue(makeRequestContext(role));
            expect({ role, frameworks: (await render()).startAbilities.frameworks }).toEqual({ role, frameworks: true });
        }
        const base = makeRequestContext('ADMIN');
        getTenantCtxMock.mockResolvedValue(
            makeRequestContext('ADMIN', {
                appPermissions: { ...base.appPermissions, frameworks: { ...base.appPermissions.frameworks, view: false } },
            }),
        );
        expect((await render()).startAbilities.frameworks).toBe(false);
    });
});
