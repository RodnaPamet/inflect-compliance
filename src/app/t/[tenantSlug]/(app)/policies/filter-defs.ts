/**
 * Epic 53 — Policies list page filter configuration.
 *
 * Keys map onto `PolicyQuerySchema` (q + status + category + language +
 * reviewBucket + outstanding).
 * `language` isn't surfaced today (the page doesn't render multilingual
 * policies yet); we leave room for it in the static config so the filter
 * can be added without touching the page.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { CircleDot, Tag, Clock, BellRing } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('policies')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// Canonical labels for `PolicyStatus` — single source of truth for
// the filter picker AND the row badge. Pre-Epic-45 the filter map
// listed `RETIRED` but the schema enum is `ARCHIVED`; that drift
// meant a "Retired" filter selection matched zero rows. Aligned to
// the enum here so future column wiring stays canonical.
export function buildPolicyStatusLabels(t: T): Record<string, string> {
    return {
        DRAFT: t('filterEnums.status.draft'),
        IN_REVIEW: t('filterEnums.status.inReview'),
        APPROVED: t('filterEnums.status.approved'),
        PUBLISHED: t('filterEnums.status.published'),
        ARCHIVED: t('filterEnums.status.archived'),
    };
}

function policyFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(buildPolicyStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        category: {
            label: t('filters.category'),
            description: t('filters.categoryDesc'),
            group: tGroup('attributes'),
            icon: Tag,
            options: null, // the tenant's categories + loaded rows (buildPolicyFilters)
            multiple: true,
            resetBehavior: 'clearable',
        },
        // Review-cycle bucket (Prompt-2.3). Matched against a `reviewBucket`
        // field derived on each row from nextReviewAt.
        reviewBucket: {
            label: t('filters.reviewBucket'),
            description: t('filters.reviewBucketDesc'),
            group: tGroup('attributes'),
            icon: Clock,
            options: [
                { value: 'overdue', label: t('filterEnums.reviewBucket.overdue') },
                { value: 'upcoming', label: t('filterEnums.reviewBucket.upcoming') },
            ],
            multiple: false,
            resetBehavior: 'clearable',
        },
        // Acknowledgement completeness. Unlike `category` / `reviewBucket`
        // this is NOT derived from the loaded rows — the value is forwarded to
        // the API and resolved against the whole tenant server-side, so the
        // facet stays correct past the first page.
        outstanding: {
            label: t('filters.acknowledgement'),
            description: t('filters.acknowledgementDesc'),
            group: tGroup('attributes'),
            icon: BellRing,
            options: [
                { value: 'true', label: t('filterEnums.acknowledgement.outstanding') },
            ],
            multiple: false,
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized policy filter defs. `t` = `useTranslations('policies')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildPolicyFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(policyFilterDefsInput(t, tGroup));
}

const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const POLICY_FILTER_KEYS = buildPolicyFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

interface PolicyLike {
    category?: string | null;
}

/**
 * Category facet options: `knownCategories` (every category in the tenant,
 * from the server) plus any carried by the loaded rows — the rows alone are
 * the current-filter result, so with one category chosen they offer only it.
 */
export function categoryOptionsFromPolicies(
    policies: ReadonlyArray<PolicyLike>,
    knownCategories: ReadonlyArray<string> = [],
): FilterOption[] {
    const seen = new Set<string>();
    for (const c of knownCategories) {
        const v = c.trim();
        if (v) seen.add(v);
    }
    for (const p of policies) {
        const c = p.category?.trim();
        if (c) seen.add(c);
    }
    return Array.from(seen)
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));
}

export function buildPolicyFilters(
    policies: ReadonlyArray<PolicyLike>,
    t: T = (k) => k,
    tGroup: TGroup = (k) => k,
    knownCategories: ReadonlyArray<string> = [],
) {
    const categoryOpts = categoryOptionsFromPolicies(policies, knownCategories);
    return buildPolicyFilterDefs(t, tGroup).filters.map((f) =>
        f.key === 'category' ? { ...f, options: categoryOpts } : f,
    );
}
