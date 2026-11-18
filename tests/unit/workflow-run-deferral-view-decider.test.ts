/**
 * The run page's deferral view names its decider by display name, resolved on
 * the server, and never hands the browser the raw user id (#5764). A decider
 * who is not a member of this workspace is unnamed, not shown as an id.
 */
const deferral = {
    status: 'DECIDED',
    decision: 'ACCEPTED',
    proposalId: 'prop-1',
    toolCalled: 'propose_risks',
    stepSeq: 0,
    parkedAt: new Date('2026-11-13T10:00:00Z'),
    decidedAt: new Date('2026-11-13T11:00:00Z'),
    decidedByUserId: 'user-9',
};

jest.mock('@/lib/agentic/drivers/deferral-store', () => ({
    readLatestDeferral: jest.fn(async () => deferral),
    readWaitingRunsForProposals: jest.fn(),
}));

const membershipFindFirst = jest.fn();
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            agentProposal: { findFirst: jest.fn(async () => ({ kind: 'RISK', expiresAt: null })) },
            tenantMembership: { findFirst: membershipFindFirst },
        }),
    ),
}));

import { readRunDeferralView } from '@/app-layer/usecases/workflow-run-deferral-views';
import { makeRequestContext } from '../helpers/make-context';

describe('readRunDeferralView: who decided', () => {
    beforeEach(() => membershipFindFirst.mockReset());

    it("names a member of this workspace, read in this workspace, and carries no id", async () => {
        membershipFindFirst.mockResolvedValue({ user: { name: 'Dana Decider', email: 'dana@example.test' } });
        const view = await readRunDeferralView(makeRequestContext('ADMIN', { tenantId: 't-1' }), 'run-1');
        expect(view?.decidedBy).toBe('Dana Decider');
        expect(membershipFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 't-1', userId: 'user-9' } }),
        );
        expect(JSON.stringify(view)).not.toContain('user-9');
    });

    it('falls back to the email when the member has no name', async () => {
        membershipFindFirst.mockResolvedValue({ user: { name: null, email: 'dana@example.test' } });
        const view = await readRunDeferralView(makeRequestContext('ADMIN'), 'run-1');
        expect(view?.decidedBy).toBe('dana@example.test');
    });

    it('leaves a decider who is not a member here unnamed', async () => {
        membershipFindFirst.mockResolvedValue(null);
        const view = await readRunDeferralView(makeRequestContext('ADMIN'), 'run-1');
        expect(view?.decidedBy).toBeNull();
        expect(JSON.stringify(view)).not.toContain('user-9');
    });
});
