/** @jest-environment jsdom */

/**
 * The review quality page names the people and agents it judges, words each
 * approval rung, and reads its summary as one sentence (#4932).
 */
import * as React from 'react';

// TYPE-ONLY, so the `jest.mock` below still replaces the runtime module. Taking
// the shape from the real contract means a field added to `SampleAuditRate`
// fails this file rather than being quietly absent from what the page is handed.
import type { SampleAuditRate } from '@/app-layer/usecases/agent-proposal-sample-audit';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl/server', () => {
    const { useTranslations: translatorFor } = jest.requireMock('next-intl') as {
        useTranslations: (ns: string) => unknown;
    };
    return { getTranslations: async (ns: string) => translatorFor(ns) };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/review-quality',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/AgentsViewsMenu', () => ({ AgentsViewsMenu: () => null }));
jest.mock('@/components/layout/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: async () => ({
        tenantId: 't1',
        appPermissions: { admin: { agent_registry: true, view: true, tenant_lifecycle: false } },
    }),
}));

/*
    THE ANSWERING QUEUE'S SEAM.

    Two mocks, and each buys something different. The usecase mock keeps the real
    module — and so Prisma, and so bullmq, which is ESM — out of a jsdom graph;
    without it this suite fails to RUN rather than fails an assertion. The panel
    stub is the seam itself: the panel has its own suite, and what is worth
    asserting HERE is that the page hands it the server's verdict and labels
    resolved on the server, which nothing else tests.
*/
const sampleAudits = [
    {
        id: 'sa-1',
        proposalId: 'p-1',
        proposalKind: 'RISK',
        agentId: 'ag-1',
        sampledAt: new Date('2026-11-10T09:00:00.000Z'),
        approvedAt: new Date('2026-11-08T09:00:00.000Z'),
        outcome: 'PENDING',
        dissentCodes: [],
        refusal: null,
        assignedToUserId: 'u-ana',
    },
    {
        id: 'sa-2',
        proposalId: 'p-2',
        proposalKind: 'POLICY',
        agentId: null,
        sampledAt: new Date('2026-11-11T09:00:00.000Z'),
        approvedAt: null,
        outcome: 'PENDING',
        dissentCodes: [],
        refusal: 'SELF_REVIEW',
        assignedToUserId: null,
    },
];
/*
    MUTABLE, so each THE NUMBER case can set its own figures. The factory closes
    over the binding rather than the value, and it runs on the page's require,
    which the transpiled module performs after these initializers.
*/
let rate: SampleAuditRate = {
    sampled: 40,
    answered: 25,
    pending: 15,
    concurred: 20,
    dissented: 3,
    indeterminate: 2,
    disagreementRate: 3 / 25,
};
jest.mock('@/app-layer/usecases/agent-proposal-sample-audit', () => ({
    ANSWERABLE_OUTCOMES: ['CONCURRED', 'DISSENTED', 'INDETERMINATE'],
    listSampleAuditsForReview: async () => sampleAudits,
    getSampleAuditDisagreementRate: async () => rate,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/review-quality/SampleAuditQueue', () => ({
    SampleAuditQueue: (props: unknown) => (
        <div data-testid="sample-audit-queue-stub" data-props={JSON.stringify(props)} />
    ),
}));

const report = {
    windowDays: 30,
    decided: 12,
    approved: 10,
    rejected: 2,
    truncated: false,
    unobservable: [],
    signals: [
        { code: 'NEVER_REJECTED', scope: 'REVIEWER', subjectId: 'u-ana', observed: 1, threshold: 1, sampleSize: 12 },
        { code: 'SECOND_APPROVER_UNRECORDED', scope: 'AGENT', subjectId: 'ag-1', observed: 3, threshold: 0, sampleSize: 3 },
    ],
    reviewers: [
        {
            reviewerUserId: 'u-ana',
            decided: 12,
            fastestSeconds: null,
            bursts: [],
            estimates: { reported: false, observed: 12, required: 20 },
        },
        {
            reviewerUserId: 'u-gone',
            decided: 1,
            fastestSeconds: null,
            bursts: [],
            estimates: { reported: false, observed: 1, required: 20 },
        },
    ],
    agents: [
        {
            agentId: 'ag-1',
            decided: 12,
            rungCounts: { SINGLE_APPROVER: 9, SECOND_APPROVER: 3 },
            secondApproverDeclared: 3,
            estimates: { reported: false, observed: 12, required: 20 },
        },
    ],
};
jest.mock('@/app-layer/usecases/agent-review-quality', () => ({
    computeAgentReviewQuality: async () => report,
    readReviewQualityNames: async () => ({
        reviewers: { 'u-ana': 'Ana Petrova' },
        agents: { 'ag-1': 'Control reconciler' },
    }),
}));

import ReviewQualityPage from '@/app/t/[tenantSlug]/(app)/agents/review-quality/page';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { reviewQuality: Record<string, string> & { rungName: Record<string, string> } };
};
const RQ = EN.admin.reviewQuality;

async function renderPage() {
    render(await ReviewQualityPage({ params: Promise.resolve({ tenantSlug: 'acme' }) }));
}

/**
 * THE NUMBER (#5738) — the ASI09 disagreement rate, on the page named for it.
 *
 * The usecase computes it and the API route has always returned it beside the
 * queue; this page rendered neither, so it reported how FAST and how OFTEN humans
 * decide and never whether their decisions survive re-examination — the only one
 * of the three an assessor asks about.
 *
 * Four renderings, and each is a way the number could lie:
 *
 *   1. A null rate is PRINTED as not reported, never as 0%. A tenant with a
 *      perfect record and a tenant nobody ever reviewed must not read alike.
 *   2. A null has TWO causes — nothing drawn, and nothing answered of what was
 *      drawn — and only the second is somebody's to act on.
 *   3. The percentage never appears without the count it is over. 0% of 2 and 0%
 *      of 200 are the same number and different evidence.
 *   4. `pending` is shown and is in neither side of the rate.
 */
describe('the retrospective sample audit rate', () => {
    afterEach(() => {
        rate = {
            sampled: 40, answered: 25, pending: 15,
            concurred: 20, dissented: 3, indeterminate: 2,
            disagreementRate: 3 / 25,
        };
    });

    it('prints the rate WITH the number of answers it is over', async () => {
        await renderPage();
        const block = screen.getByTestId('sample-audit-rate');
        expect(block).toHaveTextContent('Disagreement rate 12%');
        // The second number, beside the first. Without it the percentage is a
        // figure that cannot be wrong.
        expect(block).toHaveTextContent('over 25 answered of 40 drawn');
    });

    it('says NOT REPORTED, never 0%, when nothing has been answered', async () => {
        rate = { sampled: 40, answered: 0, pending: 40, concurred: 0, dissented: 0, indeterminate: 0, disagreementRate: null };
        await renderPage();
        const block = screen.getByTestId('sample-audit-rate');
        expect(block).toHaveTextContent('not reported');
        // The denominator survives into the refusal, so a reader learns there is
        // a backlog of 40 rather than that there is nothing to see.
        expect(block).toHaveTextContent('40');
        expect(block.textContent ?? '').not.toContain('0%');
    });

    it('tells "nothing drawn" apart from "nothing answered"', async () => {
        rate = { sampled: 0, answered: 0, pending: 0, concurred: 0, dissented: 0, indeterminate: 0, disagreementRate: null };
        await renderPage();
        const block = screen.getByTestId('sample-audit-rate');
        // Both give a null rate and they are different facts: a sampler that has
        // never run is nobody's backlog.
        expect(block).toHaveTextContent('No approval has been drawn');
        expect(block.textContent ?? '').not.toContain('not reported');
        expect(screen.queryByTestId('sample-audit-rate-breakdown')).toBeNull();
    });

    it('prints the breakdown, so an indeterminate and a concurrence are not one figure', async () => {
        await renderPage();
        const breakdown = screen.getByTestId('sample-audit-rate-breakdown');
        expect(breakdown).toHaveTextContent('Agreed 20');
        expect(breakdown).toHaveTextContent('Disagreed 3');
        expect(breakdown).toHaveTextContent('Could not tell 2');
        expect(breakdown).toHaveTextContent('Waiting for an answer 15');
    });

    it('keeps pending out of the rate it reports', async () => {
        // 3 dissents over 25 ANSWERS is 12%; over 40 drawn it would be 7.5%. The
        // assertion is that the page reports the first.
        await renderPage();
        const block = screen.getByTestId('sample-audit-rate');
        expect(block).toHaveTextContent('12%');
        expect(block.textContent ?? '').not.toContain('8%');
        expect(block.textContent ?? '').not.toContain('7%');
    });

    it('states the denominator on the page, not only in a docstring', async () => {
        await renderPage();
        // An INDETERMINATE answer is IN the denominator here and is excluded from
        // the workpaper-review rate's. A reader comparing the two needs the page
        // to say which construction it is showing.
        expect(screen.getByTestId('sample-audit-rate')).toHaveTextContent('could not tell');
    });
});

describe('review quality page', () => {
    it('hands the answering panel the SERVER\'s verdict and server-resolved labels', async () => {
        await renderPage();
        const raw = screen.getByTestId('sample-audit-queue-stub').getAttribute('data-props');
        if (!raw) throw new Error('the panel received no props');
        const props = JSON.parse(raw) as {
            rows: Array<Record<string, unknown>>;
            outcomes: string[];
            dissentCodes: string[];
        };
        // THE VERDICT, verbatim. A page that recomputed it — or dropped it —
        // would offer an Answer control to the approver of the proposal.
        expect(props.rows.map((r) => r.refusal)).toEqual([null, 'SELF_REVIEW']);
        // Labels resolved here, so the panel holds no catalogue of its own.
        expect(props.rows[0].agentLabel).toBe('Control reconciler');
        expect(props.rows[1].agentLabel).toBe(EN.admin.reviewQuality.unattributed);
        expect(props.rows[0].kindLabel).toBe('Risk');
        // The codes are the module's seven, not a list the page spells.
        expect(props.dissentCodes).toHaveLength(7);
        // WHO WAS ASKED (#5738), resolved by the page's own name lookup. `null`
        // is passed through as null — the panel says "not assigned" and the page
        // does not invent which of the three null causes applied.
        expect(props.rows[0].assigneeLabel).toBe('Ana Petrova');
        expect(props.rows[1].assigneeLabel).toBeNull();
        // And the route to the approval being judged, naming the proposal so the
        // proposals page can fetch it by id rather than hoping it is in view.
        expect(props.rows[0].proposalHref).toBe('/t/acme/agents/proposals?proposal=p-1');
        expect(props.outcomes).not.toContain('PENDING');
        // And no approver identity travelled with them.
        expect(raw).not.toContain('reviewedByUserId');
        expect(raw).not.toContain('approverUserId');
    });


    it('names reviewers and agents instead of printing their ids', async () => {
        await renderPage();
        const reviewers = screen.getAllByTestId('review-quality-reviewer').map((el) => el.textContent);
        expect(reviewers).toEqual(['Ana Petrova', RQ.formerMember]);
        const agent = screen.getByTestId('review-quality-agent');
        expect(within(agent).getByRole('link', { name: 'Control reconciler' })).toHaveAttribute('href', '/t/acme/agents/ag-1');
        expect(document.body.textContent).not.toContain('u-ana');
        expect(document.body.textContent).not.toContain('ag-1');
    });

    it('names each signal’s subject, linking an agent', async () => {
        await renderPage();
        const subjects = screen.getAllByTestId('review-quality-signal-subject');
        expect(subjects[0]).toHaveTextContent('Ana Petrova');
        expect(within(subjects[1]).getByRole('link', { name: 'Control reconciler' })).toBeInTheDocument();
    });

    it('words the approval rungs and keeps the code out of the second-approver note', async () => {
        await renderPage();
        expect(document.body.textContent).toContain(`${RQ.rungName.SINGLE_APPROVER}: 9`);
        expect(document.body.textContent).toContain(`${RQ.rungName.SECOND_APPROVER}: 3`);
        expect(document.body.textContent).not.toContain('SECOND_APPROVER');
        expect(document.body.textContent).not.toContain('SINGLE_APPROVER');
    });

    it('reads the summary as one sentence', async () => {
        await renderPage();
        expect(screen.getByTestId('review-quality-summary').textContent).toContain('Last 30 days');
        expect(screen.getByTestId('review-quality-summary').textContent).toContain('10 approved');
    });
});
