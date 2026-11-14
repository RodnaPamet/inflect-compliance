/**
 * Version History — Explicit, auditable version tracking for framework libraries.
 *
 * Tracks the history of framework library versions as they are imported,
 * enabling the rule-of-three migration strategy to make decisions based
 * on whether a change has been stable across multiple consecutive versions.
 *
 * Design Principles:
 * ──────────────────
 * 1. **Explicit, not inferred** — History is written on import, never reconstructed.
 * 2. **Auditable** — Every entry has a timestamp, content hash, and snapshot of codes.
 * 3. **Append-only** — New entries are appended. Old entries are never modified.
 * 4. **Pure-logic queries** — History analysis is side-effect-free and unit-testable.
 *
 * Storage:
 * ────────
 * Version history is stored as a JSON array in the Framework model's `metadataJson` field,
 * under the `versionHistory` key. This avoids a new Prisma migration while keeping the
 * data colocated with the framework record.
 *
 * Schema of a single history entry:
 * ```json
 * {
 *   "version": 2,
 *   "contentHash": "sha256...",
 *   "importedAt": "2026-04-15T21:00:00.000Z",
 *   "requirementCodes": ["A.5.1", "A.5.2", ...],
 *   "addedCodes": ["A.5.3"],
 *   "removedCodes": ["A.5.99"],
 *   "changedCodes": ["A.5.1"]
 * }
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────

/** A single version history entry, stored per framework. */
export interface VersionHistoryEntry {
    /** Library version number at import time */
    version: number;
    /** Content hash at import time */
    contentHash: string;
    /** ISO 8601 timestamp of when this version was imported */
    importedAt: string;
    /** All requirement codes present in this version */
    requirementCodes: string[];
    /** Codes that were added in this version (relative to previous) */
    addedCodes: string[];
    /** Codes that were removed in this version (relative to previous) */
    removedCodes: string[];
    /** Codes that were changed (title/desc/category) in this version */
    changedCodes: string[];
}

/** The full version history for a framework, stored in metadataJson. */
export interface FrameworkVersionHistory {
    /** Ordered list of version entries (oldest first) */
    entries: VersionHistoryEntry[];
}

// ─── History Construction ────────────────────────────────────────────

/**
 * Create a new version history entry from import results.
 */
export function createHistoryEntry(params: {
    version: number;
    contentHash: string;
    requirementCodes: string[];
    addedCodes: string[];
    removedCodes: string[];
    changedCodes: string[];
}): VersionHistoryEntry {
    return {
        version: params.version,
        contentHash: params.contentHash,
        importedAt: new Date().toISOString(),
        requirementCodes: [...params.requirementCodes].sort(),
        addedCodes: [...params.addedCodes].sort(),
        removedCodes: [...params.removedCodes].sort(),
        changedCodes: [...params.changedCodes].sort(),
    };
}

/**
 * Append a new entry to an existing version history.
 * Returns a new history object (immutable).
 */
export function appendHistoryEntry(
    history: FrameworkVersionHistory,
    entry: VersionHistoryEntry,
): FrameworkVersionHistory {
    return {
        entries: [...history.entries, entry],
    };
}

/**
 * Create an empty version history.
 */
export function emptyHistory(): FrameworkVersionHistory {
    return { entries: [] };
}

// ─── History Queries ─────────────────────────────────────────────────

/**
 * Get the latest N history entries (most recent first).
 */
export function getRecentEntries(
    history: FrameworkVersionHistory,
    count: number,
): VersionHistoryEntry[] {
    return history.entries.slice(-count).reverse();
}

/**
 * Get the entry for a specific version number.
 */
export function getEntryByVersion(
    history: FrameworkVersionHistory,
    version: number,
): VersionHistoryEntry | undefined {
    return history.entries.find(e => e.version === version);
}

/**
 * Get the most recent entry.
 */
export function getLatestEntry(
    history: FrameworkVersionHistory,
): VersionHistoryEntry | undefined {
    return history.entries.length > 0
        ? history.entries[history.entries.length - 1]
        : undefined;
}

// ─── Rule-of-Three Analysis ─────────────────────────────────────────

/**
 * Determine which codes have been consistently absent for N consecutive versions.
 *
 * A code is "stably removed" if it was removed (appears in `removedCodes`)
 * in a past version and has NOT reappeared in any subsequent version's
 * `requirementCodes` for at least `threshold` consecutive versions.
 *
 * This is the core analysis function for the rule-of-three strategy.
 *
 * @param history - Full version history for the framework
 * @param threshold - Number of consecutive versions a removal must be stable for (default: 3)
 * @returns Set of requirement codes that are stably removed
 */
export function getStablyRemovedCodes(
    history: FrameworkVersionHistory,
    threshold: number = 3,
): Set<string> {
    if (history.entries.length < threshold) {
        // Not enough history to determine stability
        return new Set();
    }

    // Look at the most recent `threshold` entries
    const recentEntries = history.entries.slice(-threshold);

    // A code is "stably removed" if:
    // 1. It does NOT appear in any of the recent entries' requirementCodes
    // 2. It WAS removed at some point before (or in the first of) the window

    // Collect all codes that were ever removed across the entire history
    const everRemoved = new Set<string>();
    for (const entry of history.entries) {
        for (const code of entry.removedCodes) {
            everRemoved.add(code);
        }
    }

    // Filter to codes that are absent from ALL recent entries
    const stablyRemoved = new Set<string>();
    for (const code of everRemoved) {
        const absentFromAll = recentEntries.every(
            entry => !entry.requirementCodes.includes(code)
        );
        if (absentFromAll) {
            stablyRemoved.add(code);
        }
    }

    return stablyRemoved;
}

/**
 * Determine which codes have been consistently added for N consecutive versions.
 *
 * A code is "stably added" if it has appeared in `requirementCodes` for at
 * least `threshold` consecutive recent versions. This indicates it is not
 * a draft or experimental addition.
 *
 * @param history - Full version history for the framework
 * @param codes - Codes to check for stability
 * @param threshold - Number of consecutive versions (default: 3)
 * @returns Set of codes that are stably present
 */
export function getStablyAddedCodes(
    history: FrameworkVersionHistory,
    codes: string[],
    threshold: number = 3,
): Set<string> {
    if (history.entries.length < threshold) {
        return new Set();
    }

    const recentEntries = history.entries.slice(-threshold);
    const stably = new Set<string>();

    for (const code of codes) {
        const presentInAll = recentEntries.every(
            entry => entry.requirementCodes.includes(code)
        );
        if (presentInAll) {
            stably.add(code);
        }
    }

    return stably;
}

/**
 * Determine which changes have been consistent across N consecutive versions.
 *
 * A code is "stably changed" if it has appeared in `changedCodes` in the
 * version it was LAST changed and has not changed again in at least
 * `threshold` following versions — `threshold` versions AFTER the change,
 * not counting the change itself. With the default 3, a text change first
 * reaches tenants once three later library versions have left it alone.
 *
 * This said `threshold - 1` until #5305; the code and its tests
 * (`version-history.test.ts`: a change followed by only two quiet versions is
 * NOT stable) have always required `threshold`, and the docblock was corrected
 * to them rather than the release timing changed.
 */
export function getStablyChangedCodes(
    history: FrameworkVersionHistory,
    changedCodes: string[],
    threshold: number = 3,
): Set<string> {
    if (history.entries.length < threshold) {
        return new Set();
    }

    const stably = new Set<string>();

    for (const code of changedCodes) {
        // Find the earliest entry where this code was last changed
        let lastChangedIndex = -1;
        for (let i = history.entries.length - 1; i >= 0; i--) {
            if (history.entries[i].changedCodes.includes(code)) {
                lastChangedIndex = i;
                break;
            }
        }

        if (lastChangedIndex === -1) continue;

        // Check: has this code been stable (not changed again) for threshold entries after?
        // Count only entries AFTER the change entry (exclusive of the change itself)
        const entriesAfterChange = history.entries.length - lastChangedIndex - 1;
        if (entriesAfterChange >= threshold) {
            // Verify no further changes in subsequent entries
            const subsequentEntries = history.entries.slice(lastChangedIndex + 1);
            const changedAgain = subsequentEntries.some(
                entry => entry.changedCodes.includes(code)
            );
            if (!changedAgain) {
                stably.add(code);
            }
        }
    }

    return stably;
}

// ─── Metadata JSON Serialization ─────────────────────────────────────

/**
 * Extract version history from a framework's metadataJson string.
 * Returns an empty history if parsing fails or data is missing.
 */
export function parseHistoryFromMetadata(metadataJson: string | null | undefined): FrameworkVersionHistory {
    if (!metadataJson) return emptyHistory();

    try {
        const metadata = JSON.parse(metadataJson);
        if (metadata.versionHistory && Array.isArray(metadata.versionHistory.entries)) {
            return metadata.versionHistory as FrameworkVersionHistory;
        }
    } catch {
        // Corrupt metadata — return empty history rather than crash
    }

    return emptyHistory();
}

/**
 * Merge version history into an existing metadataJson string.
 * Preserves all existing metadata fields.
 */
export function mergeHistoryIntoMetadata(
    metadataJson: string | null | undefined,
    history: FrameworkVersionHistory,
): string {
    let metadata: Record<string, unknown> = {};

    if (metadataJson) {
        try {
            metadata = JSON.parse(metadataJson);
        } catch {
            // Start fresh if metadata is corrupt
        }
    }

    metadata.versionHistory = history;
    return JSON.stringify(metadata);
}
