/**
 * Epic 47.1 — structural ratchet for `<GraphExplorer>` + the
 * traceability graph endpoint wiring.
 *
 * The explorer wraps React Flow; rendering it without a DOM
 * (`jest-environment-jsdom` isn't installed) is impossible.
 * Instead we lock the SHAPE of the composition: that the
 * component imports React Flow + Background + Controls + MiniMap,
 * carries the typed empty-state, and exposes the
 * `data-graph-explorer` test-hook so E2E selectors can find it.
 *
 * Mirrors the pattern at `tests/unit/framework-detail-explorer.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const EXPLORER = path.resolve(
    __dirname,
    '../../src/components/ui/GraphExplorer.tsx',
);
const ROUTE = path.resolve(
    __dirname,
    '../../src/app/api/t/[tenantSlug]/traceability/graph/route.ts',
);
const USECASE = path.resolve(
    __dirname,
    '../../src/app-layer/usecases/traceability-graph.ts',
);

/**
 * MASKED AT THE READ SEAM — #2246 Class A. The twenty whole-file assertions
 * below are about the COMPOSITION that ships, and six of their needles were
 * measured matching fewer times through the mask than raw: `<MiniMap`,
 * `data-graph-explorer`, `fitView`, `nodeTypes`, `RoleGuard` and
 * `traceability-graph` all appear in this file's own prose as well as its
 * code. `codeOf` keeps string literals, so the `data-*` hooks still bind.
 */
function read(p: string): string {
    return codeOf(fs.readFileSync(p, 'utf-8'));
}

describe('GraphExplorer — structural composition', () => {
    const src = read(EXPLORER);

    it('imports React Flow primitives', () => {
        expect(src).toMatch(
            /from\s*'@xyflow\/react'/,
        );
        expect(src).toMatch(/\bReactFlow\b/);
        expect(src).toMatch(/\bBackground\b/);
        expect(src).toMatch(/\bControls\b/);
        expect(src).toMatch(/\bMiniMap\b/);
    });

    it('imports the React Flow stylesheet', () => {
        expect(src).toMatch(/'@xyflow\/react\/dist\/style\.css'/);
    });

    it('exposes the test-hook on the wrapper element', () => {
        // E2E selectors will look for these — bake them into the
        // contract.
        expect(src).toMatch(/data-graph-explorer/);
        expect(src).toMatch(/data-node-count/);
        expect(src).toMatch(/data-edge-count/);
    });

    it('renders a typed empty state when nodes is empty', () => {
        expect(src).toMatch(/graph\.nodes\.length\s*===\s*0/);
        expect(src).toMatch(/data-graph-empty/);
    });

    it('forwards a typed onNodeSelected callback to the parent', () => {
        expect(src).toMatch(/onNodeSelected\?:\s*\(node:\s*TraceabilityNode\)/);
    });

    it('uses the typed graph contract — no `any`-blob props', () => {
        // The component must be typed against the shared contract
        // so future refactors can't slip in a `Record<string,any>`
        // without code review.
        expect(src).toMatch(/graph:\s*TraceabilityGraph/);
    });

    it('renders nodes-as-links by default for navigation', () => {
        expect(src).toMatch(/nodeAsLinks\s*=\s*true/);
    });
});

describe('Traceability graph endpoint wiring', () => {
    const route = read(ROUTE);
    const usecase = read(USECASE);

    it('route delegates to getTraceabilityGraph (no inline DB queries)', () => {
        expect(route).toMatch(/getTraceabilityGraph/);
        // No `prisma.` usage in the route — the boundary is clean.
        expect(route).not.toMatch(/\bprisma\./);
    });

    it('usecase scopes every read inside runInTenantContext', () => {
        expect(usecase).toMatch(/runInTenantContext/);
        // Every model query lives inside the callback. As a smoke
        // check, make sure no bare `prisma.` slipped in for one of
        // the entity queries.
        expect(usecase).not.toMatch(/^\s*prisma\.\w+\.findMany/m);
    });

    it('route + usecase reference the typed payload type', () => {
        expect(route).toMatch(/TraceabilityNodeKind/);
        expect(usecase).toMatch(/TraceabilityGraph\b/);
    });
});
