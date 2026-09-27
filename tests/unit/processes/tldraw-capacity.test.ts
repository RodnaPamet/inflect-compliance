/**
 * SPIKE ONLY — #2960 §2.5, the editor-side cap warning.
 *
 * The assertion that matters most here is not the arithmetic. It is that the
 * constants still match the schema: a duplicated limit fails in the PERMISSIVE
 * direction, so the editor stops warning before a ceiling that still rejects,
 * and the user meets it as a 400 after ten minutes of work.
 */
import { z } from 'zod';

import {
    graphCapacity,
    NODE_CAP,
    EDGE_CAP,
} from '@/lib/processes/tldraw-spike/capacity';
import { SaveProcessMapSchema } from '@/app-layer/schemas/process-map';

const node = (i: number) => ({
    nodeKey: `n${i}`,
    nodeType: 'processStep',
    label: `Step ${i}`,
    posX: 0,
    posY: 0,
});
const edge = (i: number) => ({ edgeKey: `e${i}`, sourceKey: 'n0', targetKey: 'n0' });

/** Does the real schema accept a graph of this size? */
function schemaAccepts(nodes: number, edges: number): boolean {
    const r = SaveProcessMapSchema.safeParse({
        nodes: Array.from({ length: nodes }, (_, i) => node(i)),
        edges: Array.from({ length: edges }, (_, i) => edge(i)),
    });
    return r.success;
}

describe('the editor caps match the schema that enforces them', () => {
    it('NODE_CAP is exactly where the schema stops accepting', () => {
        // Both sides of the boundary. Asserting only the rejection would pass
        // for a cap set far too LOW, which is the drift that silently stops the
        // editor warning at the right time.
        expect(schemaAccepts(NODE_CAP, 0)).toBe(true);
        expect(schemaAccepts(NODE_CAP + 1, 0)).toBe(false);
    });

    it('EDGE_CAP is exactly where the schema stops accepting', () => {
        expect(schemaAccepts(0, EDGE_CAP)).toBe(true);
        expect(schemaAccepts(0, EDGE_CAP + 1)).toBe(false);
    });

    it('and the probe can fail — a graph inside both caps is accepted', () => {
        // Control: if `schemaAccepts` returned false unconditionally (a typo in
        // the fixture, a required field missing) the two tests above would pass
        // on their rejection halves and prove nothing.
        expect(schemaAccepts(1, 1)).toBe(true);
    });
});

describe('what the editor shows as a graph grows', () => {
    it('stays quiet well below the ceiling', () => {
        expect(graphCapacity(10, 10).state).toBe('ok');
    });

    it('warns with room left to finish a thought, not at the last node', () => {
        // 90% of 500 is 450 — fifty nodes of warning. A countdown that starts
        // at 499 is an error message wearing a warning's clothes.
        expect(graphCapacity(449, 0).state).toBe('ok');
        expect(graphCapacity(450, 0).state).toBe('approaching');
        expect(graphCapacity(450, 0).nodes.remaining).toBe(50);
    });

    it('distinguishes FULL from OVER', () => {
        // Full is a legal graph that cannot grow. Over is a graph that cannot
        // be SAVED — reachable by paste, import or undo even though the server
        // refuses it, which is exactly why the editor has to say so.
        expect(graphCapacity(NODE_CAP, 0).state).toBe('full');
        expect(graphCapacity(NODE_CAP, 0).wouldBeRefused).toBe(false);
        expect(graphCapacity(NODE_CAP + 1, 0).state).toBe('over');
        expect(graphCapacity(NODE_CAP + 1, 0).wouldBeRefused).toBe(true);
    });

    it('reports the WORSE of the two axes, never the node count alone', () => {
        // A map at 8% of the node cap and over the edge cap must not read "ok".
        // Reporting nodes alone is the obvious implementation and it is a green
        // light on a graph that cannot be saved.
        const c = graphCapacity(40, EDGE_CAP + 1);
        expect(c.nodes.state).toBe('ok');
        expect(c.edges.state).toBe('over');
        expect(c.state).toBe('over');
        expect(c.wouldBeRefused).toBe(true);
    });

    it('remaining never goes negative', () => {
        // It is shown to a user. "-3 remaining" is a number nobody can act on.
        expect(graphCapacity(NODE_CAP + 12, 0).nodes.remaining).toBe(0);
    });
});
