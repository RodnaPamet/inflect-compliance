/**
 * THE AI DECISION LOG, rendered (#4896), against the real `messages/en.json`.
 *
 *   1. ROWS SPEAK IN WORDS: the kind of call (a run by its workflow's name), the
 *      tool server by its connection's name, the guard's verdict, a tool call's
 *      result — never the stored key, `mcp:<id>` or `guard: CLEAN`.
 *   2. A ROW LINKS TO WHERE IT CAME FROM: its run (where it is reviewed), the
 *      proposal queue, its agent.
 *   3. THE LOG CAN BE NARROWED, and says so: by review, by kind, by agent, by
 *      fingerprint, with a way back to everything.
 *   4. A CAPPED WINDOW SAYS IT IS ONE.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) v = (v as string).split(`{${p}}`).join(String(val));
        return v as string;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/agents/decisions',
    useSearchParams: () => new URLSearchParams(),
}));

import { DecisionsClient, type DecisionRow } from '@/app/t/[tenantSlug]/(app)/agents/decisions/DecisionsClient';

interface DecisionMessages {
    guard: Record<string, string>;
    feature: Record<string, string>;
    toolSummary: Record<string, string>;
    outcomeFilter: Record<string, string>;
    reviewRun: string;
    openRun: string;
    capped: string;
    emptyNarrowedTitle: string;
    emptyTitle: string;
}
const D = (require('../../messages/en.json') as { agents: { decisions: DecisionMessages } }).agents.decisions;

const row = (over: Partial<DecisionRow>): DecisionRow => ({
    id: 'd',
    feature: 'assistant',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    inputDigest: 'sha256:0123456789abcdef',
    outputSummary: null,
    guardVerdict: null,
    humanOutcome: 'PENDING',
    tokensIn: null,
    tokensOut: null,
    latencyMs: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    runId: null,
    agentId: null,
    ...over,
});

const ROWS: DecisionRow[] = [
    row({ id: 'run', feature: 'agentic-run:posture-review', runId: 'run_1', agentId: 'agt_1', guardVerdict: 'CLEAN' }),
    row({
        id: 'tool',
        feature: 'agentic-tool:external',
        provider: 'mcp:conn_1',
        model: null,
        outputSummary: 'external failed',
        humanOutcome: 'AUTONOMOUS',
        runId: 'run_1',
    }),
    row({ id: 'prop', feature: 'agent-proposal', guardVerdict: 'FLAGGED provenance=agent rules=r1', humanOutcome: 'PENDING' }),
    row({ id: 'legacy', feature: 'legacy-identity-match', guardVerdict: 'malicious', humanOutcome: 'ACCEPTED' }),
];

const renderPage = (over: Partial<React.ComponentProps<typeof DecisionsClient>> = {}) =>
    render(
        <DecisionsClient
            tenantSlug="acme"
            decisions={ROWS}
            digest={null}
            agentNames={{ agt_1: 'Posture reviewer' }}
            connectionNames={{ conn_1: 'Entra (production)' }}
            workflowNames={{ 'posture-review': 'Posture review' }}
            canReviewProposals
            canInvestigate
            {...over}
        />,
    );

beforeEach(() => mockPush.mockReset());

it('words each row’s kind, server, guard verdict and tool result', () => {
    renderPage();
    const run = screen.getByTestId('decision-run');
    expect(run).toHaveTextContent('Agent run: Posture review');
    expect(run).toHaveTextContent(D.guard.CLEAN);
    const tool = screen.getByTestId('decision-tool');
    expect(tool).toHaveTextContent(D.feature.tool);
    expect(tool).toHaveTextContent('on Entra (production)');
    expect(tool).toHaveTextContent(D.toolSummary.failed);
    expect(tool).not.toHaveTextContent('mcp:');
    expect(screen.getByTestId('decision-prop')).toHaveTextContent(D.guard.FLAGGED);
    expect(screen.getByTestId('decision-prop')).not.toHaveTextContent('provenance=');
    expect(screen.getByTestId('decision-legacy')).toHaveTextContent(D.guard.MALICIOUS);
    expect(screen.getByTestId('decision-legacy')).toHaveTextContent(D.feature.matching);
});

it('links a row to where it is reviewed, and to its agent', () => {
    renderPage();
    const toRun = screen.getByTestId('decision-run-run');
    expect(toRun).toHaveAttribute('href', '/t/acme/agents/runs/run_1');
    expect(toRun).toHaveTextContent(D.reviewRun);
    expect(screen.getByTestId('decision-run-tool')).toHaveTextContent(D.openRun);
    expect(screen.getByTestId('decision-proposals-prop')).toHaveAttribute('href', '/t/acme/agents/proposals');
    const agent = screen.getByTestId('decision-agent-run');
    expect(agent).toHaveAttribute('href', '/t/acme/agents/agt_1');
    expect(agent).toHaveTextContent('Posture reviewer');
});

it('narrows by review through links that keep the other filters', () => {
    renderPage({ filters: { outcome: null, kind: 'run', agentId: null } });
    const filters = screen.getByTestId('decisions-filters');
    const pending = within(filters).getByRole('link', { name: D.outcomeFilter.PENDING });
    expect(pending.getAttribute('href')).toBe('/t/acme/agents/decisions?outcome=PENDING&kind=run');
    expect(screen.getByTestId('decisions-show-all')).toHaveAttribute('href', '/t/acme/agents/decisions');
});

it('the fingerprint narrows to every decision over that content', () => {
    renderPage();
    expect(screen.getByTestId('decision-digest-run').getAttribute('href')).toBe(
        '/t/acme/agents/decisions?digest=sha256%3A0123456789abcdef',
    );
});

it('says when the list is cut, and offers no "show all" when nothing is narrowed', () => {
    renderPage({ capped: 100 });
    expect(screen.getByTestId('decisions-capped')).toHaveTextContent(D.capped.replace('{count}', '100'));
    expect(screen.queryByTestId('decisions-show-all')).toBeNull();
});

it('a narrowed view with nothing in it says the filters matched nothing', () => {
    renderPage({ decisions: [], filters: { outcome: 'PENDING', kind: null, agentId: null } });
    expect(screen.getByText(D.emptyNarrowedTitle)).toBeInTheDocument();
    expect(screen.queryByText(D.emptyTitle)).toBeNull();
});

it('names the agent a view is narrowed to, with a way back', () => {
    renderPage({ filters: { outcome: null, kind: null, agentId: 'agt_1' } });
    expect(screen.getByTestId('decisions-agent-filter')).toHaveTextContent('Showing only Posture reviewer.');
});
