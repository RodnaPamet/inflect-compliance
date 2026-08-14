/**
 * Epic 53 — Evidence list page filter configuration.
 *
 * URL-synchronised filter defs backing the Evidence toolbar. Keys align 1:1
 * with `EvidenceQuerySchema`:
 *
 *   q          → free-text search (`useFilterContext`'s search slot)
 *   type       → EvidenceType (FILE | LINK | TEXT)
 *   status     → EvidenceStatus (DRAFT | SUBMITTED | APPROVED | REJECTED)
 *   controlId  → entity-reference (Control ID; options derived from loaded data)
 *   tab        → retention bucket (active | expiring | archived)
 *
 * The retention bucket USED to sit outside this module, on the theory that a
 * "view of the data" (a tab strip) is a different kind of thing from "filters
 * on the view". That separation stopped paying rent once the bucket became a
 * server-side predicate like every other filter (`evidenceRetentionTabWhere`):
 * it was a second, parallel filtering mechanism with its own URL writer, its
 * own UI primitive, and no pill in the filter bar — so an active retention
 * bucket was invisible to "Clear all" and to the filter count. It is a normal
 * single-select category now, and `?tab=` deep links keep working because the
 * FilterProvider serialises a `tab` key to exactly that param.
 */

import type {
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { FileText, CircleDot, Link2, FolderOpen, Clock, Tag, Archive } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('evidence')`). */
type T = (key: string, values?: Record<string, string | number | Date>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// ─── Labels (resolved at render) ─────────────────────────────────────

// EvidenceType enum → label. Values are the enum members (unchanged).
export function evidenceTypeLabels(t: T): Record<string, string> {
    return {
        FILE: t('filterEnums.type.file'),
        LINK: t('filterEnums.type.link'),
        TEXT: t('filterEnums.type.text'),
    };
}

// EvidenceStatus enum → label.
export function evidenceStatusLabels(t: T): Record<string, string> {
    return {
        DRAFT: t('filterEnums.status.draft'),
        SUBMITTED: t('filterEnums.status.submitted'),
        APPROVED: t('filterEnums.status.approved'),
        REJECTED: t('filterEnums.status.rejected'),
        // EP-2 — the stale-review sweep flips rows into NEEDS_REVIEW.
        // Surfacing it here makes those rows filterable.
        NEEDS_REVIEW: t('filterEnums.status.needsReview'),
    };
}

// EP-2 — review-currency ("freshness") buckets. Applied SERVER-side
// (`evidenceFreshnessWhere`); the API used to `.strip()` the param, which
// meant the filter silently never reached the query at all.
export function evidenceFreshnessLabels(t: T): Record<string, string> {
    return {
        current: t('filterEnums.freshness.current'),
        expiring: t('filterEnums.freshness.expiring'),
        expired: t('filterEnums.freshness.expired'),
        needs_review: t('filterEnums.freshness.needsReview'),
    };
}

// Retention bucket → label. These four strings previously labelled the
// retention ToggleGroup; the control is gone but the vocabulary is
// unchanged, so the keys are repurposed rather than retired and
// re-translated.
//
// There is deliberately no `all` option. The bucket has always defaulted to
// `active`, and an UNSET `tab` is what expresses that default — see the
// page's `fetchParams`. Adding an explicit "All" here would be a new
// capability (archived rows in the default list), not a port of the toggle.
export function evidenceRetentionTabLabels(t: T): Record<string, string> {
    return {
        active: t('list.retentionActive'),
        expiring: t('list.triageExpiring'),
        archived: t('list.retentionArchived'),
    };
}

// ─── Filter definitions (built per render) ──────────────────────────

function evidenceFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        type: {
            label: t('filters.type'),
            description: t('filters.typeDesc'),
            group: tGroup('attributes'),
            icon: FileText,
            options: optionsFromEnum(evidenceTypeLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('workflow'),
            icon: CircleDot,
            options: optionsFromEnum(evidenceStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        // R1-2b — retention bucket, formerly the ToggleGroup above the
        // toolbar. Single-select: the buckets partition the tenant, so two at
        // once has no meaning the server could answer.
        tab: {
            label: t('filters.retention'),
            description: t('filters.retentionDesc'),
            group: tGroup('workflow'),
            icon: Archive,
            options: optionsFromEnum(evidenceRetentionTabLabels(t)),
            multiple: false,
            resetBehavior: 'clearable',
        },
        // EP-2 — freshness (review-currency) filter. Single-select;
        // applied server-side (`evidenceFreshnessWhere`).
        freshness: {
            label: t('filters.freshness'),
            description: t('filters.freshnessDesc'),
            group: tGroup('workflow'),
            icon: Clock,
            options: optionsFromEnum(evidenceFreshnessLabels(t)),
            multiple: false,
            resetBehavior: 'clearable',
        },
        controlId: {
            label: t('filters.controlId'),
            description: t('filters.controlIdDesc'),
            group: tGroup('linked'),
            icon: Link2,
            options: null, // filled at render time from the controls prop
            shouldFilter: true,
            resetBehavior: 'clearable',
        },
        // B8 follow-up — Folder filter. Options are derived at render
        // time from the folders present in the currently-loaded
        // evidence rows (plus a "No folder" pseudo-bucket when any
        // unfoldered row exists). The `__none__` sentinel matches
        // null/empty folders so legacy unfoldered evidence stays
        // findable after rollout.
        folder: {
            label: t('filters.folder'),
            description: t('filters.folderDesc'),
            group: tGroup('attributes'),
            icon: FolderOpen,
            options: null, // filled at render time from loaded evidence
            shouldFilter: true,
            resetBehavior: 'clearable',
        },
        // EP-3 — Category filter. Maps 1:1 to the API `category`
        // exact-match param. Options are derived at render time from
        // the categories present in the currently-loaded evidence
        // rows (mirrors the folder filter's runtime derivation).
        category: {
            label: t('filters.category'),
            description: t('filters.categoryDesc'),
            group: tGroup('classification'),
            icon: Tag,
            options: null, // filled at render time from loaded evidence
            shouldFilter: true,
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized evidence filter defs. `t` = `useTranslations('evidence')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildEvidenceFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(evidenceFilterDefsInput(t, tGroup));
}

// The URL-sync KEYS are label-independent — derive them once with an identity
// resolver so callers keep importing a stable `EVIDENCE_FILTER_KEYS` constant.
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const EVIDENCE_FILTER_KEYS = buildEvidenceFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

// ─── Runtime option builder ─────────────────────────────────────────

interface ControlLike {
    id: string;
    name: string;
    annexId?: string | null;
    code?: string | null;
}

/**
 * Build Control options from the list loaded server-side. The filter row
 * displays `{ code | annexId }: name` to match the pattern used elsewhere on
 * Evidence pages, while the pill text (displayLabel) stays short.
 */
export function controlOptionsFromControls(
    controls: ReadonlyArray<ControlLike>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const c of controls) {
        if (!c.id || seen.has(c.id)) continue;
        const prefix = c.annexId || c.code || '';
        seen.set(c.id, {
            value: c.id,
            label: prefix ? `${prefix}: ${c.name}` : c.name,
            displayLabel: prefix || c.name,
        });
    }
    return Array.from(seen.values()).sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

/**
 * B8 follow-up — build the Folder filter's options from whatever
 * is currently loaded. A `__none__` pseudo-option matches rows
 * with a null/empty folder, so legacy unfoldered evidence stays
 * findable after rollout.
 */
export interface EvidenceFolderLike {
    folder?: string | null;
}

export function folderOptionsFromEvidence(
    evidence: ReadonlyArray<EvidenceFolderLike>,
    t: T,
): FilterOption[] {
    const present = new Set<string>();
    let hasUnfoldered = false;
    for (const e of evidence) {
        const f = (e.folder || '').trim();
        if (f) present.add(f);
        else hasUnfoldered = true;
    }
    const out: FilterOption[] = [];
    if (hasUnfoldered) {
        out.push({ value: '__none__', label: t('filters.noFolder') });
    }
    for (const f of Array.from(present).sort()) {
        out.push({ value: f, label: f });
    }
    return out;
}

/**
 * EP-3 — build the Category filter's options from whatever evidence
 * is currently loaded. Only categories actually present are listed;
 * the API `category` param is an exact match, so an unset/"no
 * category" bucket has no query representation and is intentionally
 * omitted.
 */
export interface EvidenceCategoryLike {
    category?: string | null;
}

export function categoryOptionsFromEvidence(
    evidence: ReadonlyArray<EvidenceCategoryLike>,
): FilterOption[] {
    const present = new Set<string>();
    for (const e of evidence) {
        const c = (e.category || '').trim();
        if (c) present.add(c);
    }
    return Array.from(present)
        .sort()
        .map((c) => ({ value: c, label: c }));
}

export function buildEvidenceFilters(
    controls: ReadonlyArray<ControlLike>,
    evidence: ReadonlyArray<EvidenceFolderLike & EvidenceCategoryLike> = [],
    t: T = (k) => k,
    tGroup: TGroup = (k) => k,
) {
    const controlOpts = controlOptionsFromControls(controls);
    const folderOpts = folderOptionsFromEvidence(evidence, t);
    const categoryOpts = categoryOptionsFromEvidence(evidence);
    return buildEvidenceFilterDefs(t, tGroup).filters.map((f) => {
        if (f.key === 'controlId') return { ...f, options: controlOpts };
        if (f.key === 'folder') return { ...f, options: folderOpts };
        if (f.key === 'category') return { ...f, options: categoryOpts };
        return f;
    });
}
