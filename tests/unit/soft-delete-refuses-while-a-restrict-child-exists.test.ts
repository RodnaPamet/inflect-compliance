/**
 * THE REFUSAL ITSELF — #5083, owner decision 2026-11-13.
 *
 * #5509 made the 90-day purge survive a row a RESTRICT child holds down. This
 * is the other half: the delete is refused when somebody asks for it, so no
 * new blocked rows are created. Refusing rather than cascading is the owner's
 * choice, and the Control edges are why — a control's test runs, test plans
 * and exceptions are evidence, and cascading them would destroy a regulatory
 * record to tidy up a deletion.
 */
import {
    findSoftDeleteBlockers,
    findBlockedParents,
    softDeleteBlockedMessage,
    bulkSoftDeleteBlockedMessage,
    SOFT_DELETE_BLOCKERS,
} from '@/lib/soft-delete-blockers';

const zero = async () => 0;

function controlDb(counts: Partial<Record<string, number>> = {}) {
    return {
        controlException: { count: async () => counts.controlException ?? 0 },
        controlTestPlan: { count: async () => counts.controlTestPlan ?? 0 },
        controlTestRun: { count: async () => counts.controlTestRun ?? 0 },
    };
}

describe('findSoftDeleteBlockers', () => {
    it('finds nothing when no child points at the parent', async () => {
        // The positive control: the refusal must not be unconditional, or it
        // would be indistinguishable from removing the delete.
        const found = await findSoftDeleteBlockers(controlDb(), 'Control', 'c1');
        expect(found).toEqual([]);
    });

    it('names the child that blocks, with its count', async () => {
        const found = await findSoftDeleteBlockers(
            controlDb({ controlTestRun: 3 }),
            'Control',
            'c1',
        );
        expect(found.map((f) => ({ model: f.blocker.model, count: f.count })))
            .toEqual([{ model: 'ControlTestRun', count: 3 }]);
    });

    it('reports EVERY blocking child, not just the first', async () => {
        // A message naming one of three sends somebody to remove it and try
        // again, only to be refused by the next.
        const found = await findSoftDeleteBlockers(
            controlDb({ controlException: 1, controlTestRun: 2 }),
            'Control',
            'c1',
        );
        expect(found.map((f) => f.blocker.model).sort())
            .toEqual(['ControlException', 'ControlTestRun']);
    });

    it('THROWS on a missing delegate rather than reading it as "nothing blocks"', async () => {
        // The failure mode that matters: a client that cannot see the model
        // cannot vouch for it, and treating absence as zero is how a refusal
        // quietly stops refusing.
        await expect(
            findSoftDeleteBlockers({ controlException: { count: zero } }, 'Control', 'c1'),
        ).rejects.toThrow(/no delegate for ControlTestPlan/);
    });

    it('finds nothing for a parent with no blocking edges at all', async () => {
        const found = await findSoftDeleteBlockers({}, 'Evidence', 'e1');
        expect(found).toEqual([]);
    });
});

describe('findBlockedParents — the bulk path', () => {
    it('reports which parents are blocked, one query per EDGE', async () => {
        let queries = 0;
        const db = {
            riskTreatmentPlan: {
                findMany: async () => {
                    queries++;
                    return [{ riskId: 'r2' }, { riskId: 'r2' }];
                },
            },
        };
        const blocked = await findBlockedParents(db, 'Risk', ['r1', 'r2', 'r3']);
        expect([...blocked.keys()]).toEqual(['r2']);
        // One query for the one blocking edge — NOT one per risk, or a bulk
        // delete of fifty rows would be an N+1 on a path a person can reach.
        expect({ queries }).toEqual({ queries: 1 });
    });

    it('is empty for an empty selection, without querying', async () => {
        let queries = 0;
        const db = { riskTreatmentPlan: { findMany: async () => { queries++; return []; } } };
        const blocked = await findBlockedParents(db, 'Risk', []);
        expect({ size: blocked.size, queries }).toEqual({ size: 0, queries: 0 });
    });

    it('THROWS on a missing delegate here too', async () => {
        await expect(findBlockedParents({}, 'Risk', ['r1']))
            .rejects.toThrow(/no delegate for RiskTreatmentPlan/);
    });

    it('dedupes a parent held by several rows of the same child', async () => {
        const db = { riskTreatmentPlan: { findMany: async () => [{ riskId: 'r1' }, { riskId: 'r1' }] } };
        const blocked = await findBlockedParents(db, 'Risk', ['r1']);
        expect(blocked.get('r1')!.map((b) => b.model)).toEqual(['RiskTreatmentPlan']);
    });
});

describe('the sentences a person reads', () => {
    it('names what blocks and how many, and pluralises', () => {
        const msg = softDeleteBlockedMessage('control', [
            { blocker: SOFT_DELETE_BLOCKERS.Control[2], count: 1 },
        ]);
        expect(msg).toContain('1 test run');
        expect(msg).not.toContain('1 test runs');
    });

    it('says nothing was deleted for a refused bulk', () => {
        // All-or-nothing: a caller told "some were deleted" with no list is
        // worse off than one told nothing happened.
        const blocked = new Map([['v1', [SOFT_DELETE_BLOCKERS.Vendor[0]]]]);
        const msg = bulkSoftDeleteBlockedMessage('vendors', blocked);
        expect(msg).toContain('Nothing was deleted');
        expect(msg).toContain('A2A peer');
    });

    it('carries no id, because the string reaches an API response', () => {
        const msg = softDeleteBlockedMessage('risk', [
            { blocker: SOFT_DELETE_BLOCKERS.Risk[0], count: 2 },
        ]);
        expect(msg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    });
});
