/**
 * Epic P1 — Surface a version-conflict (HTTP 409 / `STALE_DATA`)
 * response as a sticky error toast with a "Reload" action.
 *
 * Why a standalone helper:
 *   The save flow in `PersistedProcessCanvas.tsx` already lives in
 *   a long file (R32-PR10 decomposition ratchet keeps it ≤1900
 *   lines). Inlining the 409 path adds ~40 lines to that file +
 *   couples the toast vocabulary to the save path. A
 *   `version-conflict` module is the seam:
 *     - the canvas's `handleSave` calls
 *       `surfaceVersionConflict(res, toast, onReload)` and returns
 *       early when the helper returns `true`;
 *     - future write paths (auto-arrange that issues its own save,
 *       a bulk-import server commit) can reuse the same toast
 *       vocabulary by importing the helper.
 *
 * Why fail-soft on body parse:
 *   The server WILL send `{ error: { details: { currentVersion } } }`
 *   today — but a misbehaving proxy might return a 409 with an empty
 *   body, and that should still surface the toast. The
 *   currentVersion line in the description is the polish; the
 *   Reload action is the safety mechanism, and it stands either
 *   way.
 */
import type { ToastApi } from '@inflect/ui/components/ui/hooks/use-toast';

interface VersionConflictBody {
    error?: {
        code?: string;
        details?: { currentVersion?: number };
    };
}

/**
 * If `res.status === 409`, surface the version-conflict toast and
 * return `true` (signal to the caller to stop the save flow).
 * Otherwise return `false` (caller continues with the normal
 * error/success branches).
 */
export async function surfaceVersionConflict(
    res: Response,
    toast: ToastApi,
    onReload: () => void,
): Promise<boolean> {
    if (res.status !== 409) return false;

    let currentVersion: number | undefined;
    try {
        const body = (await res.json()) as VersionConflictBody;
        currentVersion = body?.error?.details?.currentVersion;
    } catch {
        // Best-effort body parse; the toast copy stands either way.
    }

    toast.error(
        'Someone else saved this map. Reload to see the latest version.',
        {
            description:
                currentVersion !== undefined
                    ? `Server version is now v${currentVersion}; your edits will be lost on reload.`
                    : 'Your edits will be lost on reload.',
            action: {
                label: 'Reload',
                onClick: onReload,
            },
        },
    );

    return true;
}
