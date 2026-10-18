/**
 * #3674, deploy 1 of 2 — the access-review pages read an AGENT campaign.
 *
 * Deploy 1 writes no AGENT campaign, so these render rows shaped as deploy 2
 * writes them: that is the case they exist for, because a container running
 * this build serves pages during deploy 2's rollout, when the first such rows
 * appear. Three defects a reader could have, each pinned below:
 *
 *   - the detail page rendered every scope but CONNECTED_APP from the MEMBER
 *     table, which is empty for an agent campaign — an empty roster beside a
 *     progress bar counting subjects it does not show;
 *   - it offered decision controls and a Close button the server refuses in
 *     this build, so every press would fail;
 *   - the register's progress column counted member rows only, so an agent
 *     campaign of three agents read 0/0.
 *
 * Messages are the real `en.json`, so a missing label key renders as the key
 * and fails the text assertion.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), refresh: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/access-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(key);
            return typeof v === 'string' ? v.replace(/<\/?b>/g, '') : key;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { AccessReviewDetailClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient';
import { AccessReviewsClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient';

function withClient(ui: React.ReactNode) {
    return (
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            {ui}
        </SWRConfig>
    );
}

function agentSubject(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        subjectRef: `agent:ag-${id}`,
        decision: null,
        decidedAt: null,
        decidedBy: null,
        notes: null,
        executedAt: null,
        snapshotJson: {
            kind: 'AGENT', agentId: `ag-${id}`, agentName: `Agent ${id}`, agentStatus: 'ACTIVE',
            ownerUserId: 'usr_owner', ownerEmail: 'owner@example.test', grantCount: 4,
        },
        ...over,
    };
}

function agentReview(over: Record<string, unknown> = {}) {
    return {
        id: 'rev_agent',
        name: 'Q4 agent recertification',
        description: null,
        scope: 'AGENT' as const,
        status: 'OPEN' as const,
        periodStartAt: null,
        periodEndAt: null,
        dueAt: null,
        closedAt: null,
        createdAt: new Date('2026-10-18').toISOString(),
        reviewerUserId: 'usr_reviewer',
        evidenceFileRecordId: null,
        reviewer: { id: 'usr_reviewer', email: 'r@example.test', name: null },
        createdBy: { id: 'usr_admin', email: 'a@example.test', name: null },
        closedBy: null,
        decisions: [],
        connectedDecisions: [agentSubject('1'), agentSubject('2', { decision: 'CONFIRM', decidedAt: new Date().toISOString() })],
        snapshotTruncated: false,
        subjectsRestricted: false,
        lastActivityByUser: {},
        ...over,
    };
}

function renderDetail(review: Record<string, unknown>, opts: { isAdmin?: boolean; userId?: string } = {}) {
    return render(
        withClient(
            <AccessReviewDetailClient
                tenantSlug="acme"
                initialReview={agentReview(review) as never}
                currentUserId={opts.userId ?? 'usr_admin'}
                isAdmin={opts.isAdmin ?? true}
            />,
        ),
    );
}

describe('the detail page reads an AGENT campaign', () => {
    it('renders its agents from the connected rows, not the empty member roster', () => {
        renderDetail({});
        expect(screen.getByTestId('access-review-agent-table')).toBeInTheDocument();
        expect(screen.getByTestId('agent-row-1')).toBeInTheDocument();
        expect(screen.getByText('Agent 1')).toBeInTheDocument();
        expect(screen.getAllByText('owner@example.test')).toHaveLength(2);
        expect(screen.queryByTestId('access-review-roster-table')).not.toBeInTheDocument();
        expect(screen.queryByTestId('access-review-connected-table')).not.toBeInTheDocument();
        // The progress figure counts the agents it shows.
        expect(screen.getByText('1/2')).toBeInTheDocument();
    });

    it('labels the scope, rather than printing the raw enum', () => {
        renderDetail({});
        expect(screen.getByTestId('access-review-scope')).toHaveTextContent('Registered agents');
    });

    it('is read-only in this release: no decision control, no Close, and a notice saying why', () => {
        // The assigned reviewer AND an admin: neither gets a control the
        // server would refuse.
        renderDetail({}, { isAdmin: true, userId: 'usr_reviewer' });
        expect(screen.getByTestId('access-review-agent-read-only')).toBeInTheDocument();
        expect(screen.queryByTestId('connected-decision-select-1')).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(screen.queryByTestId('access-review-close-button')).not.toBeInTheDocument();
        expect(screen.getByText('pending')).toBeInTheDocument();
        expect(screen.getByText('CONFIRM')).toBeInTheDocument();
    });

    it('renders withheld subjects as restricted, and says who may see them', () => {
        renderDetail({
            subjectsRestricted: true,
            connectedDecisions: [agentSubject('1', { snapshotJson: null, subjectRef: 'agent' })],
        }, { isAdmin: false, userId: 'usr_reader' });
        expect(screen.getByTestId('access-review-agent-subjects-restricted')).toBeInTheDocument();
        expect(screen.getByText('Restricted')).toBeInTheDocument();
        expect(screen.queryByText('Agent 1')).not.toBeInTheDocument();
    });

    it('a CONNECTED_APP campaign is unchanged: still its own table, still decidable', () => {
        renderDetail({
            scope: 'CONNECTED_APP',
            connectedDecisions: [{
                id: 'c1', subjectRef: 'conn-1:ext-a', decision: null, decidedAt: null, decidedBy: null,
                notes: null, executedAt: null, snapshotJson: { provider: 'okta', email: 'c@example.test', displayName: 'Carol' },
            }],
        });
        expect(screen.getByTestId('access-review-connected-table')).toBeInTheDocument();
        expect(screen.getByTestId('connected-decision-select-c1')).toBeInTheDocument();
        expect(screen.queryByTestId('access-review-agent-read-only')).not.toBeInTheDocument();
    });
});

describe('the register reads an AGENT campaign', () => {
    beforeEach(() => {
        (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ rows: [], truncated: false }),
        }));
    });

    it('labels it, and counts its subjects in the connected table', () => {
        render(
            withClient(
                <AccessReviewsClient
                    tenantSlug="acme"
                    initialReviews={[{
                        id: 'rev_agent', name: 'Q4 agents', scope: 'AGENT', status: 'OPEN',
                        periodStartAt: null, periodEndAt: null, dueAt: null, closedAt: null,
                        createdAt: new Date('2026-10-18').toISOString(),
                        reviewerUserId: 'usr_reviewer', createdByUserId: 'usr_admin',
                        _count: { decisions: 0, connectedDecisions: 3 },
                    }]}
                />,
            ),
        );
        expect(screen.getByTestId('access-review-scope-cell-rev_agent')).toHaveTextContent('Registered agents');
        expect(screen.getByText('0/3')).toBeInTheDocument();
    });
});
