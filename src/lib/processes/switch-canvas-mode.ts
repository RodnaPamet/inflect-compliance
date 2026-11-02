/**
 * Switch a process map between DOCUMENT and AUTOMATION canvas mode.
 *
 * A metadata-only PATCH (no graph save) so a user can convert an existing
 * process map into the visual rule editor (or back) from the document bar.
 *
 * A refusal throws the server's own sentence, or an empty message for the
 * caller to replace with its translated one — never the status code (#4987).
 */
import { refusalReason } from '@/lib/api-error';

export type CanvasMode = 'DOCUMENT' | 'AUTOMATION';

export async function patchCanvasMode(
    tenantSlug: string,
    mapId: string,
    canvasMode: CanvasMode,
): Promise<void> {
    const res = await fetch(`/api/t/${tenantSlug}/processes/${mapId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasMode }),
    });
    if (!res.ok) throw new Error(await refusalReason(res));
}

/** Process-map lifecycle status. */
export type ProcessMapStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

/**
 * Transition a process map's lifecycle status. A metadata-only PATCH
 * (no graph save) — mirrors `patchCanvasMode`.
 */
export async function patchProcessStatus(
    tenantSlug: string,
    mapId: string,
    status: ProcessMapStatus,
): Promise<void> {
    const res = await fetch(`/api/t/${tenantSlug}/processes/${mapId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(await refusalReason(res));
}

/** Soft-delete a process map from the document bar. */
export async function deleteProcessMap(
    tenantSlug: string,
    mapId: string,
): Promise<void> {
    const res = await fetch(`/api/t/${tenantSlug}/processes/${mapId}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error(await refusalReason(res));
}
