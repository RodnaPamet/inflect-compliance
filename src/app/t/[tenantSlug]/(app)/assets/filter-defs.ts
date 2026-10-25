/**
 * Epic 53 — Assets list page filter configuration.
 *
 * Keys align with `AssetQuerySchema`: type, status, criticality.
 *
 * i18n (filter-defs factory): display labels resolve through next-intl at
 * render via `buildAssetFilterDefs(t, tGroup)` — `t` scoped to `assets`,
 * `tGroup` to the shared `common.filterGroups`. The URL-sync KEYS stay static
 * (`ASSET_FILTER_KEYS`, derived with an identity resolver) and the option
 * VALUES (the Prisma enum members) are unchanged — only their rendered label
 * is localized — so URL state + the DB contract are byte-stable.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import { CircleDot, Flag, Layers } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('assets')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// Values MUST match the Prisma enums (AssetType, AssetStatus, Criticality) in
// schema.prisma — the UI selection is passed straight through to Prisma, so
// any value not present in the DB enum produces PrismaClientValidationError on
// query and a 500 in the list page. Only the display labels are localized.
function assetTypeLabels(t: T): Record<string, string> {
    return {
        INFORMATION: t('filterEnums.type.INFORMATION'),
        SYSTEM: t('filterEnums.type.SYSTEM'),
        SERVICE: t('filterEnums.type.SERVICE'),
        DATA_STORE: t('filterEnums.type.DATA_STORE'),
        VENDOR: t('filterEnums.type.VENDOR'),
        PEOPLE_PROCESS: t('filterEnums.type.PEOPLE_PROCESS'),
        APPLICATION: t('filterEnums.type.APPLICATION'),
        INFRASTRUCTURE: t('filterEnums.type.INFRASTRUCTURE'),
        PROCESS: t('filterEnums.type.PROCESS'),
        OTHER: t('filterEnums.type.OTHER'),
    };
}

function assetStatusLabels(t: T): Record<string, string> {
    return {
        ACTIVE: t('filterEnums.status.ACTIVE'),
        RETIRED: t('filterEnums.status.RETIRED'),
    };
}

/**
 * A stored asset type or status as the label the filter shows. The table, the
 * preview panel and the form printed the enum itself ("DATA STORE"). A value
 * the map does not know is shown as stored, with its underscores spaced.
 */
export function assetTypeLabel(value: string, t: T): string {
    return assetTypeLabels(t)[value] ?? value.replace(/_/g, ' ');
}

export function assetStatusLabel(value: string, t: T): string {
    return assetStatusLabels(t)[value] ?? value.replace(/_/g, ' ');
}

function assetCriticalityLabels(t: T): Record<string, string> {
    return {
        LOW: t('filterEnums.criticality.LOW'),
        MEDIUM: t('filterEnums.criticality.MEDIUM'),
        HIGH: t('filterEnums.criticality.HIGH'),
        CRITICAL: t('filterEnums.criticality.CRITICAL'),
    };
}

function assetFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        type: {
            label: t('filters.type'),
            description: t('filters.typeDesc'),
            group: tGroup('attributes'),
            icon: Layers,
            options: optionsFromEnum(assetTypeLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(assetStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        criticality: {
            label: t('filters.criticality'),
            description: t('filters.criticalityDesc'),
            group: tGroup('quantitative'),
            icon: Flag,
            options: optionsFromEnum(assetCriticalityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized asset filter defs. `t` = `useTranslations('assets')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildAssetFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(assetFilterDefsInput(t, tGroup));
}

// The URL-sync KEYS are label-independent — derive them once with an identity
// resolver so callers keep importing a stable `ASSET_FILTER_KEYS` constant.
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const ASSET_FILTER_KEYS = buildAssetFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

/** All asset filter options are static (enum-derived) — no runtime rows. */
export function buildAssetFilters(t: T, tGroup: TGroup) {
    return buildAssetFilterDefs(t, tGroup).filters;
}
