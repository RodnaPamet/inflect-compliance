/**
 * Filter configuration for the synced-identity roster.
 *
 * ONE FACET, AND IT IS SERVER-SIDE. `provider` is forwarded to
 * `GET /admin/integrations/identity-accounts?provider=…` and applied in SQL —
 * not used to re-filter rows already on the page. On a list the server caps at
 * IDENTITY_ROSTER_PAGE_SIZE that distinction is the whole point: filtering the
 * delivered page can only hide rows, never reveal the ones the cap cut.
 *
 * Single-select (`multiple: false`) because the route's parameter is one
 * provider, not a set. A multi-select here would render pills the query cannot
 * honour.
 *
 * WHY THERE IS NO CONNECTION FACET, though every row now carries
 * `connectionId` + `connectionName` (#2412). The option list would have to be
 * derived from the loaded rows, and the loaded rows are exactly the truncated
 * page this change exists to see past — so a second connection whose accounts
 * all sort past the cap would be missing from its own filter. Free-text search
 * reaches those rows; a facet built from them cannot. If a connection facet is
 * wanted later, its options belong in a response from the connections route,
 * not in a scan of this one's page.
 *
 * i18n: labels resolve at render via `buildIdentityAccountFilters(t, tGroup)`
 * (`t = useTranslations('admin')`, `tGroup = useTranslations('common.filterGroups')`).
 * Provider VALUES are the wire values the route matches on and are never
 * localized.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
// `FilterDefInput.icon` is typed `LucideIcon` (the filter platform has not
// migrated to Nucleo), so a filter-defs file has no Nucleo option — same
// precedent as every other *filter-defs.ts in this tree.
import { Building2 } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('admin')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

/**
 * The directory providers a sync can populate this roster from — the same set
 * `IDENTITY_SYNC_PROVIDERS` drives in `usecases/integrations.ts`. Declared as
 * a fixed list rather than derived from the loaded rows, for the reason in the
 * docblock above: a list derived from a capped page under-reports.
 */
const IDENTITY_PROVIDER_KEYS = ['okta', 'google-workspace', 'entra-id', 'active-directory'] as const;

function providerLabels(t: T): Record<string, string> {
    return Object.fromEntries(
        IDENTITY_PROVIDER_KEYS.map((k) => [k, t(`identityAccounts.providerLabels.${k}`)]),
    );
}

function identityAccountFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        provider: {
            label: t('identityAccounts.filters.provider'),
            description: t('identityAccounts.filters.providerDesc'),
            group: tGroup('attributes'),
            icon: Building2,
            options: optionsFromEnum(providerLabels(t)),
            // See the docblock: the route takes ONE provider.
            multiple: false,
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized roster filter defs. Memoize per render. */
export function buildIdentityAccountFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(identityAccountFilterDefsInput(t, tGroup));
}

// Filter KEYS are label-independent — derive once with identity resolvers, so
// the array has a stable identity across renders (`useFilterContext` memoizes
// on it).
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const IDENTITY_ACCOUNT_FILTER_KEYS =
    buildIdentityAccountFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

export function buildIdentityAccountFilters(t: T, tGroup: TGroup) {
    return buildIdentityAccountFilterDefs(t, tGroup).filters;
}
