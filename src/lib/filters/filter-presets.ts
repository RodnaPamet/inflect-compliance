/**
 * Epic 53 — filter presets (saved views).
 *
 * Pure CRUD layer over localStorage-backed filter presets. Presets
 * are scoped per-tenant + per-page so an admin's "My open risks" view
 * for Acme doesn't leak into their Beta tenant's Risks page.
 *
 * UI integration lives in a small `useFilterPresets` hook + a preset
 * dropdown plugged into `FilterToolbar`. This module stays free of
 * React so it can be unit-tested in the node project.
 *
 * Storage shape (per page + tenant):
 *   inflect:filters:{tenantSlug}:{page} → JSON-encoded FilterPreset[]
 *
 * Only the `state` shape — a `Record<string, string[]>` — is persisted
 * (plus the name + metadata). We deliberately do NOT persist search
 * text: presets are about saved filter combinations, not saved
 * searches, and search terms age poorly.
 */

import type { FilterState } from '@/components/ui/filter/filter-state';
import { uiStorageKey } from '@/lib/ui-storage';

export interface FilterPreset {
    /** Stable id — generated once at creation. */
    id: string;
    /** Human-readable name, surfaced in the preset dropdown. */
    name: string;
    /** The filter state to apply when this preset is selected. */
    state: FilterState;
    /** ISO timestamp — used only for ordering and audit trails. */
    createdAt: string;
}

const MAX_NAME_LENGTH = 64;
const MAX_PRESETS_PER_PAGE = 20;

/**
 * The key one page's presets live under.
 *
 * EXPORTED so the `storage`-event listener in `use-filter-presets` compares
 * against this rather than rebuilding the literal — a reader that spells the key
 * itself is free to disagree with the writer, which is the drift
 * `ThemeProvider`'s cookie regex demonstrated.
 */
export function presetsStorageKey(tenantSlug: string, page: string): string {
    return uiStorageKey('filters', tenantSlug, page);
}

const storageKey = presetsStorageKey;

function getStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        // Private-mode Safari / sandboxed iframes.
        return null;
    }
}

/**
 * Hydrate a FilterState that crossed the JSON boundary — trimming
 * non-array values, coercing strings, and stripping empty keys.
 * Prevents a corrupt localStorage entry from poisoning the UI.
 */
function sanitiseState(raw: unknown): FilterState {
    if (!raw || typeof raw !== 'object') return {};
    const out: FilterState = {};
    for (const [key, values] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue;
        const clean = values.filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (clean.length > 0) out[key] = clean;
    }
    return out;
}

function sanitisePreset(raw: unknown): FilterPreset | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<FilterPreset>;
    if (typeof r.id !== 'string' || !r.id) return null;
    if (typeof r.name !== 'string' || !r.name) return null;
    if (typeof r.createdAt !== 'string') return null;
    const state = sanitiseState(r.state);
    return {
        id: r.id,
        name: r.name.slice(0, MAX_NAME_LENGTH),
        createdAt: r.createdAt,
        state,
    };
}

/**
 * Read all presets for a page. Corrupt or malformed entries are
 * silently filtered out so a single bad write never breaks the UI.
 */
export function listPresets(tenantSlug: string, page: string): FilterPreset[] {
    const storage = getStorage();
    if (!storage) return [];
    const raw = storage.getItem(storageKey(tenantSlug, page));
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
        .map(sanitisePreset)
        .filter((p): p is FilterPreset => p !== null);
}

function writePresets(
    tenantSlug: string,
    page: string,
    presets: FilterPreset[],
): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        storage.setItem(storageKey(tenantSlug, page), JSON.stringify(presets));
    } catch {
        // Quota exceeded / private mode — best-effort. The caller is a
        // UI side-effect that will gracefully degrade.
    }
}

export interface SavePresetInput {
    tenantSlug: string;
    page: string;
    name: string;
    state: FilterState;
}

/**
 * Persist a new preset. Returns the saved record (with generated id +
 * timestamp). Caps at `MAX_PRESETS_PER_PAGE` — oldest preset is
 * discarded when the cap is exceeded so the dropdown stays scannable.
 */
export function savePreset(input: SavePresetInput): FilterPreset {
    const trimmedName = input.name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmedName) {
        throw new Error('Preset name is required.');
    }
    const preset: FilterPreset = {
        id: makeId(),
        name: trimmedName,
        createdAt: new Date().toISOString(),
        state: sanitiseState(input.state),
    };
    const existing = listPresets(input.tenantSlug, input.page);
    const next = [preset, ...existing].slice(0, MAX_PRESETS_PER_PAGE);
    writePresets(input.tenantSlug, input.page, next);
    return preset;
}

/**
 * Delete a preset by id. No-op if the id is not found — matches the
 * "idempotent delete" convention of the rest of the filter stack.
 */
export function deletePreset(
    tenantSlug: string,
    page: string,
    presetId: string,
): void {
    const existing = listPresets(tenantSlug, page);
    const next = existing.filter((p) => p.id !== presetId);
    if (next.length !== existing.length) {
        writePresets(tenantSlug, page, next);
    }
}

/**
 * Rename a preset in place. Returns the updated record or `null` if
 * the id was not found. Empty-after-trim names are rejected to keep
 * the dropdown rows scannable.
 */
export function renamePreset(
    tenantSlug: string,
    page: string,
    presetId: string,
    name: string,
): FilterPreset | null {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) throw new Error('Preset name is required.');
    const existing = listPresets(tenantSlug, page);
    let updated: FilterPreset | null = null;
    const next = existing.map((p) => {
        if (p.id !== presetId) return p;
        updated = { ...p, name: trimmed };
        return updated;
    });
    if (updated) writePresets(tenantSlug, page, next);
    return updated;
}

/**
 * Drop every preset for the given tenant + page. Used by the "Clear
 * all saved views" affordance and the tenant-offboarding cleanup.
 */
export function clearPresets(tenantSlug: string, page: string): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        storage.removeItem(storageKey(tenantSlug, page));
    } catch {
        /* ignore */
    }
}

function makeId(): string {
    // `crypto.randomUUID()` is available in every supported browser
    // and on the Node 18+ runtime; fall back to a timestamp + random
    // suffix for the (edge) case where it's absent.
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return crypto.randomUUID();
    }
    return `p-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

/** Exposed for tests — keeps the cap discoverable without re-deriving. */
export const PRESET_LIMITS = {
    MAX_NAME_LENGTH,
    MAX_PRESETS_PER_PAGE,
} as const;
