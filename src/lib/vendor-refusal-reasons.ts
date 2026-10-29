/**
 * The named reasons a vendor write is refused with, in `error.details.reason`
 * (#4462).
 *
 * Client-safe: no server imports, so the vendor pages can read a refusal and
 * show their own sentence for it.
 */

/**
 * The write would make the vendor ACTIVE without a completed assessment review
 * carrying a risk rating — the bar every route to ACTIVE applies, creation
 * included. A new vendor has no assessment, so it can never be created ACTIVE.
 */
export const VENDOR_ACTIVATION_NEEDS_REVIEW = 'VENDOR_ACTIVATION_NEEDS_REVIEW' as const;
