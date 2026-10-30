/**
 * The named reasons a vendor write is refused with, in `error.details.reason`
 * (#4462).
 *
 * Client-safe: no server imports, so the vendor pages can read a refusal and
 * show their own sentence for it.
 */

/**
 * Another LIVE vendor already has this name.
 *
 * Vendor names are unique among live vendors only:
 * `Vendor_tenantId_name_live_key` is a partial unique index (`WHERE
 * "deletedAt" IS NULL`), so a deleted vendor's name is free again. Left to the
 * index, a clash arrived as Prisma's P2002, which the API answers with the
 * generic "A resource with that unique constraint already exists" — it does
 * not say the name is the problem. `createVendor` and a rename in
 * `updateVendor` check first and refuse with this reason.
 */
export const VENDOR_NAME_TAKEN = 'VENDOR_NAME_TAKEN' as const;

/**
 * The write would make the vendor ACTIVE without a completed assessment review
 * carrying a risk rating — the bar every route to ACTIVE applies, creation
 * included. A new vendor has no assessment, so it can never be created ACTIVE.
 */
export const VENDOR_ACTIVATION_NEEDS_REVIEW = 'VENDOR_ACTIVATION_NEEDS_REVIEW' as const;

function reasonOf(body: unknown): unknown {
    return (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details
        ?.reason;
}

/** True when a parsed API error body is the vendor-name refusal. */
export function isVendorNameTaken(body: unknown): boolean {
    return reasonOf(body) === VENDOR_NAME_TAKEN;
}

/** True when a parsed API error body is the activation refusal. */
export function isVendorActivationNeedsReview(body: unknown): boolean {
    return reasonOf(body) === VENDOR_ACTIVATION_NEEDS_REVIEW;
}
