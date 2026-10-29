/**
 * A REVIEWER IS TOLD WHY THE QUEUE REFUSED THEM, IN A SENTENCE.
 *
 * Two refusals on the approve and reject paths used to throw a bare code —
 * `forbidden('agent_proposal_four_eyes')`, `forbidden('agent_proposal_expired')`
 * — and the proposals page shows the 403's message, so the reviewer read a
 * code. Worse for four-eyes: `fourEyesRefusal` had already COMPOSED the
 * sentence ("you have already approved this proposal…", "you are the
 * registered owner of the agent that made it…") and `refuseFourEyes` threw it
 * away.
 *
 * The contract now:
 *   · the 403's message is the sentence, addressed to the caller;
 *   · the condition's code is in `details.reason`, where a client or a test
 *     that needs to branch on it can read it;
 *   · the audit row is unchanged — the rule's code stays in the trail.
 *
 * The last block runs the real approve ROUTE, so the sentence is asserted on
 * the wire envelope the page reads (`{ error: { message } }`), not only on the
 * thrown error.
 */
import { strictMock } from '../helpers/strict-mock';

const db = {
    agentProposal: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    agentProposalApproval: {
        create: jest.fn(),
        findMany: jest.fn(async () => []),
    },
};

type AuditEntry = Record<string, unknown>;
const appendAuditEntry = jest.fn(async (_entry: AuditEntry) => undefined);

jest.mock('@/lib/db/rls-middleware', () => ({
    withRlsTripwireExtension: <T,>(client: T): T => client,
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/usecases/risk', () => ({ createRisk: jest.fn(), updateRisk: jest.fn() }));
jest.mock('@/app-layer/usecases/control/mutations', () => ({ createControl: jest.fn(), updateControl: jest.fn() }));
jest.mock('@/app-layer/usecases/policy', () => ({ createPolicy: jest.fn() }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: jest.fn(), updateFinding: jest.fn() }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...a: unknown[]) => appendAuditEntry(a[0] as AuditEntry),
        appendAuditEntryOrQueue: (...a: unknown[]) => appendAuditEntry(a[0] as AuditEntry),
    }),
);
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(async () => 'decision-1'),
    recordDecisionOutcomeForDigest: jest.fn(async () => undefined),
}));
jest.mock('@/lib/observability/logger', () => ({
    // The real module beside a silent logger: the route's error wrapper reads
    // `extractErrorMeta` from here too.
    ...jest.requireActual('@/lib/observability/logger'),
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: jest.fn(async () => ({ verdict: 'clean', blocked: false, ruleIds: [] })),
    guardEgress: jest.fn(async () => ({ verdict: 'clean', blocked: false, ruleIds: [] })),
    assertGuardAllowed: jest.fn(),
}));
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';

import {
    EXPIRED_REFUSAL_MESSAGE,
    approveAgentProposal,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import * as approveRoute from '@/app/api/t/[tenantSlug]/agent-proposals/[id]/approve/route';
import * as rejectRoute from '@/app/api/t/[tenantSlug]/agent-proposals/[id]/reject/route';
import { apiErrorMessage } from '@/lib/api-error';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'reviewer-1' });

/** A PENDING, CLEAN, two-approver CREATE proposal whose window is open. */
function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'p1',
        tenantId: 't1',
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        payloadJson: JSON.stringify({ title: 'Unpatched edge router' }),
        targetEntityId: null,
        rationale: null,
        proposedViaKeyId: 'k1',
        proposedBySessionRef: null,
        agentId: 'agent-1',
        policyCardVersion: 1,
        requiredApprovals: 2,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:ab',
        expiresAt: new Date(Date.now() + 86_400_000),
        ...overrides,
    };
}

const denials = () => appendAuditEntry.mock.calls.map((c) => c[0]).filter((e) => e.action === 'AUTHZ_DENIED');

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(ctx);
});

describe('a proposal past its window', () => {
    beforeEach(() => {
        db.agentProposal.findFirst.mockResolvedValue(pendingRow({ expiresAt: new Date(Date.now() - 60_000) }));
    });

    it.each([
        ['approve', () => approveAgentProposal(ctx, 'p1')],
        ['reject', () => rejectAgentProposal(ctx, 'p1')],
    ] as const)('%s: the 403 says the window closed, with the code in details', async (_verb, run) => {
        const err = (await run().catch((e: unknown) => e)) as { status?: number; message: string; details?: unknown };
        expect(err.status).toBe(403);
        expect(err.message).toBe(EXPIRED_REFUSAL_MESSAGE);
        expect(err.message).not.toContain('agent_proposal');
        expect(err.details).toEqual({ reason: 'agent_proposal_expired' });
        // The trail is unchanged.
        expect(denials()).toHaveLength(1);
        expect((denials()[0].detailsJson as Record<string, unknown>).reason).toBe('agent_proposal_expired');
    });
});

describe('a four-eyes refusal', () => {
    beforeEach(() => {
        db.agentProposal.findFirst.mockResolvedValue(pendingRow());
    });

    it('a second click by the first approver is told they already signed', async () => {
        // The unique index on (tenantId, proposalId, approverUserId).
        db.agentProposalApproval.create.mockRejectedValueOnce(
            Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
        );
        const err = (await approveAgentProposal(ctx, 'p1').catch((e: unknown) => e)) as {
            status?: number;
            message: string;
            details?: unknown;
        };
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/already approved this proposal/);
        expect(err.message).toMatch(/different person/);
        expect(err.message).not.toContain('agent_proposal');
        expect(err.details).toEqual({ reason: 'agent_proposal_four_eyes' });
        // The rule's CODE stays in the trail, not in the 403.
        expect(JSON.stringify(err.details)).not.toContain('approver_already_signed');
        expect((denials()[0].detailsJson as Record<string, unknown>).fourEyesRule).toBe('approver_already_signed');
    });

    it('the agent’s registered owner is told somebody else has to sign', async () => {
        db.agentProposalApproval.create.mockRejectedValueOnce(
            new Error('P0001 AGENT_PROPOSAL_APPROVAL_OWNER_SELF_REVIEW: owner may not approve'),
        );
        const err = (await approveAgentProposal(ctx, 'p1').catch((e: unknown) => e)) as {
            message: string;
            details?: unknown;
        };
        expect(err.message).toMatch(/registered owner of the agent that made it/);
        expect(err.message).toMatch(/Someone else has to sign/);
        expect(err.details).toEqual({ reason: 'agent_proposal_four_eyes' });
        expect((denials()[0].detailsJson as Record<string, unknown>).fourEyesRule).toBe('agent_owner_may_not_approve');
    });

    it('an unrelated database failure is still rethrown, not dressed as a refusal', async () => {
        db.agentProposalApproval.create.mockRejectedValueOnce(new Error('connection reset'));
        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow('connection reset');
        expect(denials()).toHaveLength(0);
    });
});

describe('on the wire, the page reads the sentence', () => {
    async function post(handler: unknown, id = 'p1'): Promise<{ status: number; body: unknown }> {
        const req = new NextRequest(`http://localhost/api/t/acme/agent-proposals/${id}/approve`, {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: '{}',
        });
        const res = await (handler as (r: NextRequest, a: { params: Promise<Record<string, string>> }) => Promise<Response>)(
            req,
            { params: Promise.resolve({ tenantSlug: 'acme', id }) },
        );
        return { status: res.status, body: await res.json() };
    }

    it('a four-eyes refusal reaches the client as its sentence', async () => {
        db.agentProposal.findFirst.mockResolvedValue(pendingRow());
        db.agentProposalApproval.create.mockRejectedValueOnce(
            Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
        );
        const { status, body } = await post(approveRoute.POST);
        expect(status).toBe(403);
        expect(apiErrorMessage(body, 'fallback')).toMatch(/already approved this proposal/);
    });

    it('an expiry refusal on reject reaches the client as its sentence', async () => {
        db.agentProposal.findFirst.mockResolvedValue(pendingRow({ expiresAt: new Date(Date.now() - 60_000) }));
        const { status, body } = await post(rejectRoute.POST);
        expect(status).toBe(403);
        expect(apiErrorMessage(body, 'fallback')).toBe(EXPIRED_REFUSAL_MESSAGE);
    });
});
