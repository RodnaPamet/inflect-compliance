/**
 * EP-2 — shared Evidence enum → localized-label helpers.
 *
 * `EvidenceType` (FILE | LINK | TEXT | SCREENSHOT) and `EvidenceStatus`
 * (DRAFT | SUBMITTED | APPROVED | REJECTED | NEEDS_REVIEW +
 * PENDING_UPLOAD optimistic sentinel) were previously rendered raw in
 * several surfaces (the detail sheet printed `evidence.type` /
 * `evidence.status` verbatim, the gallery printed `row.status`). These
 * two resolvers centralise the enum → i18n mapping so table + sheet +
 * gallery all read the SAME localized label and no raw enum text ever
 * reaches the DOM.
 *
 * Both take a `useTranslations('evidence')` resolver. Values come from
 * the `typeLabels.*` / `statusLabels.*` message groups (en + bg 1:1).
 * A missing key falls back to the raw enum so an un-mapped future enum
 * member degrades to its identifier rather than a dotted key path.
 */

import type { StatusBadgeVariant } from '@/components/ui/status-badge';

type T = (key: string, values?: Record<string, string | number>) => string;

/**
 * `EvidenceStatus` → badge tone.
 *
 * The labels above were centralised; the TONE was not, and the two copies
 * drifted. `EvidenceClient`'s map carried `PENDING_UPLOAD: 'info'` and
 * `EvidenceDetailSheet`'s omitted it, falling through to `'neutral'` — so
 * the same row badged one way in the list and another in the sheet, at the
 * same moment, for the one status that only exists mid-upload and is
 * therefore the hardest to notice.
 *
 * PENDING_UPLOAD is the optimistic sentinel, not a persisted status: it
 * reads `info` because the row is in flight, not because anything is wrong.
 */
export const EVIDENCE_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    SUBMITTED: 'info',
    APPROVED: 'success',
    REJECTED: 'error',
    // EP-2 — the stale-review sweep flips rows into NEEDS_REVIEW; give it a
    // warning tone so it reads as "needs attention".
    NEEDS_REVIEW: 'warning',
    PENDING_UPLOAD: 'info',
};

/** Badge tone for a status, defaulting to neutral for an unmapped member. */
export function evidenceStatusVariant(status: string | null | undefined): StatusBadgeVariant {
    return EVIDENCE_STATUS_VARIANT[status ?? ''] ?? 'neutral';
}

/** Localized `EvidenceType` label (`t` = `useTranslations('evidence')`). */
export function evidenceTypeLabel(type: string | null | undefined, t: T): string {
    if (!type) return '';
    const key = `typeLabels.${type}`;
    const label = t(key);
    // next-intl returns the dotted key path for an unmapped key — fall
    // back to the raw enum member so the DOM never shows `typeLabels.X`.
    return label === key || label.endsWith(`.${type}`) ? type : label;
}

/** Localized `EvidenceStatus` label (`t` = `useTranslations('evidence')`). */
export function evidenceStatusLabel(status: string | null | undefined, t: T): string {
    if (!status) return '';
    const key = `statusLabels.${status}`;
    const label = t(key);
    return label === key || label.endsWith(`.${status}`) ? status : label;
}

/**
 * Localized `ReviewAction` label for the review-history timeline.
 * `ReviewAction` (SUBMITTED | APPROVED | REJECTED) shares its members
 * with `EvidenceStatus`, so the status-label group is the source of
 * truth — one translation, two consumers.
 */
export function evidenceReviewActionLabel(action: string | null | undefined, t: T): string {
    return evidenceStatusLabel(action, t);
}
