/**
 * An UPDATE proposal cannot enter the queue in a state the reviewer would have
 * to refuse.
 *
 * The approve path already withholds approval from a proposal whose diff cannot
 * be computed, which is the safety property. This file is about the OTHER cost
 * of such a row: it sits in the queue looking exactly like an actionable one and
 * spends the reviewer attention the whole gate depends on. A queue padded with
 * un-approvable rows is a queue people learn to click through - which is the
 * automation-bias failure arriving by a side door.
 *
 * So the propose boundary refuses three shapes:
 *
 *   - an update to a kind that has no partial-update contract (POLICY: policy
 *     content moves through versions and approvals, and a flat field merge
 *     approved here would bypass the version chain policy history depends on);
 *   - an update that names no target;
 *   - an update whose target does not exist right now, in this tenant.
 *
 * ...and one more in the opposite direction: a CREATE that names a target. That
 * is not a harmless extra field. It is a caller that believes it is proposing an
 * edit, and approving it would silently create a SECOND record beside the one it
 * meant to change.
 */
const db = {
    agentProposal: { create: jest.fn() },
    risk: { findMany: jest.fn() },
    control: { findMany: jest.fn() },
    policy: { findMany: jest.fn() },
    finding: { findMany: jest.fn() },
};

jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/usecases/risk', () => ({ createRisk: jest.fn(), updateRisk: jest.fn() }));
jest.mock('@/app-layer/usecases/control/mutations', () => ({
    createControl: jest.fn(),
    updateControl: jest.fn(),
}));
jest.mock('@/app-layer/usecases/policy', () => ({ createPolicy: jest.fn() }));
jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: jest.fn(),
    updateFinding: jest.fn(),
}));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: jest.fn(async () => undefined) }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: jest.fn(async () => ({ allowed: true })),
    guardEgress: jest.fn(async () => ({ allowed: true })),
    assertGuardAllowed: jest.fn(),
}));
jest.mock('@/app-layer/ai/guard/proposal-guard', () => ({
    guardAgentProposal: jest.fn(() => ({
        quarantined: false,
        verdict: 'CLEAN',
        ruleIds: [],
        inputDigest: 'sha256:test',
        provenance: 'THIRD_PARTY_INGESTED',
        outputSummary: 'fields=1',
    })),
}));
jest.mock('@/app-layer/ai/decision-log', () => ({ logAiDecision: jest.fn(async () => undefined) }));

import { createAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'agent-key-user' });

beforeEach(() => {
    jest.clearAllMocks();
    db.agentProposal.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: 'p-new',
        kind: args.data.kind,
        status: args.data.status,
        operation: args.data.operation,
    }));
    db.risk.findMany.mockResolvedValue([{ id: 'risk-77', tenantId: 't1', likelihood: 4 }]);
    db.control.findMany.mockResolvedValue([]);
    db.policy.findMany.mockResolvedValue([]);
    db.finding.findMany.mockResolvedValue([]);
});

describe('a well-formed UPDATE proposal is queued with its target recorded', () => {
    it('stores the operation and the target id on the row', async () => {
        const result = await createAgentProposal(ctx, {
            kind: 'RISK',
            operation: 'UPDATE',
            targetEntityId: 'risk-77',
            payload: { likelihood: 9 },
            policyCardVersion: 0,
        });

        expect(result.operation).toBe('UPDATE');
        const written = db.agentProposal.create.mock.calls[0][0].data;
        expect(written.operation).toBe('UPDATE');
        expect(written.targetEntityId).toBe('risk-77');
        // Validated against the PARTIAL update schema, not the create schema:
        // `likelihood` alone would fail `CreateRiskSchema`, which requires a
        // title. An update proposal that had to restate every field would make
        // every diff look like a full rewrite.
        expect(JSON.parse(written.payloadJson as string)).toStrictEqual({ likelihood: 9 });
    });
});

describe('the shapes that must never reach the queue', () => {
    it('refuses an update to a kind with no partial-update contract', async () => {
        await expect(
            createAgentProposal(ctx, {
                kind: 'POLICY',
                operation: 'UPDATE',
                targetEntityId: 'policy-1',
                payload: { title: 'Rewritten' },
                policyCardVersion: 0,
            }),
        ).rejects.toThrow(/only RISK, CONTROL, FINDING/);
        expect(db.agentProposal.create).not.toHaveBeenCalled();
    });

    it('refuses an update that names no target', async () => {
        await expect(
            createAgentProposal(ctx, {
                kind: 'RISK',
                operation: 'UPDATE',
                payload: { likelihood: 9 },
                policyCardVersion: 0,
            }),
        ).rejects.toThrow(/targetEntityId/);
        expect(db.agentProposal.create).not.toHaveBeenCalled();
    });

    it('refuses an update whose target does not exist in this tenant', async () => {
        db.risk.findMany.mockResolvedValue([]);

        await expect(
            createAgentProposal(ctx, {
                kind: 'RISK',
                operation: 'UPDATE',
                targetEntityId: 'risk-gone',
                payload: { likelihood: 9 },
                policyCardVersion: 0,
            }),
        ).rejects.toThrow(/TARGET_MISSING/);
        expect(db.agentProposal.create).not.toHaveBeenCalled();
    });

    it('refuses a CREATE that names a target record', async () => {
        await expect(
            createAgentProposal(ctx, {
                kind: 'RISK',
                operation: 'CREATE',
                targetEntityId: 'risk-77',
                payload: { title: 'A new risk' },
                policyCardVersion: 0,
            }),
        ).rejects.toThrow(/must not name a targetEntityId/);
        expect(db.agentProposal.create).not.toHaveBeenCalled();
    });
});

describe('an ordinary CREATE proposal is unchanged by any of this', () => {
    it('defaults to CREATE with a null target when no operation is given', async () => {
        const result = await createAgentProposal(ctx, {
            kind: 'RISK',
            payload: { title: 'A new risk' },
            policyCardVersion: 0,
        });

        expect(result.operation).toBe('CREATE');
        const written = db.agentProposal.create.mock.calls[0][0].data;
        expect(written.operation).toBe('CREATE');
        expect(written.targetEntityId).toBeNull();
        // No target read happens for a create - there is nothing to compare
        // against, and a query fired anyway would be a per-proposal round trip
        // bought for nothing.
        expect(db.risk.findMany).not.toHaveBeenCalled();
    });
});
