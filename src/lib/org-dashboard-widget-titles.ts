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

/**
 * `${type}/${chartType}` → its catalog key under `org.widgets`.
 *
 * The English titles above are what the create path STORES when a widget is
 * saved without a title, so every preset widget's row carries one of them.
 * The dashboard reads a stored title that still equals its stock English
 * title as "never renamed" and shows this key instead, in the viewer's
 * language — which is what makes rows written before this map existed render
 * translated too. A title the org typed is shown as typed.
 */
export const WIDGET_TITLE_MESSAGE_KEYS: Record<string, string> = {
    'ORG_THREAT_LEVEL/banner': 'threatLevel',
    'KPI/coverage': 'coverage',
    'KPI/critical-risks': 'criticalRisks',
    'KPI/overdue-evidence': 'overdueEvidence',
    'KPI/tenants': 'tenants',
    'DONUT/rag-distribution': 'tenantHealthDistribution',
    'TREND/risks-open': 'trendRisksOpen',
    'TREND/controls-coverage': 'trendControlsCoverage',
    'TREND/evidence-overdue': 'trendEvidenceOverdue',
    'ORG_MATURITY/radar': 'securityMaturity',
    'TENANT_LIST/coverage': 'coverageByTenant',
    'DRILLDOWN_CTAS/default': 'drilldown',
    'ORG_INITIATIVES/list': 'securityInitiatives',
};

/**
 * The title a reader sees: the org's own title when it renamed the widget,
 * otherwise the catalog's title in the reader's language (`t` is rooted at
 * `org.widgets`), otherwise the guaranteed English fallback.
 */
export function localizedWidgetTitle(
    type: string,
    chartType: string,
    title: string | null | undefined,
    t: (key: string) => string,
): string {
    const stock = resolveWidgetTitle(type, chartType, null);
    const own = title?.trim();
    if (own && own !== stock) return own;
    const key = WIDGET_TITLE_MESSAGE_KEYS[widgetTitleKey(type, chartType)];
    return key ? t(key) : stock;
}

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
