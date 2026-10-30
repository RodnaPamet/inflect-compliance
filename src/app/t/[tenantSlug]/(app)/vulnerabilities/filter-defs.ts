/**
 * Filter configuration for the Vulnerabilities list page (Epic 53).
 *
 *   status   → AssetVulnerability.status (OPEN | MITIGATING | … )
 *   severity → the matched CVE's CVSS severity (CRITICAL | HIGH | MEDIUM | LOW)
 *
 * Both are static enum filters (no row-derived options), applied client-side
 * to the SSR-fetched rows.
 *
 * i18n: labels resolve at render via `buildVulnFilterDefs(t, tGroup)`
 * (`t = useTranslations('vulnerabilities')`, `tGroup =
 * useTranslations('common.filterGroups')`). Enum VALUES + KEYS unchanged.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// FilterDefInput.icon is typed `LucideIcon` (the filter platform hasn't
// migrated to Nucleo), so filter-defs use lucide-react — same as every other
// *filter-defs.ts. This file is allowlisted in tests/guards/no-lucide.test.ts.
import { CircleDot, ShieldAlert } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('vulnerabilities')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

const VULN_STATUS_KEYS = ['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'FALSE_POSITIVE'] as const;
const VULN_SEVERITY_KEYS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

const fromKeys = (keys: readonly string[], t: T, group: string): Record<string, string> =>
    Object.fromEntries(keys.map((k) => [k, t(`filterEnums.${group}.${k}`)]));

/** vulnerability status → label (badge + filter option source of truth). */
export function buildVulnStatusLabels(t: T): Record<string, string> {
    return fromKeys(VULN_STATUS_KEYS, t, 'status');
}
/** CVSS severity → label (badge + filter option source of truth). */
export function buildVulnSeverityLabels(t: T): Record<string, string> {
    return fromKeys(VULN_SEVERITY_KEYS, t, 'severity');
}

/**
 * How a match was made → label. `CPE` is every automatic match (the matcher
 * writes it for a CPE or a vendor/product key alike); `MANUAL` is Link CVE.
 */
const VULN_MATCHED_VIA_KEYS = ['CPE', 'MANUAL'] as const;
export function buildVulnMatchedViaLabels(t: T): Record<string, string> {
    return Object.fromEntries(VULN_MATCHED_VIA_KEYS.map((k) => [k, t(`matchedViaLabels.${k}`)]));
}

function vulnFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(buildVulnStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        severity: {
            label: t('filters.severity'),
            description: t('filters.severityDesc'),
            group: tGroup('attributes'),
            icon: ShieldAlert,
            options: optionsFromEnum(buildVulnSeverityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const VULN_FILTER_KEYS = ['status', 'severity'] as const;

/** Build the localized vulnerability filter defs. Memoize per render. */
export function buildVulnFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(vulnFilterDefsInput(t, tGroup));
}

export function buildVulnFilters(t: T, tGroup: TGroup) {
    return buildVulnFilterDefs(t, tGroup).filters;
}
