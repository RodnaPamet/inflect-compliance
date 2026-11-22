/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * #5477 — sub-flow group membership from canvas nesting: the nearest-group
 * walk, the clear of rules that left a group, and the gate on any write.
 * The whole path against a real DB is tests/integration/subflow-group-membership.test.ts.
 */
jest.mock('@/app-layer/automation/policies', () => ({
    assertCanManageAutomation: (...a: unknown[]) => assertManage(...a),
}));
const assertManage = jest.fn();

import {
    nearestEnclosingGroup,
    reconcileSubFlowMembership,
} from '@/app-layer/services/canvas-subflow-membership';

const ctx = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: true } } as any;

const n = (nodeKey: string, nodeType: string, parentNodeKey: string | null) => ({ nodeKey, nodeType, parentNodeKey });
const byKey = (...nodes: ReturnType<typeof n>[]) => new Map(nodes.map((x) => [x.nodeKey, x]));

function makeDb(opts: { nodes: any[]; rules: any[]; ownedElsewhere?: any[] }) {
    const processNodeFindMany = jest
        .fn()
        .mockResolvedValueOnce(opts.nodes)
        .mockResolvedValueOnce(opts.ownedElsewhere ?? []);
    return {
        processNode: { findMany: processNodeFindMany },
        automationRule: {
            findMany: jest.fn().mockResolvedValue(opts.rules),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    } as any;
}

beforeEach(() => {
    assertManage.mockReset();
});

describe('nearestEnclosingGroup', () => {
    it('is the NEAREST group, not an outer one', () => {
        const m = byKey(n('outer', 'group', null), n('inner', 'group', 'outer'), n('a', 'action', 'inner'));
        expect(nearestEnclosingGroup('a', m)).toBe('inner');
    });

    it('is null at root, and stops on a parent cycle rather than looping', () => {
        expect(nearestEnclosingGroup('a', byKey(n('a', 'action', null)))).toBeNull();
        const cycle = byKey(n('a', 'action', 'x'), n('x', 'note', 'y'), n('y', 'note', 'x'));
        expect(nearestEnclosingGroup('a', cycle)).toBeNull();
    });
});

describe('reconcileSubFlowMembership', () => {
    it('writes nothing, and asks no permission, when membership is unchanged', async () => {
        const db = makeDb({
            nodes: [n('g', 'group', null), n('a', 'action', 'g')],
            rules: [{ id: 'r1', subFlowGroupId: 'g' }],
        });
        const changed = await reconcileSubFlowMembership(db, ctx, 'map-1', new Map([['a', 'r1']]), []);
        expect(changed).toEqual([]);
        expect(db.automationRule.updateMany).not.toHaveBeenCalled();
        expect(assertManage).not.toHaveBeenCalled();
    });

    it('clears a rule whose step was removed, but keeps one a step on ANOTHER map owns', async () => {
        const db = makeDb({
            nodes: [n('g', 'group', null)],
            rules: [
                { id: 'gone', subFlowGroupId: 'g' },
                { id: 'other-map', subFlowGroupId: 'g' },
            ],
            ownedElsewhere: [{ dataJson: { ruleId: 'other-map' } }],
        });
        const changed = await reconcileSubFlowMembership(db, ctx, 'map-1', new Map(), ['g']);
        expect(changed).toEqual(['gone']);
        expect(db.automationRule.updateMany).toHaveBeenCalledTimes(1);
        expect(db.automationRule.updateMany.mock.calls[0][0]).toEqual({
            where: { tenantId: 't1', id: { in: ['gone'] } },
            data: { subFlowGroupId: null },
        });
    });

    it('gates a save that would only CLEAR membership on the automation-manage permission', async () => {
        assertManage.mockImplementation(() => {
            throw new Error('forbidden');
        });
        const db = makeDb({ nodes: [], rules: [{ id: 'gone', subFlowGroupId: 'g' }] });
        await expect(reconcileSubFlowMembership(db, ctx, 'map-1', new Map(), ['g'])).rejects.toThrow('forbidden');
        expect(db.automationRule.updateMany).not.toHaveBeenCalled();
    });
});
