/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * VR-3 — Canvas ↔ AutomationRule bridge.
 *
 * Verifies the sync + hydration AND the load-bearing invariant: geometry
 * never reaches a rule write; only `ruleId` is ever written to a node.
 */

jest.mock('@/app-layer/automation', () => ({
    AutomationRuleRepository: { create: jest.fn(), update: jest.fn(), getById: jest.fn() },
}));

// The sync now asserts automation-manage and runs the shared cycle guard.
// Mocks must mirror EVERY export it references — a partial mock turns a
// missing symbol into a TypeError that masquerades as the code under test.
jest.mock('@/app-layer/automation/policies', () => ({
    assertCanManageAutomation: (...a: unknown[]) => assertManage(...a),
}));
jest.mock('@/app-layer/usecases/automation-rules', () => ({
    assertNoChainCycle: (...a: unknown[]) => assertCycle(...a),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));
const assertManage = jest.fn();
const assertCycle = jest.fn();
const logEventMock = jest.fn().mockResolvedValue(undefined);

import { syncCanvasToRules, hydrateCanvasFromRules } from '@/app-layer/services/canvas-rule-sync';
import { AutomationRuleRepository } from '@/app-layer/automation';

const repo = AutomationRuleRepository as jest.Mocked<typeof AutomationRuleRepository>;

// ADMIN-shaped by default: the sync requires automation-manage now.
const ctx = {
    tenantId: 't1',
    userId: 'u1',
    permissions: { canRead: true, canWrite: true, canAdmin: true },
} as any;

function makeDb(nodes: any[], edges: any[]) {
    return {
        processNode: { findMany: jest.fn().mockResolvedValue(nodes), updateMany: jest.fn() },
        processEdge: { findMany: jest.fn().mockResolvedValue(edges) },
        automationRule: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks resets CALLS but not IMPLEMENTATIONS — a `mockImplementation`
    // that throws would otherwise leak into every later test and make an
    // unrelated assertion fail with the wrong error.
    assertManage.mockReset();
    assertCycle.mockReset();
    logEventMock.mockReset().mockResolvedValue(undefined);
    // Default: every claimed ruleId verifies as a real in-tenant rule.
    (AutomationRuleRepository as any).getById.mockImplementation(
        async (_db: unknown, _ctx: unknown, id: string) => ({ id, nextRuleId: null, elseRuleId: null }),
    );
});

describe('syncCanvasToRules', () => {
    it('creates a stub rule for a new action node and writes only ruleId back', async () => {
        const db = makeDb(
            [{ nodeKey: 'a1', nodeType: 'action', label: 'Notify', dataJson: { color: 'blue' } }],
            [],
        );
        repo.create.mockResolvedValue({ id: 'rule-1' } as any);

        const res = await syncCanvasToRules(db, ctx, 'map-1');

        expect(res.rulesCreated).toBe(1);
        // node-write carries ONLY dataJson with ruleId (+ preserved fields), no logic
        const nodeWrite = db.processNode.updateMany.mock.calls[0][0];
        expect(nodeWrite.data.dataJson).toEqual({ color: 'blue', ruleId: 'rule-1' });
        expect(JSON.stringify(nodeWrite.data)).not.toMatch(/triggerFilterJson|actionConfigJson/);
        // rule-write carries NO geometry
        const ruleCreate = repo.create.mock.calls[0][2];
        expect(JSON.stringify(ruleCreate)).not.toMatch(/posX|posY|parentNodeKey/);
    });

    it('skips an action node that already has a ruleId', async () => {
        const db = makeDb(
            [{ nodeKey: 'a1', nodeType: 'action', label: 'X', dataJson: { ruleId: 'r-existing' } }],
            [],
        );
        const res = await syncCanvasToRules(db, ctx, 'map-1');
        expect(res.rulesCreated).toBe(0);
        expect(repo.create).not.toHaveBeenCalled();
        expect(db.processNode.updateMany).not.toHaveBeenCalled();
    });

    it('wires a chain-delay edge to nextRuleId on the source rule', async () => {
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
            ],
            [{ sourceKey: 'a1', targetKey: 'a2', edgeKind: 'chain-delay', dataJson: { delayMinutes: 15 } }],
        );
        const res = await syncCanvasToRules(db, ctx, 'map-1');
        expect(res.chainsLinked).toBe(1);
        expect(repo.update).toHaveBeenCalledWith(db, ctx, 'r1', {
            nextRuleId: 'r2',
            nextRuleDelay: 15,
        });
    });

    it('PR-F: materializes condition-pass → nextRuleId and condition-fail → elseRuleId', async () => {
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
                { nodeKey: 'a3', nodeType: 'action', label: 'C', dataJson: { ruleId: 'r3' } },
            ],
            [
                { sourceKey: 'a1', targetKey: 'a2', edgeKind: 'condition-pass', dataJson: null },
                { sourceKey: 'a1', targetKey: 'a3', edgeKind: 'condition-fail', dataJson: null },
            ],
        );
        await syncCanvasToRules(db, ctx, 'map-1');
        expect(repo.update).toHaveBeenCalledWith(db, ctx, 'r1', { nextRuleId: 'r2', nextRuleDelay: null });
        expect(repo.update).toHaveBeenCalledWith(db, ctx, 'r1', { elseRuleId: 'r3' });
    });
});

describe('hydrateCanvasFromRules', () => {
    it('merges live rule status/executionCount/subtitle into action nodes', async () => {
        const db = makeDb([], []);
        db.automationRule.findMany.mockResolvedValue([
            { id: 'r1', status: 'ENABLED', executionCount: 7, triggerEvent: 'RISK_CREATED', actionType: 'NOTIFY_USER' },
        ]);
        const out = await hydrateCanvasFromRules(db, ctx, [
            { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
            { nodeKey: 'p1', nodeType: 'processStep', label: 'P', dataJson: { foo: 1 } },
        ] as any);
        expect(out[0].dataJson).toMatchObject({
            ruleId: 'r1',
            ruleStatus: 'ENABLED',
            executionCount: 7,
            ruleSubtitle: 'RISK_CREATED · NOTIFY_USER',
        });
        // non-action node untouched
        expect(out[1].dataJson).toEqual({ foo: 1 });
    });
});

// ─── P1.1 — privilege escalation via the canvas ─────────────────────
//
// `saveProcessMap` gates on assertCanWrite (EDITOR); this sync creates and
// updates AutomationRule rows, which REST requires ADMIN for. The canvas was
// therefore a lower-privilege path to the same writes, and `dataJson.ruleId`
// is `z.unknown()` — so an EDITOR could name an ADMIN's rule id and have the
// chain loop rewire it.

describe('syncCanvasToRules — authorization', () => {
    const editorCtx = {
        tenantId: 't1',
        userId: 'u1',
        permissions: { canRead: true, canWrite: true, canAdmin: false },
    } as any;

    it('refuses an EDITOR when the map would write rules', async () => {
        assertManage.mockImplementation(() => {
            throw new Error('Requires ADMIN role');
        });
        const db = makeDb(
            [{ nodeKey: 'a1', nodeType: 'action', label: 'Notify', dataJson: {} }],
            [],
        );

        await expect(syncCanvasToRules(db, editorCtx, 'map-1')).rejects.toThrow(/ADMIN/);
        // Nothing written — the assert must precede every mutation.
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('does NOT gate a canvas with no action nodes and no chain edges', async () => {
        // An EDITOR must keep editing plain document canvases; gating those on
        // ADMIN would be a functional regression unrelated to the escalation.
        const db = makeDb([], []);
        await expect(syncCanvasToRules(db, editorCtx, 'map-1')).resolves.toEqual({
            rulesCreated: 0,
            chainsLinked: 0,
        });
        expect(assertManage).not.toHaveBeenCalled();
    });
});

describe('syncCanvasToRules — claimed rule ids are verified', () => {
    it('ignores a ruleId that does not resolve in this tenant and creates a fresh rule', async () => {
        // The attack shape: an action node carrying someone else's rule id.
        // `getById` runs tenant-bound, so a foreign id resolves to null.
        (AutomationRuleRepository as any).getById.mockResolvedValue(null);
        repo.create.mockResolvedValue({ id: 'rule-fresh' } as any);

        const db = makeDb(
            [{ nodeKey: 'a1', nodeType: 'action', label: 'X', dataJson: { ruleId: 'rule-from-another-tenant' } }],
            [],
        );

        const res = await syncCanvasToRules(db, ctx, 'map-1');

        // The claimed id was dropped, not adopted.
        expect(res.rulesCreated).toBe(1);
        const nodeWrite = db.processNode.updateMany.mock.calls[0][0];
        expect(nodeWrite.data.dataJson.ruleId).toBe('rule-fresh');
        expect(nodeWrite.data.dataJson.ruleId).not.toBe('rule-from-another-tenant');
    });
});

describe('syncCanvasToRules — cycle guard + audit', () => {
    it('runs the cycle guard before wiring each chain edge', async () => {
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
            ],
            [{ sourceKey: 'a1', targetKey: 'a2', edgeKind: 'chain-delay', dataJson: {} }],
        );

        await syncCanvasToRules(db, ctx, 'map-1');
        expect(assertCycle).toHaveBeenCalled();
    });

    it('refuses to wire an edge the cycle guard rejects', async () => {
        assertCycle.mockImplementation(() => {
            throw new Error('Rule chain would create a cycle');
        });
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
            ],
            [{ sourceKey: 'a1', targetKey: 'a2', edgeKind: 'chain-delay', dataJson: {} }],
        );

        await expect(syncCanvasToRules(db, ctx, 'map-1')).rejects.toThrow(/cycle/);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('audits the rule writes, naming the rule ids', async () => {
        // saveProcessMap already emits a ProcessMap/UPDATE row, but it carries
        // no rule ids — so a chain rewire left no trace of WHICH rules changed.
        const db = makeDb(
            [
                { nodeKey: 'a1', nodeType: 'action', label: 'A', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'a2', nodeType: 'action', label: 'B', dataJson: { ruleId: 'r2' } },
            ],
            [{ sourceKey: 'a1', targetKey: 'a2', edgeKind: 'chain-delay', dataJson: {} }],
        );

        await syncCanvasToRules(db, ctx, 'map-1');

        const payload = logEventMock.mock.calls[0][2];
        expect(payload.action).toBe('AUTOMATION_RULES_SYNCED_FROM_CANVAS');
        expect(payload.detailsJson.ruleIds).toEqual(expect.arrayContaining(['r1', 'r2']));
    });

    it('stays quiet when nothing was written', async () => {
        const db = makeDb([], []);
        await syncCanvasToRules(db, ctx, 'map-1');
        expect(logEventMock).not.toHaveBeenCalled();
    });
});
