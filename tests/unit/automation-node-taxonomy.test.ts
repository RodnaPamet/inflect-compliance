/**
 * VR-1 — automation node taxonomy.
 *
 * The four automation kinds (trigger/condition/action/slaGate) join the
 * canvas taxonomy as flow-category nodes, gated to AUTOMATION mode via a
 * separate palette order.
 */
import {
    NODE_TAXONOMY,
    NODE_TAXONOMY_ORDER,
    AUTOMATION_NODE_ORDER,
    AUTOMATION_NODE_KINDS,
    isProcessNodeKind,
    isAutomationNodeKind,
} from '@/components/processes/node-taxonomy';

describe('automation node taxonomy', () => {
    it('isProcessNodeKind accepts the four new automation kinds', () => {
        for (const k of ['trigger', 'condition', 'action', 'slaGate']) {
            expect(isProcessNodeKind(k)).toBe(true);
        }
        expect(isProcessNodeKind('nope')).toBe(false);
    });

    it('isAutomationNodeKind distinguishes automation from document kinds', () => {
        expect(isAutomationNodeKind('trigger')).toBe(true);
        expect(isAutomationNodeKind('action')).toBe(true);
        expect(isAutomationNodeKind('agent')).toBe(true);
        expect(isAutomationNodeKind('processStep')).toBe(false);
        expect(isAutomationNodeKind('group')).toBe(false);
    });

    it('AUTOMATION_NODE_ORDER has the five kinds and is NOT in the document order', () => {
        // `agent` (#3471) sits beside `action`, not inside it: the canvas has to
        // show that this leaf hands a trigger's fields to a model whose
        // governance lives on `/agents`, which is also what refuses the fire.
        expect(AUTOMATION_NODE_ORDER).toEqual([
            'trigger', 'condition', 'action', 'agent', 'slaGate',
        ]);
        expect(AUTOMATION_NODE_KINDS).toEqual(AUTOMATION_NODE_ORDER);
        for (const k of AUTOMATION_NODE_ORDER) {
            expect(NODE_TAXONOMY_ORDER).not.toContain(k);
        }
    });

    it('each automation kind has a flow-category taxonomy entry with handles', () => {
        for (const k of AUTOMATION_NODE_ORDER) {
            const meta = NODE_TAXONOMY[k];
            expect(meta).toBeDefined();
            expect(meta.category).toBe('flow');
            expect(meta.hasHandles).toBe(true);
            expect(meta.label.length).toBeGreaterThan(0);
        }
    });
});
