/**
 * A paused run says what is ACTUALLY waiting, not what usually is.
 *
 * ── THE WRONG INFORMATION THIS REMOVES ──────────────────────────────────────
 *
 * Every `AWAITING_APPROVAL` row carried one line: "Paused for review — approve
 * its proposals in the agent proposals queue, then Resume." It was rendered on
 * the status alone, on the assumption that a pause means something was
 * proposed.
 *
 * Two pauses break that assumption, and the second is new:
 *
 *   · a HUMAN_CHECKPOINT fires whether or not the run queued anything — the
 *     static driver pauses at the step, not at a proposal;
 *   · a CONTENT-GUARD FLAG pauses a run that queued nothing by construction:
 *     the guard fires in the tool sandwich before the funnel, so the call it
 *     stopped never reached the proposal queue at all.
 *
 * Both sent a reviewer to an empty queue to look for work that was never
 * there — on the page whose whole job is to say where the work is. Same class
 * as the step/tool misattribution fixed in #2774: a governance surface stating
 * something confidently and wrongly.
 *
 * ── WHY THE COUNT AND NOT THE CAUSE ─────────────────────────────────────────
 *
 * The row could have branched on WHY the run paused — a checkpoint, a guard —
 * and that is one more thing to keep in sync with two engines. What a reviewer
 * needs first is whether there is anything to go and approve, and the pending
 * count answers that for every cause, including causes not invented yet.
 */
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/runs',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = lookup(ns, key);
            return typeof v === 'string' ? v : key;
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { AgentRunsClient, type RunRow } from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';

const EN = jest.requireActual('../../messages/en.json') as {
    agents: { runs: { proposalsLink: string; awaitingApprovalNoProposals: string } };
};

const PAUSED: RunRow = {
    id: 'run-1',
    workflowKey: 'nightly-review',
    status: 'AWAITING_APPROVAL',
    stepCount: 3,
    costTokens: 1200,
    driver: 'FLUE',
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    summary: null,
    pendingProposals: 0,
};

const renderRuns = (runs: RunRow[]) =>
    render(<AgentRunsClient tenantSlug="acme" initialRuns={runs} workflows={[]} canOperate={false} />);

const rowOf = (id: string) => document.getElementById(`run-${id}`) as HTMLElement;

describe('a paused run with nothing queued does not send anyone to the queue', () => {
    it('renders no proposals link at all', () => {
        // The assertion with teeth, and it is the ABSENCE one: a hint that
        // merely reworded itself while keeping the link would still walk a
        // reviewer to an empty page.
        renderRuns([PAUSED]);
        const row = rowOf('run-1');
        expect(within(row).queryByText(EN.agents.runs.proposalsLink)).toBeNull();
        expect(row.querySelector('a[href="/t/acme/agents/proposals"]')).toBeNull();
    });

    it('and says so, rather than saying nothing', () => {
        // Silence would be its own defect: the run is paused, the operator
        // needs to know it is on them, and an unexplained pause reads as a
        // stuck run.
        renderRuns([PAUSED]);
        expect(
            within(rowOf('run-1')).getByText(EN.agents.runs.awaitingApprovalNoProposals),
        ).toBeInTheDocument();
    });
});

describe('a paused run WITH proposals still points at them', () => {
    it('renders the link', () => {
        // The positive control. Without it, deleting the hint entirely would
        // pass every assertion above.
        renderRuns([{ ...PAUSED, pendingProposals: 2 }]);
        const row = rowOf('run-1');
        expect(within(row).getByText(EN.agents.runs.proposalsLink)).toBeInTheDocument();
        expect(row.querySelector('a[href="/t/acme/agents/proposals"]')).not.toBeNull();
    });

    it('and does NOT also show the nothing-queued line', () => {
        renderRuns([{ ...PAUSED, pendingProposals: 2 }]);
        expect(
            within(rowOf('run-1')).queryByText(EN.agents.runs.awaitingApprovalNoProposals),
        ).toBeNull();
    });
});

describe('the hint is per row, not per list', () => {
    it('two paused runs get the hint each deserves', () => {
        // A hint computed from `runs[0]`, or hoisted out of the map, passes
        // every single-row case above and is wrong on the only list that
        // matters — one holding both kinds of pause.
        renderRuns([PAUSED, { ...PAUSED, id: 'run-2', pendingProposals: 3 }]);
        expect(within(rowOf('run-1')).queryByText(EN.agents.runs.proposalsLink)).toBeNull();
        expect(within(rowOf('run-2')).getByText(EN.agents.runs.proposalsLink)).toBeInTheDocument();
    });
});

describe('a run that is not paused gets no hint either way', () => {
    it('says nothing about approval on a COMPLETED run', () => {
        renderRuns([{ ...PAUSED, status: 'COMPLETED', pendingProposals: 5 }]);
        const row = rowOf('run-1');
        expect(within(row).queryByText(EN.agents.runs.proposalsLink)).toBeNull();
        expect(within(row).queryByText(EN.agents.runs.awaitingApprovalNoProposals)).toBeNull();
    });
});
