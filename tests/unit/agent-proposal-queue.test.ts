/**
 * `annotateProposalQueue` — the signatures and the key prefix the proposals
 * page shows beside each row, read once per fact for the whole page.
 *
 *   · signatures count DISTINCT people and only the outcomes approval counts
 *     (ACCEPTED, EDITED), so the page and `approveAgentProposal` agree about
 *     how many a proposal holds;
 *   · `signedByViewer` is the viewer's own signature and nobody else's;
 *   · the key is named by its stored `keyPrefix`, never by its id;
 *   · both reads are tenant-scoped and bounded, and every proposal gets an entry.
 */
const db = {
    agentProposalApproval: { findMany: jest.fn() },
    tenantApiKey: { findMany: jest.fn() },
};
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

import { annotateProposalQueue } from '@/app-layer/usecases/agent-proposal-queue';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'viewer' });

beforeEach(() => {
    jest.clearAllMocks();
    db.agentProposalApproval.findMany.mockResolvedValue([]);
    db.tenantApiKey.findMany.mockResolvedValue([]);
});

describe('annotateProposalQueue', () => {
    it('counts distinct approving signers, and knows the viewer’s own', async () => {
        db.agentProposalApproval.findMany.mockResolvedValue([
            { proposalId: 'p1', approverUserId: 'alice' },
            { proposalId: 'p2', approverUserId: 'viewer' },
            // A repeated row (the unique index forbids it) still counts once.
            { proposalId: 'p2', approverUserId: 'viewer' },
        ]);
        const out = await annotateProposalQueue(ctx, [
            { id: 'p1', proposedViaKeyId: null },
            { id: 'p2', proposedViaKeyId: null },
            { id: 'p3', proposedViaKeyId: null },
        ]);
        expect(out.get('p1')).toMatchObject({ approvalsRecorded: 1, signedByViewer: false });
        expect(out.get('p2')).toMatchObject({ approvalsRecorded: 1, signedByViewer: true });
        expect(out.get('p3')).toMatchObject({ approvalsRecorded: 0, signedByViewer: false });
    });

    it('reads only this tenant’s approving outcomes for these proposals, bounded', async () => {
        await annotateProposalQueue(ctx, [
            { id: 'p1', proposedViaKeyId: null },
            { id: 'p2', proposedViaKeyId: null },
        ]);
        const args = db.agentProposalApproval.findMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: 't1',
            proposalId: { in: ['p1', 'p2'] },
            outcome: { in: ['ACCEPTED', 'EDITED'] },
        });
        expect(args.take).toBeGreaterThan(0);
    });

    it('names a key by its prefix, and an unreadable key by nothing', async () => {
        db.tenantApiKey.findMany.mockResolvedValue([{ id: 'k1', keyPrefix: 'iflk_ab1' }]);
        const out = await annotateProposalQueue(ctx, [
            { id: 'p1', proposedViaKeyId: 'k1' },
            { id: 'p2', proposedViaKeyId: 'k-gone' },
            { id: 'p3', proposedViaKeyId: 'k1' },
            { id: 'p4', proposedViaKeyId: null },
        ]);
        expect(out.get('p1')?.proposedViaKeyPrefix).toBe('iflk_ab1');
        expect(out.get('p2')?.proposedViaKeyPrefix).toBeNull();
        expect(out.get('p3')?.proposedViaKeyPrefix).toBe('iflk_ab1');
        expect(out.get('p4')?.proposedViaKeyPrefix).toBeNull();
        const args = db.tenantApiKey.findMany.mock.calls[0][0];
        // Each key once, tenant-scoped, and only the prefix.
        expect(args.where).toEqual({ tenantId: 't1', id: { in: ['k1', 'k-gone'] } });
        expect(args.select).toEqual({ id: true, keyPrefix: true });
        expect(args.take).toBe(2);
    });

    it('reads no key when no proposal came through one, and nothing for an empty page', async () => {
        await annotateProposalQueue(ctx, [{ id: 'p1', proposedViaKeyId: null }]);
        expect(db.tenantApiKey.findMany).not.toHaveBeenCalled();
        jest.clearAllMocks();
        expect((await annotateProposalQueue(ctx, [])).size).toBe(0);
        expect(db.agentProposalApproval.findMany).not.toHaveBeenCalled();
    });
});
