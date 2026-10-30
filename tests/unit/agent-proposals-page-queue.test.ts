/**
 * The proposals PAGE hands its client the facts the queue states depend on:
 *
 *   · it reads ONE PAST the page size, lists the page, and says it is truncated
 *     only when the read came back longer — a page of exactly the size is the
 *     whole queue;
 *   · each row carries its deadline and whether it has passed, judged on the
 *     server's clock;
 *   · each row carries the signatures and key prefix the annotation read found.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({ getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a) }));

const listAgentProposals = jest.fn();
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    listAgentProposals: (...a: unknown[]) => listAgentProposals(...a),
}));
jest.mock('@/app-layer/usecases/agent-proposal-diff', () => ({
    buildProposalDiffs: jest.fn(async (_ctx: unknown, rows: Array<{ id: string }>) =>
        new Map(rows.map((r) => [r.id, { status: 'CREATE', fields: [], baseDigest: null, comparedFieldCount: 0 }])),
    ),
}));
const annotateProposalQueue = jest.fn();
jest.mock('@/app-layer/usecases/agent-proposal-queue', () => ({
    ...jest.requireActual('@/app-layer/usecases/agent-proposal-queue'),
    annotateProposalQueue: (...a: unknown[]) => annotateProposalQueue(...a),
}));
jest.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient', () => ({
    AgentProposalsClient: () => null,
}));

import AgentProposalsPage from '@/app/t/[tenantSlug]/(app)/agents/proposals/page';
import { PROPOSAL_QUEUE_PAGE_SIZE } from '@/app-layer/usecases/agent-proposal-queue';
import type { ProposalRow } from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import { makeRequestContext } from '../helpers/make-context';

function stored(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        targetEntityId: null,
        rationale: null,
        proposedViaKeyId: null,
        createdAt: new Date('2026-10-29T10:00:00.000Z'),
        expiresAt: new Date(Date.now() + 86_400_000),
        runId: null,
        stepSeq: null,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:ab',
        ...overrides,
    };
}

async function renderPage(): Promise<{ initialProposals: ProposalRow[]; truncated: boolean }> {
    const el = (await AgentProposalsPage({ params: Promise.resolve({ tenantSlug: 'acme' }) })) as unknown as {
        props: { initialProposals: ProposalRow[]; truncated: boolean };
    };
    return el.props;
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN'));
    annotateProposalQueue.mockImplementation(async (_ctx: unknown, rows: Array<{ id: string }>) =>
        new Map(rows.map((r) => [r.id, { approvalsRecorded: 0, signedByViewer: false, proposedViaKeyPrefix: null }])),
    );
});

describe('the proposals page', () => {
    it('reads one past the page size', async () => {
        listAgentProposals.mockResolvedValue([]);
        await renderPage();
        expect(listAgentProposals).toHaveBeenCalledWith(expect.anything(), {
            status: 'PENDING',
            take: PROPOSAL_QUEUE_PAGE_SIZE + 1,
        });
    });

    it('lists the page and says it is truncated when the read came back longer', async () => {
        listAgentProposals.mockResolvedValue(
            Array.from({ length: PROPOSAL_QUEUE_PAGE_SIZE + 1 }, (_, i) => stored(`p${i}`)),
        );
        const props = await renderPage();
        expect(props.truncated).toBe(true);
        expect(props.initialProposals).toHaveLength(PROPOSAL_QUEUE_PAGE_SIZE);
        // The rows past the page are neither listed nor annotated.
        expect(annotateProposalQueue.mock.calls[0][1]).toHaveLength(PROPOSAL_QUEUE_PAGE_SIZE);
    });

    it('a queue of exactly the page size is the whole queue', async () => {
        listAgentProposals.mockResolvedValue(
            Array.from({ length: PROPOSAL_QUEUE_PAGE_SIZE }, (_, i) => stored(`p${i}`)),
        );
        const props = await renderPage();
        expect(props.truncated).toBe(false);
        expect(props.initialProposals).toHaveLength(PROPOSAL_QUEUE_PAGE_SIZE);
    });

    it('forwards each row’s deadline and whether it has passed', async () => {
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 60_000);
        listAgentProposals.mockResolvedValue([
            stored('open', { expiresAt: future }),
            stored('closed', { expiresAt: past }),
            stored('none', { expiresAt: null }),
        ]);
        const { initialProposals } = await renderPage();
        const byId = new Map(initialProposals.map((r) => [r.id, r]));
        expect(byId.get('open')).toMatchObject({ expiresAt: future.toISOString(), windowClosed: false });
        expect(byId.get('closed')).toMatchObject({ expiresAt: past.toISOString(), windowClosed: true });
        // No recorded deadline is not a closed window.
        expect(byId.get('none')).toMatchObject({ expiresAt: null, windowClosed: false });
    });

    it('forwards the signatures and the key prefix the annotation read found', async () => {
        listAgentProposals.mockResolvedValue([stored('p1', { proposedViaKeyId: 'k1' })]);
        annotateProposalQueue.mockResolvedValue(
            new Map([['p1', { approvalsRecorded: 1, signedByViewer: true, proposedViaKeyPrefix: 'iflk_ab1' }]]),
        );
        const { initialProposals } = await renderPage();
        expect(initialProposals[0]).toMatchObject({
            approvalsRecorded: 1,
            signedByViewer: true,
            proposedViaKeyPrefix: 'iflk_ab1',
        });
        // The raw payload is still never forwarded.
        expect(initialProposals[0]).not.toHaveProperty('payloadJson');
    });
});
