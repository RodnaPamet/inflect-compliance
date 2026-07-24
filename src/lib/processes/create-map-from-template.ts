/**
 * Clone a built-in starter template into a fresh DOCUMENT process map.
 *
 * Extracted from `PersistedProcessCanvas` (helper-module-per-feature pattern,
 * mirroring `switch-canvas-mode.ts` / `edge-controls.ts`) so the canvas wires
 * one call instead of owning the two-round-trip create+save boilerplate.
 *
 * The flow mirrors the canvas Duplicate path: POST a fresh map, then PUT the
 * template's nodes/edges. No transactional guarantee — a failed graph save
 * leaves a recoverable empty map behind, signposted by the selector jumping to
 * the new map. Returns the created map's summary for the caller to splice into
 * its list + select.
 */
import { buildTemplateGraph, type ProcessMapTemplate } from '@/components/processes/process-map-templates';
import type { ProcessMapSummary } from '@/app/t/[tenantSlug]/(app)/processes/ProcessesClient';

export async function createMapFromTemplate(
    tenantSlug: string,
    template: ProcessMapTemplate,
): Promise<ProcessMapSummary> {
    const createRes = await fetch(`/api/t/${tenantSlug}/processes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: template.defaultName, canvasMode: 'DOCUMENT' }),
    });
    if (!createRes.ok) throw new Error(`Create failed (${createRes.status})`);
    const newMap = await createRes.json();

    const saveRes = await fetch(`/api/t/${tenantSlug}/processes/${newMap.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTemplateGraph(template)),
    });
    if (!saveRes.ok) throw new Error(`Template save failed (${saveRes.status})`);
    const filled = await saveRes.json();

    return {
        id: filled.id,
        name: filled.name,
        description: filled.description,
        status: filled.status,
        version: filled.version,
        canvasMode: filled.canvasMode ?? 'DOCUMENT',
        createdAt: filled.createdAt,
        updatedAt: filled.updatedAt,
        nodeCount: filled.nodes.length,
        edgeCount: filled.edges.length,
    };
}
