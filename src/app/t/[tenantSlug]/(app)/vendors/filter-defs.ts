/**
 * Epic 53 — Vendors list page filter configuration.
 *
 * Keys align with `VendorQuerySchema`: status, criticality, riskRating,
 * reviewDue. Review-due is a chip-style pseudo-enum the server interprets
 * directly (no transform needed).
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import { CircleDot, Clock, Flag, ShieldCheck } from 'lucide-react';
import { vendorCriticalityLabels, vendorStatusLabels } from '@/lib/vendors/labels';

/** Surface-namespace resolver (`useTranslations('vendors')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// Shared with the Information Registry, so they live in `src/lib/vendors/`.
export { vendorStatusLabels, vendorCriticalityLabels } from '@/lib/vendors/labels';

function vendorReviewDueLabels(t: T): Record<string, string> {
    return {
        overdue: t('filterEnums.reviewDue.overdue'),
        next30d: t('filterEnums.reviewDue.next30d'),
    };
}

function vendorFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(vendorStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        criticality: {
            label: t('filters.criticality'),
            description: t('filters.criticalityDesc'),
            group: tGroup('quantitative'),
            icon: Flag,
            options: optionsFromEnum(vendorCriticalityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        riskRating: {
            label: t('filters.riskRating'),
            description: t('filters.riskRatingDesc'),
            group: tGroup('quantitative'),
            icon: ShieldCheck,
            options: optionsFromEnum(vendorCriticalityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        reviewDue: {
            label: t('filters.reviewDue'),
            description: t('filters.reviewDueDesc'),
            group: tGroup('timeline'),
            icon: Clock,
            options: optionsFromEnum(vendorReviewDueLabels(t)),
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized vendor filter defs. `t` = `useTranslations('vendors')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildVendorFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(vendorFilterDefsInput(t, tGroup));
}

const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const VENDOR_FILTER_KEYS = buildVendorFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

export function buildVendorFilters(t: T = (k) => k, tGroup: TGroup = (k) => k) {
    // Vendors have only static enum filters today — no runtime option derivation.
    return buildVendorFilterDefs(t, tGroup).filters;
}
