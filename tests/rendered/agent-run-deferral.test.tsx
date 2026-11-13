/**
 * A RUN PARKED ON A DEFERRED TOOL CALL, AS THE PAGES SHOW IT (Step 2f,
 * "6. The ledger, Art 12 and the UI", #5530).
 *
 *   • the run page shows a parked run as waiting for a decision, with the
 *     proposal's kind, its deadline and a link to it, and offers the proposal
 *     in place of Resume, which the server refuses;
 *   • its timeline marks the checkpoint as deferred to a person, and a decided
 *     one names who decided;
 *   • the runs list offers "Open proposal" in place of Resume;
 *   • the proposals page marks a proposal a run is waiting on, linking to it.
 */
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/runs/run-1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(ns, key);
        if (typeof v !== 'string') return key;
        // An ICU plural is formatted for real, so a count reads as the
        // product shows it rather than as the raw pattern.
        if (params) {
            v = (v as string).replace(
                /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g,
                (_m, name: string, one: string, other: string) =>
                    (Number(params[name]) === 1 ? one : other).replace(/#/g, String(params[name])),
            );
        }
        if (params) for (const [p, val] of Object.entries(params)) {
            v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import {
    AgentRunDetailClient,
    type RunDeferral,
    type RunHeader,
    type RunStepRow,
} from '@/app/t/[tenantSlug]/(app)/agents/runs/[runId]/AgentRunDetailClient';
import { AgentRunsClient, type RunRow } from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';

const EN = jest.requireActual('../../messages/en.json') as {
    agents: { runs: { openProposal: string; resume: string; detail: { deferral: Record<string, string> } } };
};
const DEF = EN.agents.runs.detail.deferral;

const RUN: RunHeader = {
    id: 'run-1',
    workflowKey: 'agent-profile:p1@v1',
    workflowName: 'Behaviour v1',
    status: 'AWAITING_APPROVAL',
    driver: 'TOOL_RUNNER',
    stepCount: 2,
    costTokens: 1200,
    startedAt: '2026-11-13T10:00:00.000Z',
    completedAt: null,
    summary: null,
    errorMessage: null,
    parentExecutionId: null,
    mountedSkills: null,
};

const WAITING: RunDeferral = {
    status: 'WAITING',
    decision: null,
    proposalId: 'prop-1',
    proposalKind: 'RISK',
    toolCalled: 'propose_risks',
    stepSeq: 0,
    parkedAt: '2026-11-13T10:01:00.000Z',
    deadline: '2026-11-20T10:01:00.000Z',
    decidedAt: null,
    decidedByUserId: null,
};

function step(seq: number, kind: string, status: string): RunStepRow {
    return {
        id: `s-${seq}`,
        seq,
        kind,
        status,
        tool: kind === 'TOOL_CALL' ? 'propose_risks' : null,
        scope: null,
        guardVerdict: null,
        guardRuleIds: [],
        costTokens: null,
        label: kind,
        at: '2026-11-13T10:01:00.000Z',
        actorUserId: null,
        inputJson: null,
        outputJson: null,
        decisionDigest: null,
        delegation: null,
        subagent: null,
        compaction: null,
        proposals: [],
    } as RunStepRow;
}
const STEPS = [step(0, 'TOOL_CALL', 'DONE'), step(1, 'HUMAN_CHECKPOINT', 'PENDING')];

describe('the run page', () => {
    it('shows a parked run as waiting for a decision, and offers the proposal in place of Resume', () => {
        render(<AgentRunDetailClient tenantSlug="acme" run={RUN} steps={STEPS} deferral={WAITING} canOperate />);
        const notice = screen.getByTestId('run-deferral-waiting');
        expect(within(notice).getByTestId('run-deferral-proposal-link').getAttribute('href')).toBe(
            '/t/acme/agents/proposals#proposal-prop-1',
        );
        expect(screen.getByTestId('run-detail-open-proposal').textContent).toBe(EN.agents.runs.openProposal);
        expect(screen.queryByTestId('run-detail-resume')).toBeNull();
        // The checkpoint reads as deferred to a person.
        expect(screen.getAllByText(DEF.checkpoint).length).toBeGreaterThan(0);
    });

    it('a run paused for any other reason keeps its Resume (positive control)', () => {
        render(<AgentRunDetailClient tenantSlug="acme" run={RUN} steps={STEPS} deferral={null} canOperate />);
        expect(screen.getByTestId('run-detail-resume')).toBeInTheDocument();
        expect(screen.queryByTestId('run-detail-open-proposal')).toBeNull();
        expect(screen.queryByText(DEF.checkpoint)).toBeNull();
    });

    it('a decided deferral names who decided', () => {
        render(
            <AgentRunDetailClient
                tenantSlug="acme"
                run={{ ...RUN, status: 'COMPLETED' }}
                steps={STEPS}
                deferral={{ ...WAITING, status: 'RESUMED', decision: 'REJECTED', decidedAt: '2026-11-13T11:00:00.000Z', decidedByUserId: 'user-9' }}
            />,
        );
        expect(screen.getByTestId('run-deferral-decided').textContent).toContain('user-9');
        expect(screen.queryByTestId('run-deferral-waiting')).toBeNull();
    });
});

describe('the runs list', () => {
    const ROW: RunRow = {
        id: 'run-1',
        workflowKey: 'agent-profile:p1@v1',
        workflowName: 'Behaviour v1',
        status: 'AWAITING_APPROVAL',
        stepCount: 2,
        costTokens: 1200,
        driver: 'TOOL_RUNNER',
        startedAt: '2026-11-13T10:00:00.000Z',
        completedAt: null,
        approvalExpiresAt: '2026-11-20T10:01:00.000Z',
        summary: null,
        pendingProposals: 1,
        waitingOnProposalId: 'prop-1',
    };

    it('offers Open proposal in place of Resume for a run waiting on one', () => {
        render(<AgentRunsClient tenantSlug="acme" runs={[ROW, { ...ROW, id: 'run-2', waitingOnProposalId: null }]} workflows={[]} canOperate />);
        expect(screen.getByTestId('agent-run-open-proposal-run-1').getAttribute('href')).toBe('/t/acme/agents/proposals#proposal-prop-1');
        expect(screen.queryByTestId('agent-run-resume-run-1')).toBeNull();
        expect(screen.getByTestId('agent-run-resume-run-2')).toBeInTheDocument();
    });
});
