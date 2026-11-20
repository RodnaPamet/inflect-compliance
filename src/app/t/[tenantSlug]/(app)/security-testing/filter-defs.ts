/**
 * Filter configuration for the Security Testing (scanner findings) list
 * page (Epic 53).
 *
 *   source   → the scanner the finding came from (SEMGREP | TRIVY | …)
 *   severity → mapped finding severity (CRITICAL | HIGH | MEDIUM | LOW)
 *   status   → triage status (OPEN | TRIAGED | FIXED | … )
 *
 * All static enum filters (no row-derived options), applied client-side to
 * the SSR-fetched rows — mirrors the sibling Vulnerabilities page.
 *
 * i18n: labels resolve at render via the `buildScannerFilterDefs(t, tGroup)`
 * factory (`t = useTranslations('securityTesting')`, `tGroup =
 * useTranslations('common.filterGroups')`). Enum VALUES + filter KEYS are
 * unchanged — only the display copy is localized.
 */
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
// filter-defs use lucide-react directly — same as every other
// *filter-defs.ts.
import { CircleDot, ShieldAlert, ScanLine } from 'lucide-react';

/** Surface-namespace resolver (`useTranslations('securityTesting')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

const SCANNER_SOURCE_KEYS = ['SEMGREP', 'TRIVY', 'ZAP', 'GITLEAKS', 'CHECKOV', 'CODEQL', 'OTHER'] as const;
const SCANNER_SEVERITY_KEYS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const SCANNER_STATUS_KEYS = ['OPEN', 'TRIAGED', 'FIXED', 'FALSE_POSITIVE', 'ACCEPTED'] as const;

const fromKeys = (keys: readonly string[], t: T, group: string): Record<string, string> =>
    Object.fromEntries(keys.map((k) => [k, t(`filterEnums.${group}.${k}`)]));

/** scanner source → label (badge + filter option source of truth). */
export function buildScannerSourceLabels(t: T): Record<string, string> {
    return fromKeys(SCANNER_SOURCE_KEYS, t, 'source');
}
/** scanner status → label. */
export function buildScannerStatusLabels(t: T): Record<string, string> {
    return fromKeys(SCANNER_STATUS_KEYS, t, 'status');
}
function scannerSeverityLabels(t: T): Record<string, string> {
    return fromKeys(SCANNER_SEVERITY_KEYS, t, 'severity');
}

function scannerFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        source: {
            label: t('filters.source'),
            description: t('filters.sourceDesc'),
            group: tGroup('attributes'),
            icon: ScanLine,
            options: optionsFromEnum(buildScannerSourceLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        severity: {
            label: t('filters.severity'),
            description: t('filters.severityDesc'),
            group: tGroup('attributes'),
            icon: ShieldAlert,
            options: optionsFromEnum(scannerSeverityLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(buildScannerStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
    } as const;
}

export const SCANNER_FILTER_KEYS = ['source', 'severity', 'status'] as const;

/** Build the localized scanner filter defs. Memoize per render. */
export function buildScannerFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(scannerFilterDefsInput(t, tGroup));
}

export function buildScannerFilters(t: T, tGroup: TGroup) {
    return buildScannerFilterDefs(t, tGroup).filters;
}
