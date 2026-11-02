/** @jest-environment jsdom */

/**
 * The review quality page names the people and agents it judges, words each
 * approval rung, and reads its summary as one sentence (#4932).
 */
import * as React from 'react';
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

describe('review quality page', () => {
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
