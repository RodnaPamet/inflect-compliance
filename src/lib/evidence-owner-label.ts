/**
 * The one place that decides what "owner" means for a piece of evidence.
 *
 * `Evidence` carries TWO owner columns:
 *
 *   - `owner`       — legacy free text. Still written by the create-from-text
 *                     modal, and the only owner a pre-FK row has.
 *   - `ownerUserId` — the real user FK, written by the edit modal's owner
 *                     picker and the bulk "Assign owner" action, and used for
 *                     due-item routing, notifications and segregation of
 *                     duties.
 *
 * Every read path rendered the legacy column, and no read path joined the
 * user — so `ownerUserId` was effectively write-only from the UI's point of
 * view. Assigning an owner through either of the two surfaces that write the
 * FK appeared to do nothing, while creating evidence from text filled the
 * column that *is* displayed. Create wrote the visible one, edit wrote the
 * invisible one.
 *
 * Resolution order is deliberate: an assigned USER is a decision someone
 * made through a picker, backed by a membership check. The free-text column
 * is whatever was typed, so it is the fallback, not the answer.
 */
export interface EvidenceOwnerFields {
    owner?: string | null;
    ownerUser?: { name?: string | null; email?: string | null } | null;
}

export function ownerLabel(ev: EvidenceOwnerFields): string {
    const user = ev.ownerUser;
    // A User row can have a null `name` (OAuth accounts that never set one),
    // so fall through to the email rather than rendering an empty cell for a
    // row that genuinely has an owner.
    const assigned = user?.name?.trim() || user?.email?.trim();
    if (assigned) return assigned;
    return ev.owner?.trim() || '';
}
