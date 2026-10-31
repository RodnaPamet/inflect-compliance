/**
 * The named refusals an audit pack action can get (#4700).
 *
 * Each travels in `error.details.reason`, beside an English `error.message`.
 * The pack detail page maps a known reason to its own translated sentence
 * (`audits.packs.refused.<reason>`) and falls back to the server's message
 * for anything else, so a Bulgarian user is not shown English for a refusal
 * the page can name.
 *
 * Client-safe: no server imports, so the page can read the reasons.
 */

export const AUDIT_PACK_REFUSALS = [
    /** The pack id names no pack in this workspace (or it was deleted). */
    'PACK_NOT_FOUND',
    /** Items can be added, edited or removed only while the pack is a draft. */
    'PACK_NOT_DRAFT',
    /** Freeze asked of a pack that is already frozen or exported. */
    'PACK_ALREADY_FROZEN',
    /** Freeze asked of a pack with no items. */
    'PACK_EMPTY',
    /** A share link is made only for a frozen pack. */
    'PACK_DRAFT_NOT_SHAREABLE',
    /** A retest copy is made only from a frozen pack. */
    'PACK_DRAFT_NOT_CLONEABLE',
    /** Remove asked for an item that is no longer in the pack. */
    'PACK_ITEM_NOT_FOUND',
    /** Add asked for a control, policy or piece of evidence this workspace does not hold. */
    'PACK_ITEM_REF_INVALID',
    /** Revoke asked for a share link this pack does not have. */
    'SHARE_NOT_FOUND',
    /** Revoke asked for a share link that is already revoked. */
    'SHARE_ALREADY_REVOKED',
    /** The auditor's entry is no longer on this pack. */
    'ENTRY_NOT_FOUND',
    /** A plain comment has nothing to resolve. */
    'ENTRY_NOT_RESOLVABLE',
    /** Resolve asked of an entry that is already resolved. */
    'ENTRY_ALREADY_RESOLVED',
    /** Only a finding or an evidence request becomes a finding. */
    'ENTRY_NOT_MATERIALISABLE',
    /** The entry was resolved by a finding creation that did not complete. */
    'ENTRY_RESOLVED_WITHOUT_FINDING',
    /** Another reviewer is creating the finding from this entry right now. */
    'ENTRY_BEING_MATERIALISED',
] as const;

export type AuditPackRefusal = (typeof AUDIT_PACK_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(AUDIT_PACK_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function auditPackRefusal(body: unknown): AuditPackRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as AuditPackRefusal) : null;
}
