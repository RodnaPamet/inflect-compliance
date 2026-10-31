'use client';
import Link from 'next/link';
import { useCallback, useMemo } from 'react';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { useTranslations } from 'next-intl';
import { ShieldCheck, AlertTriangle, Cpu, Flame } from 'lucide-react';
import DonutChart from '@/components/ui/DonutChart';
import { DataTable, createColumns } from '@/components/ui/table';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, textLinkVariants } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { KPIStat } from '@/components/ui/metric';
import { readinessBand, readinessTone, readinessVariant, READINESS_BAND_COLOR_VAR } from '@/lib/readiness/bands';
import { useRiskMatrixConfig } from '@/lib/hooks/use-risk-matrix-config';
import { resolveBandTone, type RiskSeverityTone } from '@/lib/risk-matrix/scoring';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { cn } from '@inflect/ui/lib/cn';

// ─── Types ──────────────────────────────────────────────────────────

// The stored vocabularies the gap tables show, worded from
// `coverage.riskStatus.*`, `coverage.assetType.*` and
// `coverage.criticality.*` (#4739: they were printed as stored).
type RiskStatus = 'OPEN' | 'MITIGATING' | 'MITIGATED' | 'ACCEPTED' | 'CLOSED';
type AssetType = 'INFORMATION' | 'SYSTEM' | 'SERVICE' | 'DATA_STORE' | 'VENDOR' | 'PEOPLE_PROCESS' | 'APPLICATION' | 'INFRASTRUCTURE' | 'PROCESS' | 'OTHER';
type Criticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

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
    unmappedRisks: Array<{ id: string; title: string; score: number; status: RiskStatus }>;
    /** How many risks have no control; the list holds at most the first ten (#4739). */
    unmappedRisksTotal: number;
    uncoveredCriticalAssets: Array<{ id: string; name: string; type: AssetType; criticality: Criticality }>;
    /** How many high/critical assets have no control, and how many there are (#4739). */
    uncoveredCriticalAssetsTotal: number;
    totalCriticalAssets: number;
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

// The coverage percentages are read in the readiness bands, from their ONE
// definition (`@/lib/readiness/bands`), not the 80/50 written out here again.
const BAND_TEXT_CLASS = {
    ready: 'text-content-success',
    nearly: 'text-content-warning',
    atRisk: 'text-content-error',
} as const;

// Risk-score severity → text-content class. The tone itself comes from
// the tenant's matrix bands (resolveBandTone), so the unmapped-risks
// mini-table colours a score the same way the register does.
const RISK_TONE_TEXT_CLASS: Record<RiskSeverityTone, string> = {
    default: 'text-content-muted',
    success: 'text-content-success',
    attention: 'text-content-warning',
    critical: 'text-content-error',
};

const RISK_STATUS_VARIANT: Record<RiskStatus, StatusBadgeVariant> = {
    OPEN: 'warning',
    MITIGATING: 'info',
    MITIGATED: 'success',
    CLOSED: 'success',
    ACCEPTED: 'neutral',
};

// #4739 — CRITICAL, the most important row in the table, fell to the grey
// default.
const CRITICALITY_VARIANT: Record<Criticality, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'success',
};

// ─── Component ──────────────────────────────────────────────────────

export function CoverageClient({ data, tenantSlug }: CoverageClientProps) {
    const t = useTranslations('coverage');
    const tenantHref = useTenantHref();
    const guardedPush = useGuardedPush();
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
                <StatusBadge variant={RISK_STATUS_VARIANT[getValue() as RiskStatus] ?? 'neutral'}>
                    {t(`riskStatus.${getValue() as RiskStatus}`)}
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
            guardedPush(tenantHref(`/assets/${row.original.id}`)),
        [guardedPush, tenantHref],
    );
    const handleUnmappedRiskRowClick = useCallback(
        (row: { original: UnmappedRiskRow }) =>
            guardedPush(tenantHref(`/risks/${row.original.id}`)),
        [guardedPush, tenantHref],
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
                <StatusBadge variant="info">{t(`assetType.${getValue() as AssetType}`)}</StatusBadge>
            ),
        },
        {
            accessorKey: 'criticality',
            header: t('colCriticality'),
            cell: ({ getValue }) => (
                <StatusBadge variant={CRITICALITY_VARIANT[getValue() as Criticality] ?? 'neutral'}>{t(`criticality.${getValue() as Criticality}`)}</StatusBadge>
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
                        covered={data.assetsWithControlsCount}
                        total={data.totalAssets}
                    />
                    <CoverageBar
                        label={t('barRisks')}
                        pct={data.risksWithControlsPct}
                        covered={data.risksWithControlsCount}
                        total={data.totalRisks}
                    />
                    <CoverageBar
                        label={t('barControls')}
                        pct={data.controlsWithRisksPct}
                        covered={data.controlsWithRisksCount}
                        total={data.totalControls}
                    />
                    {/* PR-D — process coverage: controls wired into an
                        operational process map (edge-mounted or node-linked). */}
                    <CoverageBar
                        label={t('barProcess')}
                        pct={data.controlsWithProcessPct}
                        covered={data.controlsWithProcessCount}
                        total={data.totalControls}
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
                        {data.uncoveredCriticalAssetsTotal > 0 && (
                            <StatusBadge variant="error" className="ml-auto" id="uncovered-assets-count">
                                {data.uncoveredCriticalAssetsTotal}
                            </StatusBadge>
                        )}
                    </div>
                    <DataTable
                        data={data.uncoveredCriticalAssets}
                        columns={uncoveredAssetCols}
                        getRowId={getUncoveredAssetRowId}
                        onRowClick={handleUncoveredAssetRowClick}
                        // #4739 — "all covered" was said over no critical asset.
                        emptyState={data.totalCriticalAssets === 0 ? t('emptyAssetsNone') : t('emptyAssets')}
                        resourceName={(p) => (p ? t('assetWordOther') : t('assetWordOne'))}
                        data-testid="uncovered-assets-table"
                    />
                    {data.uncoveredCriticalAssetsTotal > data.uncoveredCriticalAssets.length && (
                        <p className="mt-2 text-xs text-content-muted" id="uncovered-assets-more">
                            {t('showingOf', { shown: data.uncoveredCriticalAssets.length, total: data.uncoveredCriticalAssetsTotal })}{' '}
                            <Link href={tenantHref('/assets')} className={textLinkVariants({ tone: 'underline' })}>{t('viewAllAssets')}</Link>
                        </p>
                    )}
                </Card>

                {/* Unmapped Risks */}
                <Card id="unmapped-risks-section">
                    <div className="flex items-center gap-tight mb-4">
                        <AlertTriangle className="w-4 h-4 text-content-warning" />
                        <Heading level={3}>
                            {t('unmappedRisks')}
                        </Heading>
                        {data.unmappedRisksTotal > 0 && (
                            <StatusBadge variant="warning" className="ml-auto" id="unmapped-risks-count">
                                {data.unmappedRisksTotal}
                            </StatusBadge>
                        )}
                    </div>
                    <DataTable
                        data={data.unmappedRisks}
                        columns={unmappedRiskCols}
                        getRowId={getUnmappedRiskRowId}
                        onRowClick={handleUnmappedRiskRowClick}
                        // #4739 — "all mitigated" was said over an empty register.
                        emptyState={data.totalRisks === 0 ? t('emptyRisksNone') : t('emptyRisks')}
                        resourceName={(p) => (p ? t('riskWordOther') : t('riskWordOne'))}
                        data-testid="unmapped-risks-table"
                    />
                    {data.unmappedRisksTotal > data.unmappedRisks.length && (
                        <p className="mt-2 text-xs text-content-muted" id="unmapped-risks-more">
                            {t('showingOf', { shown: data.unmappedRisks.length, total: data.unmappedRisksTotal })}{' '}
                            <Link href={tenantHref('/risks')} className={textLinkVariants({ tone: 'underline' })}>{t('viewAllRisks')}</Link>
                        </p>
                    )}
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
    // #4739 — nothing to cover is not 0% covered: no red ring over an empty
    // population.
    const empty = total === 0;
    const color = empty ? 'var(--bg-muted)' : READINESS_BAND_COLOR_VAR[readinessBand(pct)];

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
                    centerLabel={empty ? '—' : `${pct}%`}
                    centerSub=""
                    showLegend={false}
                />
                <div className="flex-1 min-w-0">
                    {/* Polish PR-2 — KPIStat primitive replaces the
                        decorative gradient-text treatment. */}
                    <KPIStat
                        value={empty ? '—' : `${pct}%`}
                        label={empty ? t('nothingToCover') : subtitle}
                        tone={empty ? 'default' : readinessTone(pct)}
                    />
                </div>
            </div>
        </Card>
    );
}

function CoverageBar({
    label,
    pct,
    covered,
    total,
}: {
    label: string;
    pct: number;
    covered: number;
    total: number;
}) {
    const t = useTranslations('coverage');
    const empty = total === 0;
    const detail = `${covered}/${total}`;
    const textClass = empty ? 'text-content-subtle' : BAND_TEXT_CLASS[readinessBand(pct)];
    // Epic 59 — the ProgressBar variant comes from the readiness bands.
    const variant = empty ? 'neutral' : (readinessVariant(pct) as 'success' | 'warning' | 'error');

    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-content-muted">{label}</span>
                <div className="flex items-center gap-tight">
                    <span className="text-xs text-content-subtle">{detail}</span>
                    <span className={`text-xs font-semibold ${textClass}`}>{empty ? '—' : `${pct}%`}</span>
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
