/**
 * #5374 — the run page names an agent profile run by its version.
 *
 * A profile key (`agent-profile:<id>@v3:test-run`) has no registered workflow
 * definition, so the page used to fall back to the raw key for the run's
 * title, its breadcrumb and the abort dialog. It now names it "Behaviour v3 —
 * Test run", and still shows any other unregistered key as stored.
 */
import * as React from 'react';

const getTenantCtxMock = jest.fn();
const getWorkflowRunMock = jest.fn();

jest.mock('next-intl/server', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    return {
        getTranslations: async (ns: string) => (key: string, params: Record<string, unknown> = {}) => {
            const v = `${ns}.${key}`
                .split('.')
                .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
            if (typeof v !== 'string') return key;
            return Object.entries(params).reduce((text, [p, val]) => text.replace(`{${p}}`, String(val)), v);
        },
    };
});
jest.mock('next/navigation', () => ({
    notFound: () => {
        throw new Error('notFound');
    },
}));
jest.mock('@/app-layer/context', () => ({ getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a) }));
jest.mock('@/app-layer/usecases/workflow-runs', () => ({ getWorkflowRun: (...a: unknown[]) => getWorkflowRunMock(...a) }));
jest.mock('@/app-layer/usecases/workflow-run-provenance', () => ({
    readWorkflowRunProvenance: async () => ({ startedBy: null, ruleName: null }),
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/runs/[runId]/AgentRunDetailClient', () => ({
    AgentRunDetailClient: () => null,
}));

import AgentRunDetailPage from '@/app/t/[tenantSlug]/(app)/agents/runs/[runId]/page';
import { makeRequestContext } from '../helpers/make-context';

async function workflowNameFor(workflowKey: string): Promise<string> {
    getWorkflowRunMock.mockResolvedValue({
        id: 'run-1',
        workflowKey,
        status: 'EMPTY_CATALOGUE',
        driver: 'TOOL_RUNNER',
        stepCount: 0,
        costTokens: 0,
        startedAt: new Date('2026-11-12T10:00:00Z'),
        completedAt: null,
        summary: null,
        errorMessage: null,
        steps: [],
        proposals: [],
    });
    const el = (await AgentRunDetailPage({
        params: Promise.resolve({ tenantSlug: 'acme', runId: 'run-1' }),
    })) as React.ReactElement<{ run: { workflowName: string } }>;
    return el.props.run.workflowName;
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));
});

describe('the run page names a profile run (#5374)', () => {
    it('a Test run: "Behaviour v3 — Test run"', async () => {
        expect(await workflowNameFor('agent-profile:prof1@v3:test-run')).toBe('Behaviour v3 — Test run');
    });

    it('a run of the version in force: "Behaviour v2"', async () => {
        expect(await workflowNameFor('agent-profile:prof1@v2')).toBe('Behaviour v2');
    });

    it('a registered workflow keeps its own name, and an unknown key is shown as stored', async () => {
        expect(await workflowNameFor('audit-prep')).toBe('Audit prep');
        expect(await workflowNameFor('agent-profile:not a key')).toBe('agent-profile:not a key');
    });
});
