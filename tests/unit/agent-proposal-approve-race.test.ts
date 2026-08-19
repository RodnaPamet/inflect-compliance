/**
 * Approving a proposal claims it BEFORE creating anything.
 *
 * ═══ THE BUG THIS LOCKS OUT ═══
 *
 * approveAgentProposal used to run the create-usecase first and mark the
 * proposal afterwards. The marking `updateMany` was correctly predicated on
 * `status: 'PENDING'`, which made it look atomic — and it was, but it ran too
 * late to prevent anything.
 *
 * Two reviewers approving the same proposal concurrently both passed the
 * PENDING read, both created a live compliance record, and only then did one
 * lose the update. Two risks from one proposal, one orphaned. And because the
 * `updateMany` result was discarded, the loser reported SUCCESS — a duplicate
 * that nothing errors on is a duplicate nobody goes looking for.
 *
 * The tests below are written against the ORDER, not the implementation: what
 * matters is that no create is reachable without a won claim, and that a claim
 * is handed back if the create fails.
 */
const db = {
    agentProposal: { findFirst: jest.fn(), updateMany: jest.fn() },
};

const createRisk = jest.fn();
const appendAuditEntry = jest.fn(async () => undefined);

jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/usecases/risk', () => ({ createRisk: (...a: unknown[]) => createRisk(...a) }));
jest.mock('@/app-layer/usecases/control/mutations', () => ({ createControl: jest.fn() }));
jest.mock('@/app-layer/usecases/policy', () => ({ createPolicy: jest.fn() }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: jest.fn() }));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: (...a: unknown[]) => appendAuditEntry(...(a as [])) }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: jest.fn(async () => ({ allowed: true })),
    guardEgress: jest.fn(async () => ({ allowed: true })),
    assertGuardAllowed: jest.fn(),
}));

import { approveAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { logger } from '@/lib/observability/logger';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'reviewer-1' });

/** The order of write operations, so the test can assert sequencing. */
let order: string[] = [];

function pendingProposal() {
    return {
        id: 'p1',
        tenantId: 't1',
        status: 'PENDING',
        kind: 'RISK',
        payloadJson: JSON.stringify({ title: 'A risk', description: 'x' }),
        proposedViaKeyId: 'k1',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    order = [];
    db.agentProposal.findFirst.mockResolvedValue(pendingProposal());
    db.agentProposal.updateMany.mockImplementation(async (args: Record<string, any>) => {
        const to = args.data?.status ?? 'attach-entity';
        order.push(`update:${to}`);
        return { count: 1 };
    });
    createRisk.mockImplementation(async () => {
        order.push('create');
        return { id: 'risk-1' };
    });
});

describe('the claim happens before the create', () => {
    it('writes the claim first, then creates', async () => {
        await approveAgentProposal(ctx, 'p1');
        // The ordering IS the fix. A create appearing before the first update
        // is the exact bug this file exists for.
        expect(order[0]).toBe('update:ACCEPTED');
        expect(order).toContain('create');
        expect(order.indexOf('create')).toBeGreaterThan(0);
    });

    it('the claim is predicated on the row still being PENDING', async () => {
        await approveAgentProposal(ctx, 'p1');
        const claim = db.agentProposal.updateMany.mock.calls[0][0];
        expect(claim.where).toMatchObject({ id: 'p1', tenantId: 't1', status: 'PENDING' });
    });
});

describe('losing the claim creates NOTHING', () => {
    it('a claim that matches no row throws and never calls the create-usecase', async () => {
        // The concurrent-approval case: the other reviewer got there first, so
        // this call finds no PENDING row to claim.
        db.agentProposal.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow(/no longer pending/i);
        expect(createRisk).not.toHaveBeenCalled();
    });

    it('and writes no audit entry for an approval that did not happen', async () => {
        db.agentProposal.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow();
        expect(appendAuditEntry).not.toHaveBeenCalled();
    });

    it('the loser does NOT report success', async () => {
        // The original failure mode: the losing caller returned a result with
        // a createdEntityId pointing at its own orphaned duplicate.
        db.agentProposal.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(approveAgentProposal(ctx, 'p1')).rejects.toBeDefined();
    });
});

describe('a failed create does NOT hand the claim back', () => {
    /**
     * An earlier version of this fix reverted to PENDING here. An adversarial
     * review killed it, correctly: the revert rests on "the create threw, so
     * nothing was committed", and that premise does not survive a transaction
     * boundary.
     *
     *   - createRisk/createControl await bumpEntityCacheVersion AFTER their
     *     transaction commits, and getRedis() is outside that helper's
     *     try/catch, so it can reject with the row already written.
     *   - Runtime traffic goes through PgBouncer in transaction mode, where a
     *     connection drop during COMMIT rejects a transaction Postgres has
     *     already committed.
     *
     * Reverting in either case re-arms the create over a record that already
     * exists, and the next approver makes a second one — the original bug,
     * reintroduced through the rollback.
     */
    it('leaves the proposal claimed rather than re-arming the create path', async () => {
        createRisk.mockRejectedValue(new Error('commit lost'));
        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow(/commit lost/);

        const reverts = db.agentProposal.updateMany.mock.calls.filter(
            (c) => (c[0] as any).data?.status === 'PENDING',
        );
        expect(reverts).toEqual([]);
    });

    it('records the failure loudly instead of swallowing it', async () => {
        // A burned row nobody can see is worse than either failure mode. The
        // previous version ended its revert in `.catch(() => undefined)` with
        // no log, no metric, no audit entry — and a passing test asserted only
        // the rethrow, which locked the silence in.
        createRisk.mockRejectedValue(new Error('commit lost'));
        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow();

        expect(logger.error).toHaveBeenCalled();
        const audited = appendAuditEntry.mock.calls.map((c: any[]) => c[0]?.action);
        expect(audited).toContain('AGENT_PROPOSAL_APPROVAL_FAILED');
    });

    it('the failure audit marks the row as needing manual review', async () => {
        // This is the only breadcrumb pointing at a proposal that is stuck
        // ACCEPTED with no entity: the default queue view lists PENDING only.
        createRisk.mockRejectedValue(new Error('commit lost'));
        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow();

        const entry = appendAuditEntry.mock.calls
            .map((c: any[]) => c[0])
            .find((e: any) => e?.action === 'AGENT_PROPOSAL_APPROVAL_FAILED');
        expect(entry.metadataJson).toMatchObject({ needsManualReview: true });
        expect(entry.detailsJson).toMatchObject({ claimedStatus: 'ACCEPTED' });
    });

    it('rethrows the ORIGINAL error, not an audit-write error', async () => {
        // The caller needs to know why the create failed; a bookkeeping
        // failure masking it would make the real cause unrecoverable.
        createRisk.mockRejectedValue(new Error('validation exploded'));
        appendAuditEntry.mockRejectedValueOnce(new Error('audit sink down'));

        await expect(approveAgentProposal(ctx, 'p1')).rejects.toThrow(/validation exploded/);
    });
});

describe('an edited approval claims as EDITED', () => {
    it('claims with EDITED, and the failure audit says so', async () => {
        createRisk.mockRejectedValue(new Error('nope'));
        await expect(
            approveAgentProposal(ctx, 'p1', { title: 'Edited title' }),
        ).rejects.toThrow();

        expect(db.agentProposal.updateMany.mock.calls[0][0].data.status).toBe('EDITED');
        const entry = appendAuditEntry.mock.calls
            .map((c: any[]) => c[0])
            .find((e: any) => e?.action === 'AGENT_PROPOSAL_APPROVAL_FAILED');
        expect(entry.detailsJson.claimedStatus).toBe('EDITED');
    });
});

describe('the created entity is attached after the create', () => {
    it('records createdEntityId against the claim it already holds', async () => {
        const res = await approveAgentProposal(ctx, 'p1');
        expect(res.createdEntityId).toBe('risk-1');

        const attach = db.agentProposal.updateMany.mock.calls.at(-1)![0];
        expect(attach.data).toMatchObject({ createdEntityId: 'risk-1' });
        // Not PENDING — the row is already claimed, so re-predicating on
        // PENDING here would match nothing and silently drop the id.
        expect(attach.where.status).toBe('ACCEPTED');
    });
});
