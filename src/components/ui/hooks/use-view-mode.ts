/**
 * Epic 66 — `useViewMode` hook.
 *
 * Page-level table-vs-cards preference, persisted per-page in
 * `localStorage` via the existing `useLocalStorage` primitive.
 * Pages that adopt the toggle do:
 *
 *   const [view, setView] = useViewMode('bookings', 'table');
 *   …
 *   <FilterToolbar
 *     actions={<ViewToggle view={view} onChange={setView} />}
 *   />
 *   {view === 'table' ? <DataTable … /> : <CardList … />}
 *
 * Storage key shape — `<app prefix>:view-mode:<page>`, built through
 * `uiStorageKey` — so the preference is per-page (different list
 * pages can each persist their own choice independently). The prefix
 * is whatever the host app's `uiStorageKey` seam supplies, which is
 * also what every other client-state key uses (column visibility,
 * command-palette recents, etc.), so a user clearing site data stays
 * consistent.
 *
 * SSR-safe via the underlying `useLocalStorage` (returns the
 * `initial` value on first render, hydrates inside a `useEffect`).
 */
import { useCallback } from 'react';

import { useLocalStorage } from '@inflect/ui/components/ui/hooks/use-local-storage';
import { uiStorageKey } from '@/lib/ui-storage';

export type ViewMode = 'table' | 'cards';

// Trailing ':' kept: callers append the page segment themselves.
const STORAGE_PREFIX = `${uiStorageKey('view-mode')}:`;

export function useViewMode(
    page: string,
    initial: ViewMode = 'table',
): [ViewMode, (next: ViewMode) => void] {
    const [stored, setStored] = useLocalStorage<ViewMode>(
        `${STORAGE_PREFIX}${page}`,
        initial,
    );

    // Defensive: a corrupted localStorage value (user edited
    // devtools, older shape) shouldn't yield a third bogus mode.
    // Coerce anything that isn't 'table' | 'cards' back to `initial`.
    const safe: ViewMode = stored === 'cards' ? 'cards' : 'table';

    const setView = useCallback(
        (next: ViewMode) => {
            // Same defensive narrowing — never persist a bogus mode.
            const clean: ViewMode = next === 'cards' ? 'cards' : 'table';
            setStored(clean);
        },
        [setStored],
    );

    return [safe, setView];
}

/**
 * Exposed so test helpers (and future "reset all preferences"
 * admin actions) can derive the same key without hard-coding the
 * prefix.
 */
export function viewModeStorageKey(page: string): string {
    return `${STORAGE_PREFIX}${page}`;
}
