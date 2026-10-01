/**
 * Auto-layout names no renderer.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * `canvas-auto-layout.ts` took `Node[]` / `Edge[]` from `@xyflow/react`, which
 * put a graph-layout algorithm behind a renderer it never used. The practical
 * consequence was found while scoping phase 4: the cutover deletes every module
 * that imports `@xyflow/react`, so it would have deleted auto-layout — dagre
 * LR/TB, selection-only, and force-directed, six commands in all — and tldraw
 * has no graph auto-layout of any kind to replace them with.
 *
 * The module read exactly six fields, and `data` / `style` were ALREADY reached
 * through structural casts because xyflow types them as `Record<string, unknown>`
 * and `CSSProperties`. So the coupling was in the signature only.
 *
 * ── What this file asserts, and why both directions ──────────────────
 *
 * The port is only safe if xyflow's types still satisfy the new ones, and only
 * USEFUL if a tldraw host can satisfy them too. One without the other is a
 * half-done job that typechecks: keeping xyflow assignable alone changes
 * nothing, and accepting tldraw while breaking xyflow would redden the existing
 * canvas instead of preparing its replacement.
 *
 * The assignability checks are COMPILE-time — under ts-jest a bad one fails at
 * transform, reporting zero tests rather than a failed assertion, so the
 * runtime `expect`s below exist to prove the file actually executed.
 */
import type { Edge, Node } from '@xyflow/react';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    computeAutoLayout,
    type LayoutEdge,
    type LayoutNode,
} from '@/lib/processes/canvas-auto-layout';

const MODULE = path.resolve(__dirname, '../../../src/lib/processes/canvas-auto-layout.ts');

describe('the module imports no renderer', () => {
    it('has no import from @xyflow/react', () => {
        const src = fs.readFileSync(MODULE, 'utf8');
        // Strip comments: the docblock NAMES `@xyflow/react` while explaining
        // why it is gone, and a whole-file needle would read its own
        // documentation as the defect it hunts.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/from\s*['"]@xyflow\/react['"]/);
        // Teeth: the prose really does mention it, so the strip is doing work
        // rather than the needle being absent everywhere.
        expect(src).toMatch(/@xyflow\/react/);
    });
});

describe('xyflow records remain assignable — the existing canvas is untouched', () => {
    it('accepts an xyflow Node and Edge without a cast', () => {
        const xyNode: Node = {
            id: 'n1',
            position: { x: 0, y: 0 },
            data: { kind: 'processStep' },
        };
        const xyEdge: Edge = { id: 'e1', source: 'n1', target: 'n2' };

        // The assignments are the assertion. `Node['data']` is
        // `Record<string, unknown>` and `style` is `CSSProperties`; both satisfy
        // the structural fields, which is why no call site had to change.
        const asNode: LayoutNode = xyNode;
        const asEdge: LayoutEdge = xyEdge;

        expect(asNode.id).toBe('n1');
        expect(asEdge.source).toBe('n1');
    });

    it('still lays out an xyflow-shaped graph', () => {
        const nodes: Node[] = [
            { id: 'a', position: { x: 0, y: 0 }, data: {} },
            { id: 'b', position: { x: 0, y: 0 }, data: {} },
        ];
        const edges: Edge[] = [{ id: 'e', source: 'a', target: 'b' }];
        const { positions } = computeAutoLayout(nodes, edges, 'LR');
        expect(Object.keys(positions).sort()).toEqual(['a', 'b']);
        // LR means b sits to the right of a; without that this passes on a
        // layout that put both at the origin.
        expect(positions.b!.x).toBeGreaterThan(positions.a!.x);
    });
});

describe('a tldraw host can satisfy the same contract', () => {
    /**
     * tldraw records carry `x` / `y`, NOT `position`, so a host adapts rather
     * than passing shapes straight through. Written out here because that
     * one-line map IS the integration, and a test that invented a tldraw shape
     * with a `position` field would be asserting against a record tldraw does
     * not produce.
     */
    interface FakeTldrawShape {
        id: string;
        x: number;
        y: number;
        props: { nodeKey: string; nodeType: string };
    }

    const shapes: FakeTldrawShape[] = [
        { id: 'shape:a', x: 10, y: 20, props: { nodeKey: 'a', nodeType: 'processStep' } },
        { id: 'shape:b', x: 10, y: 20, props: { nodeKey: 'b', nodeType: 'processStep' } },
    ];

    const toLayoutNode = (s: FakeTldrawShape): LayoutNode => ({
        id: s.id,
        position: { x: s.x, y: s.y },
        data: { kind: s.props.nodeType },
    });

    it('lays out adapted tldraw shapes', () => {
        const nodes = shapes.map(toLayoutNode);
        const edges: LayoutEdge[] = [
            { id: 'binding:e', source: 'shape:a', target: 'shape:b' },
        ];
        const { positions } = computeAutoLayout(nodes, edges, 'TB');
        expect(Object.keys(positions).sort()).toEqual(['shape:a', 'shape:b']);
        // TB means b sits below a.
        expect(positions['shape:b']!.y).toBeGreaterThan(positions['shape:a']!.y);
    });

    it('skips an annotation the same way for either host', () => {
        // The one semantic field the module reads out of `data`. A tldraw host
        // supplies it from `nodeType`, so the skip has to keep working across
        // the port or annotations start participating in the flow direction.
        const nodes: LayoutNode[] = [
            ...shapes.map(toLayoutNode),
            { id: 'shape:note', position: { x: 5, y: 5 }, data: { kind: 'annotation' } },
        ];
        const { positions } = computeAutoLayout(nodes, [], 'LR');
        expect(Object.keys(positions)).not.toContain('shape:note');
        expect(Object.keys(positions)).toContain('shape:a');
    });

    it('tolerates an absent data and style, which tldraw has no analogue for', () => {
        // `LayoutNode.data` and `.style` are optional because a tldraw shape
        // carries neither. If the module dereferenced them unguarded, the port
        // would throw on the first real call rather than fail a type check.
        const nodes: LayoutNode[] = [
            { id: 'x', position: { x: 0, y: 0 } },
            { id: 'y', position: { x: 0, y: 0 } },
        ];
        expect(() => computeAutoLayout(nodes, [], 'LR')).not.toThrow();
        expect(Object.keys(computeAutoLayout(nodes, [], 'LR').positions).sort()).toEqual(['x', 'y']);
    });
});
