/**
 * Population coverage of a legacy access snapshot (#3325): the one reading that
 * every surface shares.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `status`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LegacyAccessSnapshot.status = COMPLETE` says OUR read was whole: every page
 * was read, every row keyed, every account stored. It cannot say the far end
 * handed us the whole APPLICATION. The operator's shim runs the query and the
 * manifest's `rowCount` is the shim's own claim, so a shim that can see one of
 * twelve workstations of a per-workstation desktop application produces a
 * manifest structurally identical to one that saw all twelve. A campaign over
 * that snapshot would attest that every account in scope was reviewed — true of
 * its rows, false of the application. Invariant 5 one level up.
 *
 * So coverage is a second fact, `LegacyAccessSnapshot.populationCoverage`,
 * UNKNOWN by SCHEMA default (owner decision, 2026-10-09). No transport writes
 * VERIFIED today, because none observes a whole table itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONLY THE LITERAL 'VERIFIED' IS VERIFIED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every reader narrows through {@link readPopulationCoverage}, which is an
 * ALLOWLIST: absent, null, a value from a later enum this build does not know,
 * and a subject frozen before the column existed all read UNKNOWN. That last
 * case is accurate rather than merely cautious — no snapshot taken before this
 * column was verified, because nothing could verify one.
 *
 * No server imports, so a client component can hold it.
 *
 * @module lib/legacy-access/coverage
 */

/** Every value `LegacyAccessSnapshot.populationCoverage` can hold, in declaration order. */
export const POPULATION_COVERAGES = ['UNKNOWN', 'VERIFIED'] as const;

export type PopulationCoverage = (typeof POPULATION_COVERAGES)[number];

/**
 * Narrow a stored or frozen value. VERIFIED only for the literal; everything
 * else, including absence, is UNKNOWN — the direction that cannot overclaim.
 */
export function readPopulationCoverage(value: unknown): PopulationCoverage {
    return value === 'VERIFIED' ? 'VERIFIED' : 'UNKNOWN';
}

/** The `provenance` object a LEGACY_APP subject's frozen `snapshotJson` carries, if any. */
function provenanceOf(snapshotJson: unknown): Record<string, unknown> | null {
    if (!snapshotJson || typeof snapshotJson !== 'object' || Array.isArray(snapshotJson)) return null;
    const p = (snapshotJson as Record<string, unknown>).provenance;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

/**
 * The coverage a LEGACY_APP campaign's FROZEN subjects carry.
 *
 * Read off the subjects rather than the snapshot row, for the reason the rest of
 * the provenance is: the subjects were frozen at create, and re-reading the
 * snapshot later would reintroduce the drift the freeze removed.
 *
 * VERIFIED only when there is at least one subject AND every subject says so.
 * Every subject of one campaign is written from one snapshot, so they agree in
 * practice; "every" rather than "the first" means a subject that does not say
 * VERIFIED — malformed, or frozen before the column existed — is enough to keep
 * the campaign from claiming a whole population. And zero subjects is UNKNOWN:
 * `[].every(...)` is true, which is exactly the vacuous claim invariant 5 exists
 * to refuse, so the emptiness check sits in the same expression.
 */
export function frozenCampaignCoverage(snapshotJsons: readonly unknown[]): PopulationCoverage {
    const verified =
        snapshotJsons.length > 0
        && snapshotJsons.every(
            (s) => readPopulationCoverage(provenanceOf(s)?.populationCoverage) === 'VERIFIED'
        );
    return verified ? 'VERIFIED' : 'UNKNOWN';
}
