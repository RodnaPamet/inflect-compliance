/**
 * Process-map starter templates — integrity + PUT-shape.
 *
 * Guards that each built-in starter is a valid, self-consistent graph and that
 * `buildTemplateGraph` emits exactly the shape the save endpoint accepts
 * (`SaveProcessMapSchema`) — so cloning a starter never fails validation.
 */
import {
    PROCESS_MAP_TEMPLATES,
    getProcessMapTemplate,
    buildTemplateGraph,
} from '@/components/processes/process-map-templates';
import { SaveProcessMapSchema } from '@/app-layer/schemas/process-map';
import { isProcessNodeKind } from '@/components/processes/node-taxonomy';

describe('process-map starter templates', () => {
    it('ships at least a couple of starters with unique ids', () => {
        expect(PROCESS_MAP_TEMPLATES.length).toBeGreaterThanOrEqual(2);
        const ids = PROCESS_MAP_TEMPLATES.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it.each(PROCESS_MAP_TEMPLATES)('$id is a self-consistent DOCUMENT graph', (tpl) => {
        const nodeKeys = new Set(tpl.nodes.map((n) => n.nodeKey));
        // Unique node keys.
        expect(nodeKeys.size).toBe(tpl.nodes.length);
        // Only DOCUMENT node kinds.
        for (const n of tpl.nodes) {
            expect(isProcessNodeKind(n.nodeType)).toBe(true);
            expect(['processStep', 'decision']).toContain(n.nodeType);
        }
        // Every edge references existing nodes; edge keys are unique.
        const edgeKeys = new Set(tpl.edges.map((e) => e.edgeKey));
        expect(edgeKeys.size).toBe(tpl.edges.length);
        for (const e of tpl.edges) {
            expect(nodeKeys.has(e.sourceKey)).toBe(true);
            expect(nodeKeys.has(e.targetKey)).toBe(true);
        }
    });

    it.each(PROCESS_MAP_TEMPLATES)('$id builds a PUT-valid graph', (tpl) => {
        const graph = buildTemplateGraph(tpl);
        // The save endpoint must accept the built graph verbatim.
        const parsed = SaveProcessMapSchema.safeParse(graph);
        expect(parsed.success).toBe(true);
        expect(graph.nodes).toHaveLength(tpl.nodes.length);
        expect(graph.edges).toHaveLength(tpl.edges.length);
        // No edge-mounted controls on a generic starter (they'd need real FK rows).
        for (const e of graph.edges) {
            expect(e.controls).toEqual([]);
            expect(e.edgeKind).toBe('flow');
        }
    });

    it('getProcessMapTemplate resolves by id and misses safely', () => {
        expect(getProcessMapTemplate('access-review')?.id).toBe('access-review');
        expect(getProcessMapTemplate('does-not-exist')).toBeUndefined();
    });
});
