/**
 * The bounded read under the internal checks (personnel, training, device).
 *
 * Each check reads its population with a cap, and used to read exactly the
 * cap: a tenant with more rows than that was judged on whichever rows came
 * back, so a terminated employee's live account past the cap let
 * `offboarded_access_removed` PASS (#5196). The read now takes one row past
 * the cap, so truncation is a fact the check holds, and a truncated read may
 * FAIL a control but never PASS one — the rule `identity/types.ts` states for
 * directory reads.
 */
import type { CheckResult } from '../types';

export const INTERNAL_CHECK_READ_CAP = 10_000;

/** The `take` that lets a read tell "exactly the cap" from "more than the cap". */
export const INTERNAL_CHECK_READ_TAKE = INTERNAL_CHECK_READ_CAP + 1;

/** Cuts a read back to the cap and says whether anything was left out. */
export function withinCap<T>(rows: T[]): { rows: T[]; truncated: boolean } {
    return rows.length > INTERNAL_CHECK_READ_CAP
        ? { rows: rows.slice(0, INTERNAL_CHECK_READ_CAP), truncated: true }
        : { rows, truncated: false };
}

/** A PASSED verdict over a truncated read becomes ERROR; every other verdict stands. */
export function refusePassOnTruncatedRead<R extends Pick<CheckResult, 'status' | 'summary' | 'details'>>(
    result: R,
    truncated: boolean,
    label: string,
): R & { errorMessage?: string } {
    if (!truncated || result.status !== 'PASSED') return result;
    return {
        ...result,
        status: 'ERROR',
        summary: `${label} check read more than ${INTERNAL_CHECK_READ_CAP.toLocaleString('en')} rows and cannot pass on part of the population.`,
        details: { ...result.details, truncated: true, readCap: INTERNAL_CHECK_READ_CAP },
        errorMessage: 'POPULATION_TRUNCATED',
    };
}
