/**
 * The server layout of a proposed process map copies the canvas's numbers,
 * and these tests hold the copies equal to their sources (#5053).
 *
 * `proposed-map-layout.ts` cannot import either source: the canvas layout
 * carries `"use client"` (a server import of it is a client reference that
 * throws in production), and the node shape imports tldraw. So the sources are
 * read as TEXT, bound to their declarations, and compared with the exported
 * copies. Change a canvas number and this fails until the server copy follows,
 * which is what keeps a proposed map arranged the way "Arrange" would arrange
 * it.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { codeOf } from '../helpers/source-blocks';

import {
    PROPOSED_MARGIN,
    PROPOSED_NODESEP,
    PROPOSED_NODE_HEIGHT,
    PROPOSED_NODE_WIDTH,
    PROPOSED_RANKDIR,
    PROPOSED_RANKSEP,
} from '@/lib/processes/proposed-map-layout';

const ROOT = path.resolve(__dirname, '../..');
// Comments masked, so a number or an import named only in prose cannot satisfy
// (or, for the negated checks, fail) an assertion about the code.
const read = (rel: string): string => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

/** The numeric value of `const <name> = <n>;` (or `export const`), exactly once. */
function constValue(src: string, name: string): number {
    const re = new RegExp(`^(?:export )?const ${name} = (\\d+);$`, 'gm');
    const hits = [...src.matchAll(re)];
    expect({ name, declarations: hits.length }).toEqual({ name, declarations: 1 });
    return Number(hits[0][1]);
}

describe('proposed-map-layout copies the canvas numbers', () => {
    const canvasLayout = read('src/lib/processes/canvas-auto-layout.ts');
    const nodeShape = read('src/components/processes/tldraw/process-node-shape.ts');

    it('the node box is the tldraw node shape’s default size', () => {
        expect(PROPOSED_NODE_WIDTH).toBe(constValue(nodeShape, 'PROCESS_NODE_DEFAULT_W'));
        expect(PROPOSED_NODE_HEIGHT).toBe(constValue(nodeShape, 'PROCESS_NODE_DEFAULT_H'));
    });

    it('the rank and node separations are the canvas layout’s', () => {
        expect(PROPOSED_RANKSEP).toBe(constValue(canvasLayout, 'RANKSEP'));
        expect(PROPOSED_NODESEP).toBe(constValue(canvasLayout, 'NODESEP'));
    });

    it('the graph margin is the one computeAutoLayout passes dagre', () => {
        const fn = canvasLayout.slice(canvasLayout.indexOf('export function computeAutoLayout('));
        const setGraph = fn.slice(fn.indexOf('g.setGraph({'), fn.indexOf('});', fn.indexOf('g.setGraph({')));
        expect(setGraph).toMatch(new RegExp(`marginx: ${PROPOSED_MARGIN},`));
        expect(setGraph).toMatch(new RegExp(`marginy: ${PROPOSED_MARGIN},`));
    });

    it('the direction is left to right, the canvas’s default Arrange', () => {
        expect(PROPOSED_RANKDIR).toBe('LR');
    });

    it('the canvas layout keeps its "use client" directive (owner decision, 2026-11-11)', () => {
        expect(canvasLayout.startsWith('"use client";')).toBe(true);
    });

    it('the server layout imports dagre itself, and neither source', () => {
        const server = read('src/lib/processes/proposed-map-layout.ts');
        expect(server).toMatch(/^import dagre from '@dagrejs\/dagre';$/m);
        expect(server).not.toMatch(/from '[^']*canvas-auto-layout'/);
        expect(server).not.toMatch(/from '[^']*process-node-shape'/);
        expect(server).not.toMatch(/^['"]use client['"];?$/m);
    });
});
