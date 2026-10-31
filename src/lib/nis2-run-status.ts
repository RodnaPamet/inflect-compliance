/**
 * Whether a NIS2 gap-assessment run still takes answers.
 *
 * A run's answers are its record: once it is COMPLETED or ARCHIVED they stay
 * as they were, and new answers go into a new run (the gap page's Re-run).
 * Both answer paths ask this, the delegated assignment answers and the
 * self-assessment page (#4734), so they cannot disagree about it.
 *
 * Client-safe: no imports, so the self-assessment step can show a finalised
 * run read-only.
 */
const FINALIZED_RUN_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'ARCHIVED']);

/** Unknown or missing counts as finalised: refuse rather than rewrite. */
export function isFinalizedNis2Run(status: string | null | undefined): boolean {
    return status == null || FINALIZED_RUN_STATUSES.has(status);
}
