/**
 * WHAT INTERNAL AUDIT ANSWERS A SAMPLED WORKPAPER IN (#3677, step 3d) — the
 * answers, the stable dissent codes, and the refusal reasons.
 *
 * No server imports, so the review page's form holds the same list the
 * server validates against and the database CHECK pins. The sampling rules
 * that need `node:crypto` stay in `workpaper-review-sampling.ts`, which
 * re-exports these.
 */

/**
 * Why internal audit does not concur with a workpaper, as stable codes.
 *
 * CODES AND NOT FREE TEXT. The subject is a workpaper about named people's
 * access; a note field is the obvious place to quote a unit, and a quote in a
 * plaintext column is the content leaving the record it was put in. Codes also
 * make the rate decomposable — "which part of the re-performance did not hold"
 * is the question that changes the procedure or the agent.
 *
 * Stable: they are written into a hash-chained audit row, into a finding
 * proposal and into a CHECK. Append to this list (with a migration that widens
 * the CHECK); never repurpose or remove a member. Each names one part of what a
 * workpaper records (docs/agentic-audit-procedures.md, "What a workpaper
 * records").
 */
export const WORKPAPER_REVIEW_DISSENT_CODES = [
    /** The population is not the one the catalogue defines for the procedure and period. */
    'POPULATION_NOT_AS_DEFINED',
    /** The sample cannot be re-derived from its epoch, seed and population. */
    'SAMPLE_NOT_REPRODUCIBLE',
    /** An attribute the procedure requires was not tested. */
    'ATTRIBUTE_NOT_TESTED',
    /** A sampled unit's outcome does not hold on re-performance. */
    'ITEM_OUTCOME_WRONG',
    /** Re-performance finds an exception the workpaper does not record. */
    'EXCEPTION_MISSED',
    /** A recorded exception does not hold on re-performance. */
    'EXCEPTION_NOT_SUPPORTED',
    /** The parameters recorded are not the ones the plan set, or were misapplied. */
    'PARAMETERS_MISAPPLIED',
    /** The cited evidence does not support the recorded outcomes. */
    'EVIDENCE_INSUFFICIENT',
    /** The conclusion does not follow from the item outcomes. */
    'CONCLUSION_NOT_SUPPORTED',
] as const;
export type WorkpaperReviewDissentCode = (typeof WORKPAPER_REVIEW_DISSENT_CODES)[number];

/** The verdicts a reviewer may write. PENDING is the sweep's, never an answer. */
export const WORKPAPER_REVIEW_ANSWERS = ['CONCURRED', 'DISSENTED', 'INDETERMINATE'] as const;
export type WorkpaperReviewAnswer = (typeof WORKPAPER_REVIEW_ANSWERS)[number];

/**
 * Why a review answer (or the read that precedes it) is refused, carried as
 * `details.reason`. Who-may-answer refusals (not the assignee, not an ACTIVE
 * third-line member, the auditor's owner) are 403s with an `AUTHZ_DENIED` row;
 * state refusals are 409s; a malformed answer is a 400. A caller who is not a
 * person is a 403 with no reason.
 */
export type WorkpaperReviewRefusal =
    | 'NOT_ASSIGNED_REVIEWER'
    | 'REVIEWER_NOT_ACTIVE_MEMBER'
    | 'REVIEWER_LINE_NOT_THIRD'
    | 'REVIEWER_OWNS_AUDITOR'
    | 'AUDITOR_OWNER_UNKNOWN'
    | 'UNASSIGNED'
    | 'ALREADY_REVIEWED'
    | 'DISSENT_CODES_REQUIRED'
    | 'DISSENT_CODES_ONLY_ON_DISSENT';
