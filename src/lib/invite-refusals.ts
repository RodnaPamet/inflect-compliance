/**
 * Why an invite could not be accepted (#4689).
 *
 * `redeemInvite` names each refusal in `error.details.reason`, beside an
 * English `error.message`. The invite page maps a known reason to its own
 * translated sentence (`invite.refused.<reason>`), and the sign-in result page
 * (`/invite/result`) derives the same reasons from the invite's stored state
 * when the redemption ran inside the sign-in callback, where no response
 * reaches the person.
 *
 * Client-safe: no server imports, so the accept button can read the reasons.
 */

export const INVITE_REFUSALS = [
    'INVITE_NOT_FOUND',
    'INVITE_REVOKED',
    'INVITE_EXPIRED',
    'INVITE_ALREADY_REDEEMED',
    'INVITE_EMAIL_MISMATCH',
    'INVITE_NOT_COMPLETED',
] as const;

export type InviteRefusal = (typeof INVITE_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(INVITE_REFUSALS);

export function isInviteRefusal(value: unknown): value is InviteRefusal {
    return typeof value === 'string' && KNOWN.has(value);
}

/** The named reason in a parsed API error body, or null when it names none of these. */
export function inviteRefusal(body: unknown): InviteRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return isInviteRefusal(reason) ? reason : null;
}
