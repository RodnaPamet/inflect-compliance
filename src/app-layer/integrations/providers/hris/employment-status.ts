/**
 * The employment-status derivation every HRIS provider shares.
 *
 * ONE owner for one rule: **dates beat the status string.** The status string
 * is the field an administrator customises per tenant — "Terminated (Pending)",
 * "Separated", "Alumni", "Notice" are all ordinary values somebody typed — while
 * the hire and termination dates are structured facts the vendor computes. When
 * the two disagree, the dates are the ones worth believing.
 *
 * The rule was established for Workday in #2012, after that mapper was found to
 * contradict its own docblock: it returned on `terminat` BEFORE looking at the
 * termination date, so a worker serving notice read TERMINATED a month before
 * their last day. BambooHR carried the same inversion, written independently and
 * left unfixed, which is the argument for this module existing at all — two
 * copies of a rule drift, and the third provider would have written a third.
 *
 * It matters in BOTH directions, and each direction is its own harm:
 *
 *   • string says terminated, date says future → OFFBOARDING. Calling this
 *     TERMINATED hands the JML leaver pass a person who is still employed and
 *     still coming to work, and it disables their account.
 *
 *   • string says active, date says past → TERMINATED. Calling this ACTIVE
 *     leaves a departed worker's directory access enabled indefinitely, which
 *     is the exact hole `offboarded_access_removed` exists to find. A tenant
 *     whose leaver status reads "Separated" matches no token here, so the
 *     string alone would never retire them.
 *
 * @module integrations/providers/hris/employment-status
 */

/** The normalised employment statuses, mirroring the `EmploymentStatus` enum. */
export type EmploymentStatusValue = 'ACTIVE' | 'ONBOARDING' | 'OFFBOARDING' | 'TERMINATED' | 'LEAVE';

/** What a provider extracts from its own row shape before the rule applies. */
export interface EmploymentSignals {
    /** The vendor's status text, whatever field it lives in. */
    statusText?: string | null;
    hireDate?: string | Date | null;
    terminationDate?: string | Date | null;
}

/**
 * Parse a vendor date, treating unparseable as absent.
 *
 * An unparseable date must fall THROUGH to the status string rather than being
 * compared: `new Date('not a date') > now` is false, so a naive comparison reads
 * a garbage termination date as "not in the future" and answers from the wrong
 * branch without anything looking wrong.
 *
 * Exported because the rosters need the same rule for `startDate`/`endDate`:
 * a bare `new Date(raw)` there stored an Invalid Date on the Employee row,
 * which Prisma refuses, and the whole roster write failed (#5199).
 */
export function parseVendorDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** A calendar date with no time: what all three HRIS vendors send. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a worker becomes a leaver, from their termination date (#5200).
 *
 * A date-only value names the LAST WORKING DAY, so the person is still
 * employed through all of it and becomes a leaver at 00:00 UTC on the
 * FOLLOWING day (owner decision, 2026-11-13; no tenant timezone). `new Date`
 * reads `2026-11-13` as midnight UTC at the START of that day, so comparing it
 * as it was marked a Californian TERMINATED at 16:00 the evening before their
 * last day, and the 05:00 UTC leaver pass disabled their account for the whole
 * of it. A value carrying a time is an instant the vendor chose and is used as
 * it is.
 */
export function leaverFrom(value: string | Date | null | undefined): Date | null {
    const end = parseVendorDate(value);
    if (!end) return null;
    if (typeof value === 'string' && DATE_ONLY.test(value.trim())) {
        return new Date(end.getTime() + ONE_DAY_MS);
    }
    return end;
}

/**
 * Derive the normalised status from a worker's dates, falling back to the
 * vendor's status string.
 *
 * Returns `null` when neither carried an opinion, so each provider can apply
 * its own vendor-specific last resort (Workday has `activeStatus`; BambooHR has
 * nothing, so `null` means ACTIVE there). `null` rather than a defaulted
 * 'ACTIVE' because "no signal" and "positively active" are different facts, and
 * only the provider knows which of its own fields could still speak.
 */
export function deriveEmploymentStatus(
    signals: EmploymentSignals,
    now: Date = new Date(),
): EmploymentStatusValue | null {
    // ── DATES FIRST. This ordering IS the rule. ──
    // Pending termination — still employed until the day AFTER their last
    // working day begins (#5200).
    const leaves = leaverFrom(signals.terminationDate);
    if (leaves) return leaves > now ? 'OFFBOARDING' : 'TERMINATED';

    // Pre-hire — start date in the future.
    const start = parseVendorDate(signals.hireDate);
    if (start && start > now) return 'ONBOARDING';

    // ── STATUS STRING SECOND, as the fallback it was meant to be. ──
    //
    // Deliberate consequence: a worker on leave who ALSO carries a termination
    // date resolves from the date (OFFBOARDING / TERMINATED) rather than LEAVE.
    // They are leaving; the date is the actionable fact, and for a future date
    // both answers mean "still employed, do not disable yet". Someone on leave
    // with no dates still resolves to LEAVE.
    const raw = String(signals.statusText ?? '').toLowerCase();
    if (raw.includes('terminat')) return 'TERMINATED';
    if (raw.includes('leave')) return 'LEAVE';
    if (raw.includes('pre-hire') || raw.includes('prehire') || raw.includes('onboard')) return 'ONBOARDING';

    return null;
}
