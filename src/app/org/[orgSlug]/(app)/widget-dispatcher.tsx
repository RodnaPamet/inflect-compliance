"use client";

/**
 * Epic 41 page rewire — per-widget rendering dispatcher.
 *
 * Maps a backend `OrgDashboardWidget` row + the live portfolio
 * data into a rendered `<DashboardWidget>` tile. The dispatcher
 * is the single point that translates persistence vocabulary
 * (`type` + `chartType` + `config`) into the visualization
 * primitive (`<ChartRenderer>` + extracted section components).
 *
 * Adding a new (type, chartType) variant is a one-place edit
 * here + the matching schema + the matching backend chartType
 * enum extension. The renderer stays variant-agnostic.
 */

import { ShieldCheck, AlertTriangle, Paperclip, Building2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
    ChartRenderer,
    DashboardWidget,
    type ChartRendererProps,
} from '@/components/ui/dashboard-widgets';
import type { OrgDashboardWidgetDto } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { resolveWidgetTitle } from '@/lib/org-dashboard-widget-titles';
import type { OrgThreatLevelDto } from '@/app-layer/usecases/org-threat-level';
import { OrgThreatLevelWidget } from './OrgThreatLevelWidget';
import type { OrgMaturityDto } from '@/app-layer/usecases/org-maturity';
import { OrgMaturityWidget } from './OrgMaturityWidget';
import type { InitiativeWidgetData } from '@/app-layer/usecases/org-security-initiative';
import { OrgInitiativesWidget } from './OrgInitiativesWidget';
import type {
    PortfolioSummary,
    PortfolioTrend,
    TenantHealthRow,
} from '@/app-layer/schemas/portfolio';

import {
    DrillDownCtas,
    TenantCoverageList,
} from './dashboard-sections';

type OrgTranslate = ReturnType<typeof useTranslations>;

// Localized widget title — prefers the widget's own title, then a
// catalog key for the known preset widgets, then the canonical
// (English) fallback so a title is always present.
const TITLE_KEY: Record<string, string> = {
    'KPI/coverage': 'widgets.coverage',
    'KPI/critical-risks': 'widgets.criticalRisks',
    'KPI/overdue-evidence': 'widgets.overdueEvidence',
    'KPI/tenants': 'widgets.tenants',
    'DONUT/rag-distribution': 'widgets.tenantHealthDistribution',
    'TREND/risks-open': 'widgets.trendRisksOpen',
    'TREND/controls-coverage': 'widgets.trendControlsCoverage',
    'TREND/evidence-overdue': 'widgets.trendEvidenceOverdue',
    'TENANT_LIST/coverage': 'widgets.coverageByTenant',
    'DRILLDOWN_CTAS/default': 'widgets.drilldown',
};

function localizedWidgetTitle(t: OrgTranslate, widget: OrgDashboardWidgetDto): string {
    const own = widget.title?.trim();
    if (own) return own;
    const key = TITLE_KEY[`${widget.type}/${widget.chartType}`];
    if (key) return t(key);
    return resolveWidgetTitle(widget.type, widget.chartType, widget.title);
}

// ─── Public types ───────────────────────────────────────────────────

export interface PortfolioData {
    summary: PortfolioSummary;
    tenantHealth: TenantHealthRow[];
    trends: PortfolioTrend;
    orgSlug: string;
    /** Current org-wide threat posture (ORG_THREAT_LEVEL widget). */
    threatLevel: OrgThreatLevelDto;
    /** Whether the viewer may set the posture (ORG_ADMIN). */
    canSetThreatLevel: boolean;
    /** Current org security-maturity rating (ORG_MATURITY widget). */
    maturity: OrgMaturityDto;
    /** Whether the viewer may set the maturity rating (ORG_ADMIN). */
    canSetMaturity: boolean;
    /** Top-N portfolio security initiatives (ORG_INITIATIVES widget). */
    initiatives: InitiativeWidgetData;
    /** Whether the viewer may manage initiatives (ORG_ADMIN). */
    canManageInitiatives: boolean;
}

interface DispatcherProps {
    widget: OrgDashboardWidgetDto;
    data: PortfolioData;
    /** Render-mode actions slot. Empty in read mode; carries the
     *  delete trigger in edit mode. */
    actionsSlot?: React.ReactNode;
}

// ─── KPI variant resolver ──────────────────────────────────────────
//
// Each chartType pulls its value/subtitle from a different slice of
// PortfolioSummary. Centralising the mapping here keeps the
// dispatcher's KPI arm small and lets the picker / preset / API
// share one source of truth for "which metric does each chartType
// surface".

const KPI_GRADIENTS: Record<string, string> = {
    coverage: 'from-emerald-500 to-teal-500',
    'critical-risks': 'from-rose-500 to-red-500',
    'overdue-evidence': 'from-amber-500 to-orange-500',
    tenants: 'from-blue-500 to-indigo-500',
};

const KPI_ICONS = {
    coverage: ShieldCheck,
    'critical-risks': AlertTriangle,
    'overdue-evidence': Paperclip,
    tenants: Building2,
} as const;

// Per-KPI accessor into the portfolio trend series, so a KPI tile can
// show its prior-period value (▲/▼ arrow) + an inline sparkline. The
// `tenants` KPI has no per-period baseline in the trend snapshot, so it
// is intentionally absent — its arrow simply doesn't render.
import type { PortfolioTrendDataPoint } from '@/app-layer/schemas/portfolio';
import type { MiniAreaChartVariant } from '@/components/ui/mini-area-chart';

const KPI_TREND_ACCESSOR: Record<
    string,
    { pick: (p: PortfolioTrendDataPoint) => number; variant: MiniAreaChartVariant }
> = {
    coverage: { pick: (p) => p.controlCoveragePercent, variant: 'success' },
    'critical-risks': { pick: (p) => p.risksCritical, variant: 'error' },
    'overdue-evidence': { pick: (p) => p.evidenceOverdue, variant: 'warning' },
};

/**
 * Resolve the KPI's inline trend from the portfolio trend series:
 * a `{date,value}[]` sparkline + the previous-period value that drives
 * `KpiCard`'s ▲/▼ arrow. Returns empty fields for KPIs with no series.
 */
function resolveKpiTrend(
    chartType: string,
    dataPoints: ReadonlyArray<PortfolioTrendDataPoint>,
): { sparkline?: ReadonlyArray<{ date: Date; value: number }>; sparklineVariant?: MiniAreaChartVariant; previousValue?: number } {
    const accessor = KPI_TREND_ACCESSOR[chartType];
    if (!accessor || dataPoints.length === 0) return {};
    const sparkline = dataPoints.map((p) => ({
        date: new Date(p.date),
        value: accessor.pick(p),
    }));
    const previousValue =
        sparkline.length >= 2 ? sparkline[sparkline.length - 2].value : undefined;
    return { sparkline, sparklineVariant: accessor.variant, previousValue };
}

function resolveKpiContent(
    t: OrgTranslate,
    widget: OrgDashboardWidgetDto,
    data: PortfolioData,
): ChartRendererProps {
    const cfg = widget.config as Record<string, unknown>;
    const format = (cfg.format as 'number' | 'percent' | 'compact' | undefined) ?? 'number';
    const gradient = (cfg.gradient as string | undefined)
        ?? KPI_GRADIENTS[widget.chartType]
        ?? 'from-brand-default to-brand-muted';
    // Prior-period value + sparkline from the portfolio trend series so
    // the ▲/▼ arrow + inline sparkline actually render.
    const trend = resolveKpiTrend(widget.chartType, data.trends.dataPoints);

    switch (widget.chartType) {
        case 'coverage':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? t('widgets.coverage'),
                    value: data.summary.controls.coveragePercent,
                    format,
                    gradient,
                    icon: KPI_ICONS.coverage,
                    subtitle: t('widgets.coverageSubtitle', {
                        implemented: data.summary.controls.implemented.toLocaleString(),
                        applicable: data.summary.controls.applicable.toLocaleString(),
                    }),
                    trendPolarity: 'up-good',
                    ...trend,
                },
            };
        case 'critical-risks':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? t('widgets.criticalRisks'),
                    value: data.summary.risks.critical,
                    format,
                    gradient,
                    icon: KPI_ICONS['critical-risks'],
                    subtitle: t('widgets.criticalRisksSubtitle', {
                        open: data.summary.risks.open.toLocaleString(),
                        high: data.summary.risks.high.toLocaleString(),
                    }),
                    trendPolarity: 'down-good',
                    ...trend,
                },
            };
        case 'overdue-evidence':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? t('widgets.overdueEvidence'),
                    value: data.summary.evidence.overdue,
                    format,
                    gradient,
                    icon: KPI_ICONS['overdue-evidence'],
                    subtitle: t('widgets.overdueEvidenceSubtitle', {
                        dueSoon: data.summary.evidence.dueSoon7d.toLocaleString(),
                    }),
                    trendPolarity: 'down-good',
                    ...trend,
                },
            };
        case 'tenants':
            return {
                chartType: 'kpi',
                config: {
                    label: widget.title ?? t('widgets.tenants'),
                    value: data.summary.tenants.total,
                    format,
                    gradient,
                    icon: KPI_ICONS.tenants,
                    subtitle: t('widgets.tenantsSubtitle', {
                        snapshotted: data.summary.tenants.snapshotted.toLocaleString(),
                    }),
                    trendPolarity: 'neutral',
                    ...trend,
                },
            };
    }
    return {
        chartType: 'kpi',
        config: {
            // Never the raw chartType slug — resolve a guaranteed human title.
            label: localizedWidgetTitle(t, widget),
            value: null,
            format,
        },
    };
}

// ─── Donut variant resolver ────────────────────────────────────────

const RAG_COLORS = {
    GREEN: 'rgb(16, 185, 129)',
    AMBER: 'rgb(245, 158, 11)',
    RED: 'rgb(239, 68, 68)',
    PENDING: 'rgb(148, 163, 184)',
} as const;

function resolveDonutContent(
    t: OrgTranslate,
    widget: OrgDashboardWidgetDto,
    data: PortfolioData,
): ChartRendererProps {
    const cfg = widget.config as { showLegend?: boolean };
    if (widget.chartType === 'rag-distribution') {
        // These are TENANT-HEALTH (RAG) bands, NOT risk counts. The labels
        // are deliberately disambiguated from the risk vocabulary: a viewer
        // must never read the donut's "Critical health" tenant band as the
        // "Critical Risks" metric (which is a different number, sourced from
        // summary.risks.critical and surfaced by the KPI + drill-down). The
        // center reads "Tenants", not a bare "Active", for the same reason.
        const segments = [
            { label: t('widgets.healthy'), value: data.summary.rag.green, color: RAG_COLORS.GREEN },
            { label: t('widgets.atRisk'), value: data.summary.rag.amber, color: RAG_COLORS.AMBER },
            { label: t('widgets.criticalHealth'), value: data.summary.rag.red, color: RAG_COLORS.RED },
            { label: t('widgets.pendingSnapshot'), value: data.summary.rag.pending, color: RAG_COLORS.PENDING },
        ].filter((s) => s.value > 0);
        const totalCategorised = data.summary.rag.green + data.summary.rag.amber + data.summary.rag.red;
        return {
            chartType: 'donut',
            config: {
                segments,
                centerLabel:
                    totalCategorised > 0 ? String(totalCategorised) : undefined,
                centerSub: t('widgets.tenantsCenter'),
                showLegend: cfg.showLegend ?? true,
            },
        };
    }
    return { chartType: 'donut', config: { segments: [] } };
}

// ─── Trend variant resolver ────────────────────────────────────────

function resolveTrendContent(
    t: OrgTranslate,
    widget: OrgDashboardWidgetDto,
    data: PortfolioData,
): ChartRendererProps {
    const cfg = widget.config as {
        colorClassName?: string;
        target?: { value: number; label?: string; polarity?: 'above-good' | 'below-good' };
    };
    const points = data.trends.dataPoints.map((p) => {
        let value = 0;
        switch (widget.chartType) {
            case 'risks-open':
                value = p.risksOpen;
                break;
            case 'controls-coverage':
                value = p.controlCoveragePercent;
                break;
            case 'evidence-overdue':
                value = p.evidenceOverdue;
                break;
        }
        return { date: new Date(p.date), value };
    });

    const colorMap: Record<string, string> = {
        'risks-open': 'text-content-error',
        'controls-coverage': 'text-content-success',
        'evidence-overdue': 'text-content-warning',
    };

    return {
        chartType: 'area',
        config: {
            points,
            seriesId: widget.chartType,
            seriesColorClassName:
                cfg.colorClassName ?? colorMap[widget.chartType] ?? 'text-brand-default',
            seriesLabel: localizedWidgetTitle(t, widget),
            // Epic 41 prompt 5 — forward the optional target line so
            // <TargetLine> actually renders (schema + renderer + component
            // all supported it; only this forward was missing).
            target: cfg.target,
        },
    };
}

// ─── Main dispatcher ──────────────────────────────────────────────

/**
 * Stable DOM ids for dispatched widgets.
 *
 * The org dashboard predates the configurable widget engine; the
 * pre-Epic-41 hardcoded layout exposed `#org-stat-coverage`,
 * `#org-stat-critical-risks`, `#org-stat-overdue-evidence`,
 * `#org-stat-tenants`, `#org-drilldown-ctas`, and `#org-tenant-coverage`
 * as load-bearing anchors for E2E selectors (`ciso-portfolio.spec.ts`)
 * and deep-link navigation. The rewire to widgets must preserve them
 * so external automation doesn't silently break.
 *
 * KPI widgets get one id per `chartType` (the inner stat is what the
 * test asserts on); other widget types get one id per `type`.
 */
function widgetDomId(widget: OrgDashboardWidgetDto): string | undefined {
    if (widget.type === 'KPI') {
        return `org-stat-${widget.chartType}`;
    }
    if (widget.type === 'DRILLDOWN_CTAS') return 'org-drilldown-ctas';
    if (widget.type === 'TENANT_LIST') return 'org-tenant-coverage';
    return undefined;
}

export function DispatchedWidget({
    widget,
    data,
    actionsSlot,
}: DispatcherProps) {
    const t = useTranslations('org');
    let body: React.ReactNode = null;
    // Guaranteed human title — never undefined / a raw slug. The DONUT /
    // TREND arms (and any future chart widget) rely on this so a null-title
    // widget renders titled, not as an untitled chart.
    let title: string = localizedWidgetTitle(t, widget);
    const domId = widgetDomId(widget);

    switch (widget.type) {
        case 'KPI': {
            // KPI cards have their own internal label and gradient;
            // wrapping them in a DashboardWidget with a title would
            // double-render the label. Render bare — the KpiCard IS
            // the widget surface for this type. The id wrapper exists
            // so the legacy `#org-stat-*` E2E selectors keep resolving.
            const props = resolveKpiContent(t, widget, data);
            return (
                <div id={domId} className="h-full">
                    <ChartRenderer {...props} />
                </div>
            );
        }
        case 'ORG_THREAT_LEVEL': {
            // Human-curated posture banner — owns its own surface/padding,
            // so render bare like KPI rather than inside a DashboardWidget.
            const cfg = widget.config as { showHistory?: boolean };
            return (
                <div id={domId} className="h-full">
                    <OrgThreatLevelWidget
                        data={data.threatLevel}
                        canSet={data.canSetThreatLevel}
                        showHistory={Boolean(cfg.showHistory)}
                        orgSlug={data.orgSlug}
                    />
                </div>
            );
        }
        case 'ORG_MATURITY': {
            // Self-assessed maturity — radar + overall KPI; owns its surface.
            const cfg = widget.config as { view?: 'radar' | 'trend'; showCoverageHint?: boolean };
            return (
                <div id={domId} className="h-full">
                    <OrgMaturityWidget
                        data={data.maturity}
                        canSet={data.canSetMaturity}
                        view={cfg.view ?? 'radar'}
                        showCoverageHint={Boolean(cfg.showCoverageHint)}
                        orgSlug={data.orgSlug}
                    />
                </div>
            );
        }
        case 'ORG_INITIATIVES': {
            // Portfolio programme tracker — top-N in-flight initiatives.
            return (
                <div id={domId} className="h-full">
                    <OrgInitiativesWidget data={data.initiatives} orgSlug={data.orgSlug} />
                </div>
            );
        }
        case 'DONUT': {
            body = <ChartRenderer {...resolveDonutContent(t, widget, data)} />;
            break;
        }
        case 'TREND': {
            body = <ChartRenderer {...resolveTrendContent(t, widget, data)} />;
            break;
        }
        case 'TENANT_LIST': {
            const cfg = widget.config as {
                sortBy?: 'rag' | 'name' | 'coverage';
                limit?: number;
            };
            title = widget.title ?? t('widgets.coverageByTenant');
            body = (
                <div className="overflow-y-auto h-full -mx-2 px-2">
                    <TenantCoverageList
                        rows={data.tenantHealth}
                        sortBy={cfg.sortBy}
                        limit={cfg.limit}
                    />
                </div>
            );
            break;
        }
        case 'DRILLDOWN_CTAS': {
            const cfg = widget.config as {
                entries?: ReadonlyArray<'controls' | 'risks' | 'evidence'>;
            };
            title = widget.title ?? t('widgets.drilldown');
            body = (
                <DrillDownCtas
                    summary={data.summary}
                    orgSlug={data.orgSlug}
                    entries={cfg.entries}
                />
            );
            break;
        }
    }

    return (
        <DashboardWidget
            title={title}
            actions={actionsSlot}
            data-widget-id={widget.id}
            id={domId}
            showResizeHandle={Boolean(actionsSlot)}
        >
            {body}
        </DashboardWidget>
    );
}
