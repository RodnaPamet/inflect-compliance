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
 *       `surfaceVersionConflict(res, toast, onReload, copy)` and returns
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
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import type { ToastApi } from '@inflect/ui/components/ui/hooks/use-toast';

/**
 * The toast's words, in the user's locale (#5316). Passed in rather than
 * written here: the helper is not a component and holds no translator, and an
 * English default would let a caller that forgot to pass the copy show English
 * to a Bulgarian user with nothing failing. A hook gets it from
 * `useVersionConflictCopy()`.
 *
 * Strings only, so the copy is equal across renders by value and can sit in a
 * save callback's dependencies (`use-tldraw-document-bar` does the same with
 * its failure messages).
 */
export interface VersionConflictCopy {
    /** The toast's message. */
    title: string;
    /** Description when the server named its current version; `{version}` is replaced. */
    lostOnReloadAtVersion: string;
    /** Description when it did not. */
    lostOnReload: string;
    /** The action's label. */
    reload: string;
}

/** The toast copy, from `automation.canvas.versionConflict*`. */
export function useVersionConflictCopy(): VersionConflictCopy {
    const t = useTranslations('automation.canvas');
    const title = t('versionConflictTitle');
    // Raw, not formatted: the version is only known when the 409 arrives.
    const lostOnReloadAtVersion = String(t.raw('versionConflictLostOnReloadAtVersion'));
    const lostOnReload = t('versionConflictLostOnReload');
    const reload = t('versionConflictReload');
    return useMemo(
        () => ({ title, lostOnReloadAtVersion, lostOnReload, reload }),
        [title, lostOnReloadAtVersion, lostOnReload, reload],
    );
}

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
    copy: VersionConflictCopy,
): Promise<boolean> {
    if (res.status !== 409) return false;

    let currentVersion: number | undefined;
    try {
        const body = (await res.json()) as VersionConflictBody;
        currentVersion = body?.error?.details?.currentVersion;
    } catch {
        // Best-effort body parse; the toast copy stands either way.
    }

    toast.error(copy.title, {
        description:
            currentVersion !== undefined
                ? copy.lostOnReloadAtVersion.replace('{version}', String(currentVersion))
                : copy.lostOnReload,
        action: {
            label: copy.reload,
            onClick: onReload,
        },
    });

    return true;
}
