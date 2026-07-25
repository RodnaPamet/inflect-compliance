'use client';
import Link from 'next/link';
import { useCallback, useMemo } from 'react';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck, AlertTriangle, Cpu, Flame } from 'lucide-react';
import DonutChart from '@/components/ui/DonutChart';
import { DataTable, createColumns } from '@/components/ui/table';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, textLinkVariants } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { KPIStat } from '@/components/ui/metric';
import { getStatusTone } from '@/lib/design/status-tone';
import { useRiskMatrixConfig } from '@/lib/hooks/use-risk-matrix-config';
import { resolveBandTone, type RiskSeverityTone } from '@/lib/risk-matrix/scoring';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { cn } from '@/lib/cn';

// ─── Types ──────────────────────────────────────────────────────────

interface CoverageData {
    totalRisks: number;
    totalControls: number;
    totalAssets: number;
    risksWithControlsCount: number;
    risksWithControlsPct: number;
    controlsWithRisksCount: number;
    controlsWithRisksPct: number;
    assetsWithControlsCount: number;
    assetsWithControlsPct: number;
    // PR-D — controls embedded in an operational process map.
    controlsWithProcessCount: number;
    controlsWithProcessPct: number;
    unmappedRisks: Array<{ id: string; title: string; score: number; status: string }>;
    uncoveredCriticalAssets: Array<{ id: string; name: string; type: string; criticality: string }>;
    hotControls: Array<{ id: string; code?: string; name: string; riskCount: number }>;
}

interface CoverageClientProps {
    data: CoverageData;
    tenantSlug: string;
}

// Row element types for the two coverage sub-tables — derived from
// CoverageData so there's a single source of truth.
type UnmappedRiskRow = CoverageData['unmappedRisks'][number];
type UncoveredAssetRow = CoverageData['uncoveredCriticalAssets'][number];

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Elevation PR-7 — DonutChart segments now consume CSS-var tokens
 * directly. SVG `stroke` and `fill` accept `var(...)` natively so a
 * theme flip re-tones every chart automatically. Returns a string
 * suitable for the DonutChart `color` prop.
 */
function pctColor(pct: number): string {
    if (pct >= 80) return 'var(--bg-success-emphasis)';
    if (pct >= 50) return 'var(--bg-warning-emphasis)';
    return 'var(--bg-error-emphasis)';
}

function pctTextClass(pct: number): string {
    return getStatusTone(pct, 'pct-0-100').content;
}

// Risk-score severity → text-content class. The tone itself comes from
// the tenant's matrix bands (resolveBandTone), so the unmapped-risks
// mini-table colours a score the same way the register does.
const RISK_TONE_TEXT_CLASS: Record<RiskSeverityTone, string> = {
    default: 'text-content-muted',
    success: 'text-content-success',
    attention: 'text-content-warning',
    critical: 'text-content-error',
};

function statusBadge(status: string): StatusBadgeVariant {
    const colors: Record<string, StatusBadgeVariant> = {
        OPEN: 'warning',
        MITIGATING: 'info',
        CLOSED: 'success',
        ACCEPTED: 'neutral',
    };
    return colors[status] || 'neutral';
}

function critBadge(crit: string): StatusBadgeVariant {
    const colors: Record<string, StatusBadgeVariant> = {
        HIGH: 'error',
        MEDIUM: 'warning',
        LOW: 'success',
    };
    return colors[crit] || 'neutral';
}

// ─── Component ──────────────────────────────────────────────────────

export function CoverageClient({ data, tenantSlug }: CoverageClientProps) {
    const t = useTranslations('coverage');
    const tenantHref = useTenantHref();
    const router = useRouter();
    const { config: matrixConfig } = useRiskMatrixConfig();

    // ── Column definitions ────────────────────────────────────────

    const unmappedRiskCols = useMemo(() => createColumns<UnmappedRiskRow>([
        {
            accessorKey: 'title',
            header: t('colRisk'),
            cell: ({ getValue }) => (
                <span className="font-medium text-content-emphasis">{getValue()}</span>
            ),
        },
        {
            accessorKey: 'score',
            header: t('colScore'),
            cell: ({ getValue }) => {
                const score = getValue() as number;
                const tone = resolveBandTone(score, matrixConfig.bands).tone;
                return (
                    <span className={`text-sm font-semibold tabular-nums ${RISK_TONE_TEXT_CLASS[tone]}`}>
                        {score}
                    </span>
                );
            },
        },
        {
            accessorKey: 'status',
            header: t('colStatus'),
            cell: ({ getValue }) => (
                <StatusBadge variant={statusBadge(getValue())}>
                    {String(getValue()).replace(/_/g, ' ')}
                </StatusBadge>
            ),
        },
    ]), [t, matrixConfig]);

    // Stable table-model identities — a fresh identity here rebuilds
    // the table model mid-double-click and kills row navigation (#1678).
    const getUncoveredAssetRowId = useCallback((a: UncoveredAssetRow) => a.id, []);
    const getUnmappedRiskRowId = useCallback((r: UnmappedRiskRow) => r.id, []);
    const handleUncoveredAssetRowClick = useCallback(
        (row: { original: UncoveredAssetRow }) =>
            router.push(tenantHref(`/assets/${row.original.id}`)),
        [router, tenantHref],
    );
    const handleUnmappedRiskRowClick = useCallback(
        (row: { original: UnmappedRiskRow }) =>
            router.push(tenantHref(`/risks/${row.original.id}`)),
        [router, tenantHref],
    );

    const uncoveredAssetCols = useMemo(() => createColumns<UncoveredAssetRow>([
        {
            accessorKey: 'name',
            header: t('colAsset'),
            cell: ({ getValue }) => (
                <span className="font-medium text-content-emphasis">{getValue()}</span>
            ),
        },
        {
            accessorKey: 'type',
            header: t('colType'),
            cell: ({ getValue }) => (
                <StatusBadge variant="info">{String(getValue()).replace(/_/g, ' ')}</StatusBadge>
            ),
        },
        {
            accessorKey: 'criticality',
            header: t('colCriticality'),
            cell: ({ getValue }) => (
                <StatusBadge variant={critBadge(getValue())}>{getValue()}</StatusBadge>
            ),
        },
    ]), [t]);

    return (
        <DashboardLayout
            header={{
                breadcrumbs: [
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumbCoverage') },
                ],
                title: t('title'),
                description: t('description'),
                back: {
                    href: tenantHref('/assets'),
                    label: t('backAssets'),
                },
            }}
        >
            {/* R3-P3 — disambiguate this risk↔control↔asset coverage map from
                the test dashboard's "framework test coverage" (test-plan/run
                coverage) and audit-cycle readiness scores. */}
            <p className="text-xs text-content-muted" id="coverage-disambiguation">
                {t('vsTestCoverage')}{' '}
                <Link href={tenantHref('/tests/dashboard')} className={textLinkVariants({ tone: 'underline' })}>{t('testCoverageLink')}</Link>
            </p>

            {/* ── KPI Strip: 3 Coverage Donuts ────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-default" id="coverage-kpi-strip">
                <CoverageKpiCard
                    id="kpi-assets-covered"
                    icon={<Cpu className="w-5 h-5" />}
                    label={t('kpiAssets')}
                    pct={data.assetsWithControlsPct}
                    covered={data.assetsWithControlsCount}
                    total={data.totalAssets}
                    subtitle={t('subAssets', { covered: data.assetsWithControlsCount, total: data.totalAssets })}
                />
                <CoverageKpiCard
                    id="kpi-risks-mitigated"
                    icon={<AlertTriangle className="w-5 h-5" />}
                    label={t('kpiRisks')}
                    pct={data.risksWithControlsPct}
                    covered={data.risksWithControlsCount}
                    total={data.totalRisks}
                    subtitle={t('subRisks', { covered: data.risksWithControlsCount, total: data.totalRisks })}
                />
                <CoverageKpiCard
                    id="kpi-controls-utilized"
                    icon={<ShieldCheck className="w-5 h-5" />}
                    label={t('kpiControls')}
                    pct={data.controlsWithRisksPct}
                    covered={data.controlsWithRisksCount}
                    total={data.totalControls}
                    subtitle={t('subControls', { covered: data.controlsWithRisksCount, total: data.totalControls })}
                />
            </div>

            {/* ── Summary Bar ─────────────────────────────────────── */}
            <Card id="coverage-summary-bar">
                <Heading level={3} className="mb-4">{t('overall')}</Heading>
                <div className="space-y-compact">
                    <CoverageBar
                        label={t('barAssets')}
                        pct={data.assetsWithControlsPct}
                        detail={`${data.assetsWithControlsCount}/${data.totalAssets}`}
                    />
                    <CoverageBar
                        label={t('barRisks')}
                        pct={data.risksWithControlsPct}
                        detail={`${data.risksWithControlsCount}/${data.totalRisks}`}
                    />
                    <CoverageBar
                        label={t('barControls')}
                        pct={data.controlsWithRisksPct}
                        detail={`${data.controlsWithRisksCount}/${data.totalControls}`}
                    />
                    {/* PR-D — process coverage: controls wired into an
                        operational process map (edge-mounted or node-linked). */}
                    <CoverageBar
                        label={t('barProcess')}
                        pct={data.controlsWithProcessPct}
                        detail={`${data.controlsWithProcessCount}/${data.totalControls}`}
                    />
                </div>
            </Card>

            {/* ── Tables: Gaps ─────────────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                {/* Uncovered Critical Assets */}
                <Card id="uncovered-assets-section">
                    <div className="flex items-center gap-tight mb-4">
                        <Cpu className="w-4 h-4 text-content-error" />
                        <Heading level={3}>
                            {t('uncoveredAssets')}
                        </Heading>
                        {data.uncoveredCriticalAssets.length > 0 && (
                            <StatusBadge variant="error" className="ml-auto">
                                {data.uncoveredCriticalAssets.length}
                            </StatusBadge>
                        )}
                    </div>
                    <DataTable
                        data={data.uncoveredCriticalAssets}
                        columns={uncoveredAssetCols}
                        getRowId={getUncoveredAssetRowId}
                        onRowClick={handleUncoveredAssetRowClick}
                        emptyState={t('emptyAssets')}
                        resourceName={(p) => p ? 'assets' : 'asset'}
                        data-testid="uncovered-assets-table"
                    />
                </Card>

                {/* Unmapped Risks */}
                <Card id="unmapped-risks-section">
                    <div className="flex items-center gap-tight mb-4">
                        <AlertTriangle className="w-4 h-4 text-content-warning" />
                        <Heading level={3}>
                            {t('unmappedRisks')}
                        </Heading>
                        {data.unmappedRisks.length > 0 && (
                            <StatusBadge variant="warning" className="ml-auto">
                                {data.unmappedRisks.length}
                            </StatusBadge>
                        )}
                    </div>
                    <DataTable
                        data={data.unmappedRisks}
                        columns={unmappedRiskCols}
                        getRowId={getUnmappedRiskRowId}
                        onRowClick={handleUnmappedRiskRowClick}
                        emptyState={t('emptyRisks')}
                        resourceName={(p) => p ? 'risks' : 'risk'}
                        data-testid="unmapped-risks-table"
                    />
                </Card>
            </div>

            {/* ── Hot Controls ─────────────────────────────────────── */}
            {data.hotControls.length > 0 && (
                <Card id="hot-controls-section">
                    <div className="flex items-center gap-tight mb-4">
                        <Flame className="w-4 h-4 text-orange-400" />
                        <Heading level={3}>
                            {t('topControls')}
                        </Heading>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-compact">
                        {data.hotControls.map((ctrl, idx) => (
                            <Link
                                key={ctrl.id}
                                href={tenantHref(`/controls/${ctrl.id}`)}
                                className={cn(cardVariants({ density: 'compact' }), 'hover:border-border-emphasis transition-colors duration-150 ease-out group cursor-pointer')}
                            >
                                <div className="flex items-center gap-tight mb-2">
                                    <span className={`
                                        w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
                                        ${idx === 0 ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-content-emphasis' :
                                          idx === 1 ? 'bg-gradient-to-r from-content-muted to-content-subtle text-content-emphasis' :
                                          'bg-bg-elevated text-content-default'}
                                    `}>
                                        {idx + 1}
                                    </span>
                                    {ctrl.code && (
                                        <span className="text-xs font-mono text-[var(--brand-default)]">{ctrl.code}</span>
                                    )}
                                </div>
                                <p className="text-sm font-medium text-content-emphasis group-hover:text-[var(--brand-muted)] transition-colors line-clamp-2">
                                    {ctrl.name}
                                </p>
                                <p className="text-xs text-content-muted mt-1">
                                    {t('mitigates')} <span className="text-content-emphasis font-semibold">{ctrl.riskCount}</span> {ctrl.riskCount === 1 ? t('riskWordOne') : t('riskWordOther')}
                                </p>
                            </Link>
                        ))}
                    </div>
                </Card>
            )}
        </DashboardLayout>
    );
}

// ─── Sub-components ─────────────────────────────────────────────────

function CoverageKpiCard({
    id,
    icon,
    label,
    pct,
    covered,
    total,
    subtitle,
}: {
    id: string;
    icon: React.ReactNode;
    label: string;
    pct: number;
    covered: number;
    total: number;
    subtitle: string;
}) {
    const t = useTranslations('coverage');
    const color = pctColor(pct);

    return (
        <Card className="hover:border-border-emphasis transition-colors duration-150 ease-out" id={id}>
            <div className="flex items-center gap-tight mb-3">
                <span className="text-content-muted">{icon}</span>
                <span className="text-xs text-content-muted uppercase tracking-wide font-medium">
                    {label}
                </span>
            </div>

            <div className="flex items-center gap-default">
                <DonutChart
                    segments={[
                        { label: t('segCovered'), value: covered, color },
                        { label: t('segUncovered'), value: Math.max(0, total - covered), color: 'var(--bg-muted)' },
                    ]}
                    size={100}
                    strokeWidth={14}
                    centerLabel={`${pct}%`}
                    centerSub=""
                    showLegend={false}
                />
                <div className="flex-1 min-w-0">
                    {/* Polish PR-2 — KPIStat primitive replaces the
                        decorative gradient-text treatment. */}
                    <KPIStat
                        value={`${pct}%`}
                        label={subtitle}
                        tone={pct >= 80 ? 'success' : pct >= 50 ? 'attention' : 'critical'}
                    />
                </div>
            </div>
        </Card>
    );
}

function CoverageBar({
    label,
    pct,
    detail,
}: {
    label: string;
    pct: number;
    detail: string;
}) {
    const t = useTranslations('coverage');
    const textClass = pctTextClass(pct);
    // Epic 59 — pick ProgressBar variant by the same score bands the
    // inline Tailwind class list used. Light-mode compatible via
    // token-backed variant colours.
    const variant = pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'error';

    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-content-muted">{label}</span>
                <div className="flex items-center gap-tight">
                    <span className="text-xs text-content-subtle">{detail}</span>
                    <span className={`text-xs font-semibold ${textClass}`}>{pct}%</span>
                </div>
            </div>
            <ProgressBar
                value={Math.min(pct, 100)}
                size="sm"
                variant={variant}
                aria-label={t('barAria', { label })}
            />
        </div>
    );
}
