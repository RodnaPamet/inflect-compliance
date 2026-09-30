'use client';

/**
 * RQ4-3 — Per-tab previous-path tracker.
 *
 * Reads from `sessionStorage` (per-tab, ephemeral, cross-tenant-safe) and
 * returns the in-tenant pathname the user navigated FROM, or `null` when
 * the user arrived via a cold load / deep link / fresh tab. The
 * `<BackAffordance>` primitive (RQ4-4) falls back to the canonical parent
 * when this returns null.
 *
 * Why sessionStorage and not localStorage:
 *   - per-tab — two tabs don't fight over the same slot (OB-F)
 *   - ephemeral — closing the tab clears it; we never want a 2-day-old
 *     "previous path" surfacing on a fresh session
 *
 * Why scoped by tenant slug:
 *   - leaving a tenant clears it (OB-E); a tenant-A page never appears as
 *     the back destination on a tenant-B view
 */
import { useEffect, useState } from 'react';
import { uiStorageKey } from '@/lib/ui-storage';

// Trailing ':' kept: callers append the route segment themselves.
export const PREV_PATH_KEY_PREFIX = `${uiStorageKey('nav', 'prev')}:`;

export function prevPathStorageKey(tenantSlug: string): string {
    return `${PREV_PATH_KEY_PREFIX}${tenantSlug}`;
}

/**
 * Extract the tenant slug from a tenant-scoped pathname, or `null` if the
 * path doesn't start with `/t/<slug>/`.
 */
export function tenantSlugFromPath(pathname: string): string | null {
    const match = pathname.match(/^\/t\/([^/]+)/);
    return match ? match[1] : null;
}

/**
 * Read the previously-visited in-tenant pathname for the given tenant.
 * Returns `null` when running on the server, when no path is stored, or
 * when sessionStorage is unavailable (private mode, quota errors).
 */
export function readPreviousPath(tenantSlug: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage.getItem(prevPathStorageKey(tenantSlug));
    } catch {
        return null;
    }
}

/**
 * Write the current pathname into the previous-path slot for the given
 * tenant. Silent on quota or DOM errors — referrer tracking is best-effort
 * and never throws into the render path.
 */
export function writePreviousPath(tenantSlug: string, pathname: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.setItem(prevPathStorageKey(tenantSlug), pathname);
    } catch {
        /* best-effort */
    }
}

/**
 * Clear the previous-path slot for the given tenant. Called on cross-
 * tenant transitions (OB-E) to prevent tenant-A paths from leaking into
 * tenant-B's back affordance.
 */
export function clearPreviousPath(tenantSlug: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.removeItem(prevPathStorageKey(tenantSlug));
    } catch {
        /* best-effort */
    }
}

/**
 * Hook used by `<BackAffordance>` to read the previous in-tenant pathname.
 * Re-reads on mount and whenever `tenantSlug` changes. The
 * `<NavigationTracker>` component is responsible for KEEPING the value
 * current — this hook only reads.
 */
export function usePreviousPath(tenantSlug: string | null): string | null {
    const [prev, setPrev] = useState<string | null>(null);

    useEffect(() => {
        if (!tenantSlug) {
            setPrev(null);
            return;
        }
        setPrev(readPreviousPath(tenantSlug));
    }, [tenantSlug]);

    return prev;
}
