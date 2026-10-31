/**
 * The named refusals the auditor list can get (#4730).
 *
 * Each travels in `error.details.reason`, beside an English `error.message`.
 * The auditor management page words a known reason from
 * `audits.auditorsAdmin.refused.<reason>` and shows the server's message for
 * anything else, so a refusal reaches the person as what it is, rather than
 * as "please try again" for an attempt that would fail the same way.
 *
 * Client-safe: no server imports, so the page can read the reasons.
 */

export const AUDITOR_REFUSALS = [
    /** The auditor id names no auditor on this workspace's list. */
    'AUDITOR_NOT_FOUND',
    /** Revoke asked of an auditor who is already revoked. */
    'AUDITOR_ALREADY_REVOKED',
    /** A pack is recorded only against an auditor who is on the list. */
    'AUDITOR_REVOKED',
    /** The pack id names no pack in this workspace (or it was deleted). */
    'AUDITOR_PACK_NOT_FOUND',
    /** The pack is already recorded against this auditor. */
    'AUDITOR_PACK_ALREADY_RECORDED',
    /** A draft pack cannot be shared, so it is not recorded against anybody. */
    'AUDITOR_PACK_DRAFT',
] as const;

export type AuditorRefusal = (typeof AUDITOR_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(AUDITOR_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function auditorRefusal(body: unknown): AuditorRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as AuditorRefusal) : null;
}
