/**
 * #3674 — the access-review pages read and drive an AGENT campaign.
 *
 * Defects a reader could have, each pinned below:
 *
 *   - the detail page rendered every scope but CONNECTED_APP from the MEMBER
 *     table, which is empty for an agent campaign — an empty roster beside a
 *     progress bar counting subjects it does not show;
 *   - it offered controls the server refuses — a verdict before the pack, a
 *     verdict beside an undecided narrowing, a verdict to the agent's own
 *     owner, a Close with a narrowing pending — so the press would fail;
 *   - the register's progress column counted member rows only, so an agent
 *     campaign of three agents read 0/0.
 *
 * Messages are the real `en.json`, so a missing label key renders as the key
 * and fails the text assertion.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

interface PacksPayload {
    packs: unknown[];
    narrowings: unknown[];
    samples: unknown[];
    evidence: unknown;
}

function pack(decisionId: string) {
    return {
        id: `pk-${decisionId}`, decisionId, agentId: `ag-${decisionId}`, preparedByRunId: 'run-1',
        // Never the agent itself: ag-1's pack by ag-2, every other by ag-1.
        preparedByAgentId: decisionId === '1' ? 'ag-2' : 'ag-1',
        windowStart: '2026-07-20T00:00:00.000Z', windowEnd: '2026-10-18T00:00:00.000Z',
        sectionsJson: {
            grants: [
                { grantId: 'g-1', toolName: 'list_risks', lastCalledAt: null, heldForWholeWindow: true },
                { grantId: 'g-2', toolName: 'list_controls', lastCalledAt: '2026-10-01T00:00:00.000Z', heldForWholeWindow: true },
            ],
            harness: { level: 'H2', drift: 'UP' },
            guardFlags: {},
            breaker: null,
            killEngagements: [],
        },
        contentHash: `sha256:${'a'.repeat(64)}`,
        preparedAt: '2026-10-18T01:00:00.000Z',
    };
}

function narrowing(id: string, decisionId: string, outcome = 'PENDING') {
    return {
        id, decisionId, packId: `pk-${decisionId}`, grantId: 'g-1', toolName: 'list_risks',
        grantedByUserId: 'usr_admin', grantedAt: '2026-01-01T00:00:00.000Z',
        basis: 'NO_RECORDED_CALL_IN_WINDOW', outcome,
        decidedAt: null, decidedByUserId: null, executedAt: null, executionResult: null,
    };
}

let packsPayload: PacksPayload = { packs: [], narrowings: [], samples: [], evidence: null };
/** What the detail endpoint answers when SWR revalidates — the review rendered. */
let detailPayload: unknown = null;

beforeEach(() => {
    packsPayload = { packs: [], narrowings: [], samples: [], evidence: null };
    detailPayload = null;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
        const u = String(url);
        const body = u.includes('/agent-packs')
            ? packsPayload
            : /\/access-reviews\/[^/?]+$/.test(u) && detailPayload
                ? detailPayload
                : { rows: [], truncated: false };
        return { ok: true, status: 200, json: async () => body };
    });
});

function renderDetail(review: Record<string, unknown>, opts: { isAdmin?: boolean; userId?: string } = {}) {
    detailPayload = agentReview(review);
    return render(
        withClient(
            <AccessReviewDetailClient
                tenantSlug="acme"
                initialReview={detailPayload as never}
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

    it('offers the reviewer a verdict only once the pack exists and its narrowings are decided', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [narrowing('n-1', '1')], samples: [], evidence: null };
        const view = renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });
        await waitFor(() => expect(screen.getByTestId('agent-narrowings-first-1')).toBeInTheDocument());
        expect(screen.queryByTestId('agent-decision-select-1')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-narrowing-accept-n-1')).toBeInTheDocument();
        expect(screen.getByTestId('agent-pack-1')).toHaveTextContent('1 of 2 grants unused in the window');
        expect(screen.getByTestId('agent-pack-prepared-by-1')).toHaveTextContent('Prepared by Agent 2');
        view.unmount();

        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [narrowing('n-1', '1', 'REJECTED')], samples: [], evidence: null };
        renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });
        await waitFor(() => expect(screen.getByTestId('agent-decision-select-1')).toBeInTheDocument());
    });

    it('offers no verdict before the pack exists, and offers an admin the preparation', async () => {
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        await waitFor(() => expect(screen.getByTestId('access-review-agent-prepare-packs')).toBeInTheDocument());
        expect(screen.queryByTestId('agent-decision-select-1')).not.toBeInTheDocument();
        expect(screen.getAllByText('No pack yet').length).toBeGreaterThan(0);
    });

    it('gives the agent’s owner no verdict and no narrowing control, even as an admin', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [narrowing('n-1', '1')], samples: [], evidence: null };
        renderDetail({}, { isAdmin: true, userId: 'usr_owner' });
        await waitFor(() => expect(screen.getByTestId('agent-owner-cannot-decide-1')).toBeInTheDocument());
        expect(screen.queryByTestId('agent-decision-select-1')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-narrowing-accept-n-1')).not.toBeInTheDocument();
    });

    it('keeps Close disabled while a narrowing is pending, though every subject is decided', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [narrowing('n-1', '1')], samples: [], evidence: null };
        renderDetail({
            connectedDecisions: [
                agentSubject('1', { decision: 'CONFIRM', decidedAt: new Date().toISOString() }),
                agentSubject('2', { decision: 'CONFIRM', decidedAt: new Date().toISOString() }),
            ],
        }, { isAdmin: true, userId: 'usr_admin' });
        await screen.findByTestId('agent-narrowing-n-1');
        expect(screen.getByTestId('access-review-close-button')).toBeDisabled();
    });

    it('says whether a closed campaign’s evidence still recomputes from its rows', async () => {
        packsPayload = {
            packs: [pack('1'), pack('2')], narrowings: [], samples: [],
            evidence: { fileRecordId: 'f-1', storedSha256: 'b'.repeat(64), recomputedSha256: 'c'.repeat(64), matches: false },
        };
        renderDetail({ status: 'CLOSED', evidenceFileRecordId: 'f-1' }, { isAdmin: true, userId: 'usr_admin' });
        const notice = await screen.findByTestId('access-review-agent-evidence-hash');
        expect(notice).toHaveAttribute('data-matches', 'false');
        expect(notice).toHaveTextContent('does NOT match');
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
        expect(screen.queryByTestId('access-review-agent-table')).not.toBeInTheDocument();
    });
});

describe('the register reads an AGENT campaign', () => {
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

    it('offers an AGENT campaign in the create modal', () => {
        render(withClient(<AccessReviewsClient tenantSlug="acme" initialReviews={[]} />));
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        const option = document.getElementById('access-review-scope-AGENT');
        expect(option).not.toBeNull();
        expect(option!.closest('label')).toHaveTextContent('Registered agents');
    });

    it('asks an AGENT campaign for its two preparing agents', async () => {
        render(withClient(<AccessReviewsClient tenantSlug="acme" initialReviews={[]} />));
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        expect(screen.queryByTestId('access-review-new-preparer')).not.toBeInTheDocument();
        fireEvent.click(document.getElementById('access-review-scope-AGENT')!);
        await waitFor(() => expect(screen.getByTestId('access-review-new-preparer')).toBeInTheDocument());
        expect(screen.getByTestId('access-review-new-cross-preparer')).toBeInTheDocument();
        expect(screen.getByText('Second preparing agent')).toBeInTheDocument();
    });
});
