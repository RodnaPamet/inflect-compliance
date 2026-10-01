/**
 * A process map as the list and the canvas chrome see it.
 *
 * ═══ WHY THIS IS NOT IN ProcessesClient ═══
 *
 * It was. `src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx` declared
 * it, and four modules outside that route imported it back — which is the
 * inversion `tests/guards/route-import-boundaries.test.ts` exists to stop: a
 * route directory becoming a module other surfaces depend on, so the shared
 * layer ends up downstream of one page.
 *
 * Two of those four were in that guard's BASELINE, whose comment is explicit
 * that the list "may only SHRINK" and that a new entry "needs the same
 * justification as disabling the guard". Adding a third would have grown it.
 * The guard's own prescribed fix is to promote the shared thing out of the
 * route, so that is what this is — and the two baseline entries are removed in
 * the same diff, which is the only direction that list is allowed to move.
 *
 * `ProcessesClient` re-exports it so existing imports by the old path keep
 * working; the point is that the SHARED layer no longer reaches into the route.
 */
export interface ProcessMapSummary {
    id: string;
    name: string;
    description: string | null;
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    version: number;
    createdAt: string | Date;
    updatedAt: string | Date;
    nodeCount: number;
    edgeCount: number;
    /** VR-2 — DOCUMENT (process map) vs AUTOMATION (visual rule editor). */
    canvasMode?: 'DOCUMENT' | 'AUTOMATION';
}
