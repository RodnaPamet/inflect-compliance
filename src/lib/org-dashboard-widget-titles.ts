/**
 * Canonical org-dashboard widget titles — the SINGLE source the preset,
 * the dispatcher, the null-title backfill migration, and the integrity
 * ratchet all share. A widget must NEVER render a raw slug
 * ("risks-open", "rag-distribution") or an untitled chart.
 *
 * Keyed by `${type}/${chartType}` (NOT chartType alone): the same
 * chartType is reused across widget types — e.g. `coverage` is both the
 * KPI "Coverage" tile and the TENANT_LIST "Coverage by Tenant" list — so
 * a chartType-only map would collide.
 */

/** `${OrgDashboardWidgetType}/${chartType}` → human title. */
export const WIDGET_TITLES: Record<string, string> = {
    'ORG_THREAT_LEVEL/banner': 'Threat Level',
    'KPI/coverage': 'Coverage',
    'KPI/critical-risks': 'Critical Risks',
    'KPI/overdue-evidence': 'Overdue Evidence',
    'KPI/tenants': 'Tenants',
    'DONUT/rag-distribution': 'Tenant Health Distribution',
    'TREND/risks-open': 'Open Risks (90 days)',
    'ORG_MATURITY/radar': 'Security Maturity',
    'TENANT_LIST/coverage': 'Coverage by Tenant',
    'DRILLDOWN_CTAS/default': 'Drill-down',
    'ORG_INITIATIVES/list': 'Security Initiatives',
};

export function widgetTitleKey(type: string, chartType: string): string {
    return `${type}/${chartType}`;
}

/**
 * Sentence-case a slug as the ABSOLUTE last resort. Only reached for a
 * (type, chartType) the canonical map doesn't cover — the ratchet keeps
 * the map complete, so in practice this never shows a slug verbatim
 * (`risks-open` → "Risks Open", not "risks-open").
 */
export function sentenceCaseSlug(slug: string): string {
    if (!slug) return 'Widget';
    return slug
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a GUARANTEED human title for a widget — never a raw slug,
 * never empty. Order: the widget's own (trimmed) title → the canonical
 * map → a sentence-cased fallback.
 */
export function resolveWidgetTitle(
    type: string,
    chartType: string,
    title?: string | null,
): string {
    const own = title?.trim();
    if (own) return own;
    return (
        WIDGET_TITLES[widgetTitleKey(type, chartType)] ??
        sentenceCaseSlug(chartType)
    );
}
