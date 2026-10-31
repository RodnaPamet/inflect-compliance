/**
 * RQ-5 — hierarchy roll-up (pure `aggregateTree`). No DB.
 */
import { aggregateTree } from '@/app-layer/usecases/risk-hierarchy';

// Tree:  Eng (root)
//          ├─ Platform
//          └─ Security
const roots = [{ id: 'eng', name: 'Engineering' }];
const childrenByParent = new Map([['eng', [{ id: 'plat', name: 'Platform' }, { id: 'sec', name: 'Security' }]]]);
const aleByRisk = new Map([['r1', 100_000], ['r2', 50_000], ['r3', 30_000]]);

describe('aggregateTree', () => {
    it('sums ALE across child nodes recursively', () => {
        const riskIdsByNode = new Map([['plat', ['r1']], ['sec', ['r2', 'r3']]]);
        const [eng] = aggregateTree(roots, childrenByParent, riskIdsByNode, aleByRisk);
        expect(eng.totalAle).toBe(180_000); // 100k + 50k + 30k
        expect(eng.riskCount).toBe(3);
        expect(eng.children).toHaveLength(2);
        expect(eng.children.find((c) => c.nodeId === 'plat')!.totalAle).toBe(100_000);
    });

    it('does NOT double-count a risk linked to two children', () => {
        // r1 is in BOTH Platform and Security.
        const riskIdsByNode = new Map([['plat', ['r1']], ['sec', ['r1', 'r2']]]);
        const [eng] = aggregateTree(roots, childrenByParent, riskIdsByNode, aleByRisk);
        // Parent dedups: {r1, r2} → 150k, count 2 (not 250k / 3).
        expect(eng.totalAle).toBe(150_000);
        expect(eng.riskCount).toBe(2);
        // Each child still counts its own.
        expect(eng.children.find((c) => c.nodeId === 'plat')!.riskCount).toBe(1);
        expect(eng.children.find((c) => c.nodeId === 'sec')!.riskCount).toBe(2);
    });

    it('a node directly linked + via child still dedups', () => {
        const riskIdsByNode = new Map([['eng', ['r1']], ['plat', ['r1']]]);
        const [eng] = aggregateTree(roots, childrenByParent, riskIdsByNode, aleByRisk);
        expect(eng.riskCount).toBe(1);
        expect(eng.totalAle).toBe(100_000);
    });

    it('empty node → zeros', () => {
        const [eng] = aggregateTree(roots, new Map(), new Map(), aleByRisk);
        expect(eng.totalAle).toBe(0);
        expect(eng.riskCount).toBe(0);
        expect(eng.children).toHaveLength(0);
    });

    it('multiple roots aggregate independently (treemap shape)', () => {
        const r2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
        const out = aggregateTree(r2, new Map(), new Map([['a', ['r1']], ['b', ['r2']]]), aleByRisk);
        expect(out).toHaveLength(2);
        expect(out[0].totalAle).toBe(100_000);
        expect(out[1].totalAle).toBe(50_000);
    });
});

describe('aggregateTree — the risks attached to each node (#4772)', () => {
    it("lists a node's own risks with their titles, not its children's", () => {
        const roots = [{ id: 'eng', name: 'Engineering' }];
        const childrenByParent = new Map([['eng', [{ id: 'plat', name: 'Platform' }]]]);
        const riskIdsByNode = new Map([['eng', ['r1']], ['plat', ['r2']]]);
        const aleByRisk = new Map([['r1', 100], ['r2', 50]]);
        const titles = new Map([['r1', 'Ransomware'], ['r2', 'Outage']]);

        const [eng] = aggregateTree(roots, childrenByParent, riskIdsByNode, aleByRisk, titles);

        expect(eng.risks).toEqual([{ id: 'r1', title: 'Ransomware' }]);
        expect(eng.children[0].risks).toEqual([{ id: 'r2', title: 'Outage' }]);
        expect(eng.riskCount).toBe(2);
    });
});
