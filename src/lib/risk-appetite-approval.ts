/**
 * The refusal an approval of the risk appetite gets when what is stored is no
 * longer what the approver was shown (#5313 item 11, owner decision
 * 2026-11-15).
 *
 * `POST …/risk-appetite/approve` carries the row's id and its `updatedAt` as
 * the page loaded them, and the stamp is one conditional write naming both. A
 * save in between moves `updatedAt`, so the write matches nothing and the
 * usecase refuses with a 409 carrying this reason in `error.details.reason`.
 * The page words it in the reader's language and re-reads the appetite.
 *
 * Client-safe: no server imports, so the admin page can read the reason.
 */
export const RISK_APPETITE_CHANGED_SINCE_VIEWED = 'RISK_APPETITE_CHANGED_SINCE_VIEWED' as const;

/** True when a parsed API error body is the changed-since-viewed refusal. */
export function isAppetiteChangedSinceViewed(body: unknown): boolean {
    const details = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details;
    return details?.reason === RISK_APPETITE_CHANGED_SINCE_VIEWED;
}
