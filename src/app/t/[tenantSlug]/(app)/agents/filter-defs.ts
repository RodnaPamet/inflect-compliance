/**
 * Filter configuration for the agent register. Three static enum filters —
 * status (where the agent is in its lifecycle), data-access scope (how far into
 * tenant data it reaches) and authority tier.
 *
 * APPLIED IN SQL, not over the loaded rows. The header used to say
 * "client-side to the SSR rows" and that was the arrangement the KPI cards made
 * untenable: a card's number has to be a count of what its click produces, and
 * a click that filters a capped array cannot be counted over the tenant. See
 * `AgentListFilters` in `RegisteredAgentRepository`.
 *
 * THE TIER FILTER CARRIES `UNSCORED` AS A MEMBER. `riskTier` is NULL for an
 * agent nobody has assessed, every consumer reads NULL as deny, and the whole
 * register exists because that is the state you most want to find — so
 * "not yet scored" has to be selectable. It is listed FIRST, ahead of the four
 * real tiers, for the same reason.
 *
 * i18n: labels resolve at render via `buildAgentFilters(t, tGroup)`
 * (`t = useTranslations('agents')`, `tGroup = useTranslations('common.filterGroups')`).
 * Enum VALUES + KEYS unchanged.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// FilterDefInput.icon is typed `LucideIcon`; a new filter-defs file has no
// Nucleo option until the filter platform migrates. Allowlisted in
// tests/guards/no-lucide.test.ts (same precedent as every other *filter-defs.ts).
import { Activity, Database, Gauge } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('agents')`). */
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

/**
 * The authority-tier filter's members, UNSCORED first.
 *
 * Mirrors `AGENT_TIER_FILTER_VALUES` in the repository, which is where the
 * server-side meaning of each member lives. The two lists are the same
 * vocabulary written for two audiences (a Prisma predicate, a picker), and the
 * repository's is the one that decides anything.
 */
const TIER_KEYS = ['UNSCORED', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;

function labels(t: T, group: string, keys: readonly string[]): Record<string, string> {
    return Object.fromEntries(keys.map((k) => [k, t(`register.filterEnums.${group}.${k}`)]));
}

function agentFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('register.filters.status'),
            description: t('register.filters.statusDesc'),
            group: tGroup('attributes'),
            icon: Activity,
            options: optionsFromEnum(labels(t, 'status', STATUS_KEYS)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        dataAccessScope: {
            label: t('register.filters.accessScope'),
            description: t('register.filters.accessScopeDesc'),
            group: tGroup('attributes'),
            icon: Database,
            options: optionsFromEnum(labels(t, 'accessScope', ACCESS_SCOPE_KEYS)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        riskTier: {
            label: t('register.filters.riskTier'),
            description: t('register.filters.riskTierDesc'),
            group: tGroup('attributes'),
            icon: Gauge,
            options: optionsFromEnum(labels(t, 'riskTier', TIER_KEYS)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const AGENT_FILTER_KEYS = ['status', 'dataAccessScope', 'riskTier'] as const;

/** Build the localized agent-register filter defs. Memoize per render. */
export function buildAgentFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(agentFilterDefsInput(t, tGroup));
}

export function buildAgentFilters(t: T, tGroup: TGroup) {
    return buildAgentFilterDefs(t, tGroup).filters;
}
