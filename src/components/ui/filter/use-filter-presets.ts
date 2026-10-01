'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 53 — React bridge for filter presets.
 *
 * Wraps the pure CRUD module (`src/lib/filters/filter-presets.ts`)
 * with React state so the FilterToolbar preset dropdown re-renders
 * whenever the stored list changes. All the actual persistence
 * happens in the lib layer; this hook is purely a view adapter.
 */

import { useCallback, useEffect, useState } from 'react';
import { presetsStorageKey,
    clearPresets as clearPresetsLib,
    deletePreset as deletePresetLib,
    listPresets,
    renamePreset as renamePresetLib,
    savePreset as savePresetLib,
    type FilterPreset,
} from '@/lib/filters/filter-presets';
import type { FilterState } from './filter-state';

export interface UseFilterPresetsOptions {
    tenantSlug: string;
    page: string;
}

export interface UseFilterPresetsResult {
    presets: FilterPreset[];
    savePreset: (name: string, state: FilterState) => FilterPreset | null;
    deletePreset: (id: string) => void;
    renamePreset: (id: string, name: string) => FilterPreset | null;
    clearAll: () => void;
    /** Force a re-read — useful after a non-React mutation in the same tab. */
    refresh: () => void;
}

export function useFilterPresets(
    options: UseFilterPresetsOptions,
): UseFilterPresetsResult {
    const { tenantSlug, page } = options;
    const [presets, setPresets] = useState<FilterPreset[]>([]);

    const refresh = useCallback(() => {
        setPresets(listPresets(tenantSlug, page));
    }, [tenantSlug, page]);

    // Load once on mount (and again whenever the tenant / page scope
    // shifts, e.g. when the user switches between tenants).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
    }, [refresh]);

    // Listen for `storage` events so presets saved in another tab show
    // up immediately without a manual refresh.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onStorage = (e: StorageEvent) => {
            if (e.key && e.key === presetsStorageKey(tenantSlug, page)) {
                refresh();
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [tenantSlug, page, refresh]);

    const savePreset = useCallback(
        (name: string, state: FilterState): FilterPreset | null => {
            try {
                const saved = savePresetLib({ tenantSlug, page, name, state });
                refresh();
                return saved;
            } catch {
                return null;
            }
        },
        [tenantSlug, page, refresh],
    );

    const deletePreset = useCallback(
        (id: string) => {
            deletePresetLib(tenantSlug, page, id);
            refresh();
        },
        [tenantSlug, page, refresh],
    );

    const renamePreset = useCallback(
        (id: string, name: string): FilterPreset | null => {
            try {
                const updated = renamePresetLib(tenantSlug, page, id, name);
                if (updated) refresh();
                return updated;
            } catch {
                return null;
            }
        },
        [tenantSlug, page, refresh],
    );

    const clearAll = useCallback(() => {
        clearPresetsLib(tenantSlug, page);
        refresh();
    }, [tenantSlug, page, refresh]);

    return { presets, savePreset, deletePreset, renamePreset, clearAll, refresh };
}
