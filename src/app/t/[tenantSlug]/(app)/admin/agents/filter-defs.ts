/**
 * Filter configuration for the agent register. Two static enum filters applied
 * client-side to the SSR rows — status (where the agent is in its lifecycle)
 * and data-access scope (how far into tenant data it reaches).
 *
 * i18n: labels resolve at render via `buildAgentFilters(t, tGroup)`
 * (`t = useTranslations('admin')`, `tGroup = useTranslations('common.filterGroups')`).
 * Enum VALUES + KEYS unchanged.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// FilterDefInput.icon is typed `LucideIcon`; a new filter-defs file has no
// Nucleo option until the filter platform migrates. Allowlisted in
// tests/guards/no-lucide.test.ts (same precedent as every other *filter-defs.ts).
import { Activity, Database } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('admin')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

const STATUS_KEYS = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const;

/**
 * Least-exposing first, matching the enum's own declared order. That order is
 * load-bearing in the schema (the scorer reads the ordinal), so the filter list
 * reads the same way round rather than alphabetically.
 */
const ACCESS_SCOPE_KEYS = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
] as const;

function labels(t: T, group: string, keys: readonly string[]): Record<string, string> {
    return Object.fromEntries(keys.map((k) => [k, t(`agentRegistry.filterEnums.${group}.${k}`)]));
}

function agentFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('agentRegistry.filters.status'),
            description: t('agentRegistry.filters.statusDesc'),
            group: tGroup('attributes'),
            icon: Activity,
            options: optionsFromEnum(labels(t, 'status', STATUS_KEYS)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        dataAccessScope: {
            label: t('agentRegistry.filters.accessScope'),
            description: t('agentRegistry.filters.accessScopeDesc'),
            group: tGroup('attributes'),
            icon: Database,
            options: optionsFromEnum(labels(t, 'accessScope', ACCESS_SCOPE_KEYS)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const AGENT_FILTER_KEYS = ['status', 'dataAccessScope'] as const;

/** Build the localized agent-register filter defs. Memoize per render. */
export function buildAgentFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(agentFilterDefsInput(t, tGroup));
}

export function buildAgentFilters(t: T, tGroup: TGroup) {
    return buildAgentFilterDefs(t, tGroup).filters;
}
