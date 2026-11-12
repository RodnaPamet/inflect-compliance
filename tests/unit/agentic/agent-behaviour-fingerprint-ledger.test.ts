/**
 * The fingerprint's ledger read turns grouped counts into features, and asks
 * only for the register's own agents on one day (Morpheus Phase 1).
 *
 *   - a guard flag is a FLAGGED or QUARANTINED proposal, never a CLEAN one;
 *   - active hours are the number of behaviour windows (one per active hour);
 *   - tokens are tokensIn + tokensOut;
 *   - every read is anchored on the tenant, the given agent ids and the day;
 *   - no agents means no read at all.
 */
import { readLedgerDay } from '@/app-layer/usecases/agent-behaviour-fingerprint-ledger';

function fakeDb() {
    return {
        agentBehaviourWindow: {
            groupBy: jest.fn().mockResolvedValue([
                { agentId: 'a1', _sum: { readCalls: 90, proposeCalls: 4, orchestrateCalls: null }, _count: { _all: 6 } },
            ]),
        },
        agentProposal: {
            groupBy: jest.fn().mockResolvedValue([
                { agentId: 'a1', guardVerdict: 'CLEAN', _count: { _all: 5 } },
                { agentId: 'a1', guardVerdict: 'FLAGGED', _count: { _all: 2 } },
                { agentId: 'a2', guardVerdict: 'QUARANTINED', _count: { _all: 1 } },
            ]),
        },
        aiDecisionLog: {
            groupBy: jest.fn().mockResolvedValue([
                { agentId: 'a2', _sum: { tokensIn: 1000, tokensOut: 250 }, _count: { _all: 3 } },
            ]),
        },
    };
}

const START = new Date('2026-11-11T00:00:00.000Z');
const END = new Date('2026-11-12T00:00:00.000Z');

describe('readLedgerDay', () => {
    it('builds each active agent\'s features from the three grouped reads', async () => {
        const db = fakeDb();
        const out = await readLedgerDay(db as never, 't1', ['a1', 'a2'], START, END);
        expect(out.get('a1')).toEqual({
            readCalls: 90, proposeCalls: 4, orchestrateCalls: 0, activeHours: 6,
            proposals: 7, guardFlags: 2, modelCalls: 0, tokens: 0,
        });
        expect(out.get('a2')).toEqual({
            readCalls: 0, proposeCalls: 0, orchestrateCalls: 0, activeHours: 0,
            proposals: 1, guardFlags: 1, modelCalls: 3, tokens: 1250,
        });
    });

    it('anchors every read on the tenant, the given agents and the one day', async () => {
        const db = fakeDb();
        await readLedgerDay(db as never, 't1', ['a1', 'a2'], START, END);
        const windowArgs = db.agentBehaviourWindow.groupBy.mock.calls[0][0];
        expect(windowArgs.where).toEqual({ tenantId: 't1', agentId: { in: ['a1', 'a2'] }, windowStart: { gte: START, lt: END } });
        for (const call of [db.agentProposal.groupBy, db.aiDecisionLog.groupBy]) {
            expect(call.mock.calls[0][0].where).toEqual({ tenantId: 't1', agentId: { in: ['a1', 'a2'] }, createdAt: { gte: START, lt: END } });
            expect(typeof call.mock.calls[0][0].take).toBe('number');
        }
    });

    it('reads nothing for a tenant with no agents', async () => {
        const db = fakeDb();
        expect((await readLedgerDay(db as never, 't1', [], START, END)).size).toBe(0);
        expect(db.agentBehaviourWindow.groupBy).not.toHaveBeenCalled();
    });
});
