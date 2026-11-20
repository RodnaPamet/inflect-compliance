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
        lastSignInByUser: {},
        ...over,
    };
}

interface PacksPayload {
    packs: unknown[];
    narrowings: unknown[];
    spendingWithdrawals?: unknown[];
    samples: unknown[];
    evidence: unknown;
    preparation?: unknown;
}

function pack(decisionId: string) {
    return {
        id: `pk-${decisionId}`, decisionId, agentId: `ag-${decisionId}`, preparedByRunId: 'run-1',
        // Never the agent itself: ag-1's pack by ag-2, every other by ag-1.
        preparedByAgentId: decisionId === '1' ? 'ag-2' : 'ag-1',
        preparationBasis: 'AGENT_RUN',
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

/** Agent Pay 1.4 (#5333) — a proposed withdrawal of an agent's spending authority. */
function withdrawal(id: string, decisionId: string, outcome = 'PENDING', executionResult: string | null = null) {
    return {
        id, decisionId, packId: `pk-${decisionId}`, rail: 'AP4M', declaredAt: '2026-10-01T00:00:00.000Z',
        statusAtPack: 'DECLARED', expiresAt: '2027-01-01T00:00:00.000Z', grounds: ['NEVER_REVIEWED', 'EXPIRED_BY_WINDOW_END'],
        outcome, decidedAt: outcome === 'PENDING' ? null : '2026-11-20T00:00:00.000Z',
        decidedByUserId: outcome === 'PENDING' ? null : 'usr_reviewer',
        executedAt: executionResult ? '2026-11-20T00:00:00.000Z' : null, executionResult,
        ownerTaskId: executionResult === 'ENVELOPE_WITHDRAWN' ? 'task-1' : null,
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

function renderDetail(review: Record<string, unknown>, opts: { isAdmin?: boolean; userId?: string; holdsAgentRegistry?: boolean; canManage?: boolean } = {}) {
    detailPayload = agentReview(review);
    return render(
        withClient(
            <AccessReviewDetailClient
                tenantSlug="acme"
                initialReview={detailPayload as never}
                currentUserId={opts.userId ?? 'usr_admin'}
                isAdmin={opts.isAdmin ?? true}
                holdsAgentRegistry={opts.holdsAgentRegistry ?? false}
                {...(opts.canManage === undefined ? {} : { canManage: opts.canManage })}
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

    it('says which of a pack’s sections were capped, so a partial list is not read as whole (#5317)', async () => {
        const capped = pack('1');
        capped.sectionsJson = {
            ...capped.sectionsJson,
            grantsTruncated: true,
            timeBoundedTruncated: true,
            killsTruncated: true,
        } as typeof capped.sectionsJson;
        const partly = pack('2');
        partly.sectionsJson = { ...partly.sectionsJson, grantsTruncated: false, timeBoundedTruncated: true } as typeof partly.sectionsJson;
        packsPayload = { packs: [capped, partly], narrowings: [], samples: [], evidence: null };
        renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });

        await waitFor(() => expect(screen.getByTestId('agent-pack-truncated-1')).toBeInTheDocument());
        const all = screen.getByTestId('agent-pack-truncated-1');
        expect(all).toHaveTextContent('Grant list capped — the pack does not hold every grant');
        expect(all).toHaveTextContent('Time-bounded grant list capped — the pack does not hold every one');
        expect(all).toHaveTextContent('Kill list capped — the pack does not hold every kill');

        const one = screen.getByTestId('agent-pack-truncated-2');
        expect(one).toHaveTextContent('Time-bounded grant list capped');
        expect(one).not.toHaveTextContent('Grant list capped');
        expect(one).not.toHaveTextContent('Kill list capped');
    });

    it('notes nothing for a pack whose sections were read whole, or that predates the flags', async () => {
        const whole = pack('1');
        whole.sectionsJson = {
            ...whole.sectionsJson, grantsTruncated: false, timeBoundedTruncated: false, killsTruncated: false,
        } as typeof whole.sectionsJson;
        packsPayload = { packs: [whole, pack('2')], narrowings: [], samples: [], evidence: null };
        renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });
        await waitFor(() => expect(screen.getByTestId('agent-pack-1')).toBeInTheDocument());
        expect(screen.queryByTestId('agent-pack-truncated-1')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-pack-truncated-2')).not.toBeInTheDocument();
    });

    it('names a person as the preparer of the preparing agent’s own pack, when no agent prepared it', async () => {
        const own = { ...pack('1'), preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' };
        packsPayload = { packs: [own, pack('2')], narrowings: [], samples: [], evidence: null };
        renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });
        await waitFor(() => expect(screen.getByTestId('agent-pack-prepared-by-1')).toHaveTextContent('Prepared by a person'));
    });

    it('offers no verdict before the pack exists, and offers an admin the preparation', async () => {
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        await waitFor(() => expect(screen.getByTestId('access-review-agent-prepare-packs')).toBeInTheDocument());
        expect(screen.queryByTestId('agent-decision-select-1')).not.toBeInTheDocument();
        expect(screen.getAllByText('No pack yet').length).toBeGreaterThan(0);
    });

    it('offers no preparation to an admin whose role lacks access_reviews.create, which the route takes (#5313)', async () => {
        renderDetail({}, { isAdmin: true, userId: 'usr_admin', canManage: false });
        await waitFor(() => expect(screen.getAllByText('No pack yet').length).toBeGreaterThan(0));
        expect(screen.queryByTestId('access-review-agent-prepare-packs')).not.toBeInTheDocument();
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

describe('a pack’s proposed spending withdrawals (Agent Pay 1.4, #5333)', () => {
    const decided = [
        agentSubject('1', { decision: 'CONFIRM', decidedAt: new Date().toISOString() }),
        agentSubject('2', { decision: 'CONFIRM', decidedAt: new Date().toISOString() }),
    ];

    it('lists each with its rail and grounds, and offers the reviewer Withdraw and Keep', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], spendingWithdrawals: [withdrawal('w-1', '2')], samples: [], evidence: null };
        renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });
        const row = await screen.findByTestId('agent-withdrawal-w-1');
        expect(row).toHaveTextContent('Agent Pay for Machines');
        expect(screen.getByTestId('agent-withdrawal-grounds-w-1')).toHaveTextContent('No second person has reviewed it');
        expect(screen.getByTestId('agent-withdrawal-grounds-w-1')).toHaveTextContent('It had expired by the end of the campaign');
        expect(screen.getByTestId('agent-withdrawal-accept-w-1')).toHaveTextContent('Withdraw');
        expect(screen.getByTestId('agent-withdrawal-reject-w-1')).toHaveTextContent('Keep');
    });

    it('holds the subject’s verdict while one is pending, as a narrowing does', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], spendingWithdrawals: [withdrawal('w-1', '1')], samples: [], evidence: null };
        renderDetail({}, { isAdmin: false, userId: 'usr_reviewer' });
        await waitFor(() => expect(screen.getByTestId('agent-withdrawals-first-1')).toBeInTheDocument());
        expect(screen.queryByTestId('agent-decision-select-1')).not.toBeInTheDocument();
    });

    it('gives the agent’s owner no control over it, even as an admin', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], spendingWithdrawals: [withdrawal('w-1', '1')], samples: [], evidence: null };
        renderDetail({}, { isAdmin: true, userId: 'usr_owner' });
        await screen.findByTestId('agent-withdrawal-w-1');
        expect(screen.queryByTestId('agent-withdrawal-accept-w-1')).not.toBeInTheDocument();
    });

    it('keeps Close disabled while one is pending, though every subject is decided', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], spendingWithdrawals: [withdrawal('w-1', '1')], samples: [], evidence: null };
        renderDetail({ connectedDecisions: decided }, { isAdmin: true, userId: 'usr_admin' });
        await screen.findByTestId('agent-withdrawal-w-1');
        expect(screen.getByTestId('access-review-close-button')).toBeDisabled();
    });

    it('says what accepting one did', async () => {
        packsPayload = {
            packs: [pack('1'), pack('2')], narrowings: [],
            spendingWithdrawals: [withdrawal('w-1', '1', 'ACCEPTED', 'ENVELOPE_WITHDRAWN'), withdrawal('w-2', '2', 'ACCEPTED', 'ENVELOPE_REDECLARED')],
            samples: [], evidence: null,
        };
        renderDetail({ connectedDecisions: decided }, { isAdmin: true, userId: 'usr_admin' });
        expect(await screen.findByTestId('agent-withdrawal-result-w-1')).toHaveTextContent('task to cancel the token');
        expect(screen.getByTestId('agent-withdrawal-result-w-2')).toHaveTextContent('declared again');
        expect(screen.getByTestId('access-review-close-button')).not.toBeDisabled();
    });

    it('shows no section for a campaign with none, or a response that predates them', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], samples: [], evidence: null };
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        await screen.findByTestId('agent-pack-1');
        expect(screen.queryByTestId('access-review-agent-withdrawals-table')).not.toBeInTheDocument();
    });
});

describe('a large campaign prepared in the background shows its progress (#5317)', () => {
    it('shows "N of M agents" while the job runs, and offers no second Prepare', async () => {
        packsPayload = { packs: [], narrowings: [], samples: [], evidence: null, preparation: { state: 'RUNNING', done: 4, total: 12 } };
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        const notice = await screen.findByTestId('access-review-agent-packs-preparing');
        expect(notice).toHaveAttribute('data-state', 'RUNNING');
        expect(notice).toHaveTextContent('Preparing reviewer packs… 4 of 12 agents');
        expect(screen.queryByTestId('access-review-agent-prepare-packs')).not.toBeInTheDocument();
    });

    it('says a queued preparation is queued before the job reports a total', async () => {
        packsPayload = { packs: [], narrowings: [], samples: [], evidence: null, preparation: { state: 'QUEUED', done: 0, total: null } };
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        expect(await screen.findByTestId('access-review-agent-packs-preparing'))
            .toHaveTextContent('Reviewer packs are queued for preparation');
        expect(screen.queryByTestId('access-review-agent-prepare-packs')).not.toBeInTheDocument();
    });

    it('says a failed preparation failed, with its refusal, and offers Prepare again', async () => {
        packsPayload = {
            packs: [], narrowings: [], samples: [], evidence: null,
            preparation: { state: 'FAILED', reason: 'PREPARER_NOT_ACTIVE: the preparer is SUSPENDED' },
        };
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        const alert = await screen.findByTestId('access-review-agent-packs-preparation-failed');
        expect(alert).toHaveTextContent('Preparing the reviewer packs failed');
        expect(alert).toHaveTextContent('PREPARER_NOT_ACTIVE: the preparer is SUSPENDED');
        expect(screen.getByTestId('access-review-agent-prepare-packs')).toBeInTheDocument();
        expect(screen.queryByTestId('access-review-agent-packs-preparing')).not.toBeInTheDocument();
    });

    it('re-reads the packs while the job runs, and reloads the campaign when it is done', async () => {
        packsPayload = { packs: [], narrowings: [], samples: [], evidence: null, preparation: { state: 'RUNNING', done: 1, total: 2 } };
        renderDetail({}, { isAdmin: true, userId: 'usr_admin' });
        await screen.findByTestId('access-review-agent-packs-preparing');
        const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
        const detailReads = () => fetchMock.mock.calls.filter(([u]) => /\/access-reviews\/rev_agent$/.test(String(u))).length;
        const before = detailReads();

        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], samples: [], evidence: null, preparation: null };
        await waitFor(() => expect(screen.getByTestId('agent-pack-1')).toBeInTheDocument(), { timeout: 6000 });
        expect(screen.queryByTestId('access-review-agent-packs-preparing')).not.toBeInTheDocument();
        await waitFor(() => expect(detailReads()).toBeGreaterThan(before));
    }, 10_000);
});

describe('the register reads an AGENT campaign', () => {
    it('labels it, and counts its subjects in the connected table', () => {
        render(
            withClient(
                <AccessReviewsClient
                    tenantSlug="acme"
                    canCreate
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
        render(withClient(<AccessReviewsClient tenantSlug="acme" canCreate initialReviews={[]} />));
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        const option = document.getElementById('access-review-scope-AGENT');
        expect(option).not.toBeNull();
        expect(option!.closest('label')).toHaveTextContent('Registered agents');
    });

    it('asks an AGENT campaign for its preparing agent, and offers an optional second', async () => {
        render(withClient(<AccessReviewsClient tenantSlug="acme" canCreate initialReviews={[]} />));
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        expect(screen.queryByTestId('access-review-new-preparer')).not.toBeInTheDocument();
        fireEvent.click(document.getElementById('access-review-scope-AGENT')!);
        await waitFor(() => expect(screen.getByTestId('access-review-new-preparer')).toBeInTheDocument());
        expect(screen.getByTestId('access-review-new-cross-preparer')).toBeInTheDocument();
        expect(screen.getByText('Second preparing agent')).toBeInTheDocument();
        // Optional, and the page says what leaving it empty means.
        expect(screen.getByText(/Left empty, a person prepares that one pack/)).toBeInTheDocument();
    });
});

describe('the sampled decisions follow the server (#5274)', () => {
    const EN = jest.requireActual('../../messages/en.json') as { accessReviews: Record<string, string> };
    const sample = {
        id: 'smp-1', decisionId: '2', samplingEpoch: 'e1', sampledAt: '2026-10-19T00:00:00.000Z',
        outcome: 'PENDING', dissentCodes: [], reviewedByUserId: null, reviewedAt: null,
    };

    it('a holder of admin.agent_registry who is not an admin may answer a sample', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], samples: [sample], evidence: null };
        const view = renderDetail({ status: 'CLOSED' }, { isAdmin: false, userId: 'usr_aiadmin', holdsAgentRegistry: true });
        expect(await view.findByRole('button', { name: EN.accessReviews.sampleConcur })).toBeInTheDocument();
    });

    it('an admin without admin.agent_registry is not offered the answer', async () => {
        packsPayload = { packs: [pack('1'), pack('2')], narrowings: [], samples: [sample], evidence: null };
        const view = renderDetail({ status: 'CLOSED' }, { isAdmin: true, userId: 'usr_admin2', holdsAgentRegistry: false });
        expect(await view.findAllByText(EN.accessReviews.pending)).not.toHaveLength(0);
        expect(view.queryByRole('button', { name: EN.accessReviews.sampleConcur })).toBeNull();
    });
});
