/**
 * Filter configuration for the Business Continuity (BIA) register (Epic 53).
 * A static criticality enum filter, applied client-side to the SSR rows —
 * mirrors the sibling Vulnerabilities / Security Testing pages.
 *
 * i18n: labels resolve at render via `buildBiaFilterDefs(t, tGroup)`
 * (`t = useTranslations('audits')`, `tGroup =
 * useTranslations('common.filterGroups')`). Enum VALUES + KEYS unchanged.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// filter-defs files take their icons from lucide-react directly (same as
// every other *filter-defs.ts).
import { ShieldAlert } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('audits')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

const BIA_CRITICALITY_KEYS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/** criticality → label. Source of truth for the filter dropdown + the
 *  NewBiaModal criticality picker. `t = useTranslations('audits')`. */
export function buildBiaCriticalityLabels(t: T): Record<string, string> {
    return Object.fromEntries(BIA_CRITICALITY_KEYS.map((k) => [k, t(`bia.crit.${k}`)]));
}

function biaFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        criticality: {
            label: t('bia.colCriticality'),
            description: t('bia.filterCriticalityDesc'),
            group: tGroup('attributes'),
            icon: ShieldAlert,
            options: optionsFromEnum(buildBiaCriticalityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const BIA_FILTER_KEYS = ['criticality'] as const;

/** Build the localized BIA filter defs. Memoize per render. */
export function buildBiaFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(biaFilterDefsInput(t, tGroup));
}

export function buildBiaFilters(t: T, tGroup: TGroup) {
    return buildBiaFilterDefs(t, tGroup).filters;
}
