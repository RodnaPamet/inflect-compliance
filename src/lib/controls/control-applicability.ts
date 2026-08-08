/**
 * Control applicability — the THREE-state model, and its one translation
 * into a database predicate.
 *
 * ## The fork this closes
 *
 * `Control.applicability` is a two-value Prisma enum (`APPLICABLE` /
 * `NOT_APPLICABLE`), but the product shows THREE states, because
 * "applicable" splits on whether anyone has actually decided:
 *
 *   - `NOT_APPLICABLE` — excluded from the Statement of Applicability.
 *   - `APPLICABLE`     — decided applicable (`applicabilityDecidedAt` set).
 *   - `UNASSESSED`     — applicable by default, never assessed.
 *
 * The Applicability COLUMN rendered the three states while the server
 * filtered the two-value column, so the Controls page stripped
 * `applicability` from the API query and re-filtered the loaded rows in the
 * browser. Two consequences:
 *
 *   1. The filter only saw the loaded page. Past the backfill cap, a
 *      matching control was silently missing — the filter read as "you have
 *      none" rather than "there are more".
 *   2. On a hard nav the SSR read DID pass the param through, so the same
 *      URL produced different rows depending on how you arrived at it.
 *
 * Both halves now come from this file: `applicabilityState` is what a cell
 * displays, `applicabilityStateWhere` is the predicate that selects exactly
 * those rows. `tests/unit/control-applicability.test.ts` runs both over the
 * same exhaustive row matrix, so a change to one that does not match the
 * other fails.
 *
 * Dependency-free on purpose (no `@/` imports, no Prisma import) so the
 * display half is safe in the browser bundle. The predicate is a plain
 * object literal that structurally satisfies `Prisma.ControlWhereInput`.
 */

/** The three states, in display order (N/A · Yes · Not assessed). */
export const APPLICABILITY_STATES = ['NOT_APPLICABLE', 'APPLICABLE', 'UNASSESSED'] as const;

export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];

/** The columns the derivation reads. Dates arrive as `Date` (server) or ISO string (wire). */
export interface ApplicabilityFields {
    applicability: string;
    /** Null when applicable-but-never-assessed — the distinction that makes three states. */
    applicabilityDecidedAt?: string | Date | null;
}

/** What the Applicability column displays for a row. */
export function applicabilityState(control: ApplicabilityFields): ApplicabilityState {
    if (control.applicability === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
    return control.applicabilityDecidedAt ? 'APPLICABLE' : 'UNASSESSED';
}

/** True when `value` is one of the three states. */
export function isApplicabilityState(value: string): value is ApplicabilityState {
    return (APPLICABILITY_STATES as readonly string[]).includes(value);
}

/**
 * The predicate for ONE state — the SQL twin of `applicabilityState`.
 *
 * Note `NOT_APPLICABLE` ignores `applicabilityDecidedAt` entirely, matching
 * the derivation's first branch: an N/A control is N/A whether or not the
 * decision was timestamped.
 */
function whereForState(state: ApplicabilityState) {
    switch (state) {
        case 'NOT_APPLICABLE':
            return { applicability: 'NOT_APPLICABLE' as const };
        case 'APPLICABLE':
            return {
                applicability: { not: 'NOT_APPLICABLE' as const },
                applicabilityDecidedAt: { not: null },
            };
        case 'UNASSESSED':
            return {
                applicability: { not: 'NOT_APPLICABLE' as const },
                applicabilityDecidedAt: null,
            };
    }
}

/**
 * Select the rows whose displayed state is one of `states`.
 *
 * Returns `undefined` for an empty selection (no restriction) and a bare
 * predicate for a single state, so the common case adds no `OR` node. A
 * multi-select becomes `{ OR: [...] }` — which the caller must nest under
 * `AND`, since the where clause already carries a tenant-scope `OR`.
 */
export function applicabilityStateWhere(states: readonly ApplicabilityState[]) {
    const unique = [...new Set(states)];
    if (unique.length === 0) return undefined;
    // All three selected is the same as no filter — skip the predicate rather
    // than emitting a three-branch OR the planner has to unpick.
    if (unique.length === APPLICABILITY_STATES.length) return undefined;
    if (unique.length === 1) return whereForState(unique[0]!);
    return { OR: unique.map(whereForState) };
}
