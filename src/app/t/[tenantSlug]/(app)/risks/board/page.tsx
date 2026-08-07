/**
 * RQ3-10 — Risk Board page.
 *
 * The board-altitude view of the risk program. Where the dashboard
 * (RQ3-9) is the daily analyst surface — every signal, every chart —
 * the board page strips down to the five questions an exec actually
 * asks:
 *
 *   1. Position — what's our annual loss exposure?
 *   2. Appetite — are we inside the band the board agreed?
 *   3. Top contributors — which 5 risks drive the tail?
 *   4. Efficiency — what's our best € of control spend buying?
 *   5. Hygiene — what fraction of the register is currently rotten?
 *
 * The page consumes the SAME orchestrator the dashboard does
 * (RQ3-9 was the prerequisite for this) plus the RQ3-8 best-value
 * endpoint. No new server endpoint — the data is already batched.
 *
 * Honest-null everywhere: each card carries its own typed
 * empty-state copy. A board pack with "Not quantified yet" is more
 * honest — and more actionable — than one with a fabricated zero.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantHref, useTenantContext, useMoneyFormatter } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge } from '@/components/ui/status-badge';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { SkeletonDashboard } from '@/components/ui/skeleton';
import { RiskFirstRunEmpty } from '@/components/risks/RiskFirstRunEmpty';
import { buttonVariants } from '@/components/ui/button-variants';
import { formatTailAwareAle } from '@/lib/tail-language';
import type { DashboardPayload } from '@/app-layer/usecases/risk-dashboard';

interface BestValueRow {
    controlId: string;
    code: string | null;
    name: string;
    annualCost: number;
    effectiveness: number;
    aleProtected: number;
    roiMultiple: number;
    quantifiedRiskCount: number;
    linkedRiskCount: number;
}

const APPETITE_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
    WITHIN: 'success',
    APPROACHING: 'warning',
    BREACHED: 'error',
    NONE: 'neutral',
};

// Enum → translation-key map; resolved through `t` at render (the
// English copy lives in the riskManager.board.* catalog).
const APPETITE_KEY: Record<string, string> = {
    WITHIN: 'board.within',
    APPROACHING: 'board.approaching',
    BREACHED: 'board.breached',
    NONE: 'board.noAppetite',
};

export default function RiskBoardPage() {
    const href = useTenantHref();
    const tenant = useTenantContext();
    const t = useTranslations('riskManager');
    const money = useMoneyFormatter();

    // RQ3-9 — one orchestrated fetch for risks/analytics/coherence/
    // staleness/appetite/simulation/matrix.
    const { data, isLoading } = useTenantSWR<DashboardPayload>('/risks/dashboard');
    // RQ3-8 — best-value controls leaderboard. Capped at 3 for the
    // board view (the dashboard list takes 5).
    const { data: bestValue } = useTenantSWR<BestValueRow[]>('/controls/best-value?limit=3');

    if (isLoading || !data) return <SkeletonDashboard />;

    const { risks, analytics, staleness, appetite, simulation } = data;
    const simRun = simulation;

    // ── Position ────────────────────────────────────────────────────
    const headlineAle = simRun?.portfolioP80 ?? null;
    const headlineLabel = simRun ? t('board.aleP80') : t('board.ale');

    // ── Top 5 by tail-aware ALE ─────────────────────────────────────
    // perRiskResultsJson is a JSON column on the persisted run; the
    // shape matches `SimulationRun.perRiskResultsJson` from the
    // MonteCarloPanel — narrow it locally.
    const perRiskRows = (
        simRun?.perRiskResultsJson as unknown as
            | { riskId: string; aleP90?: number }[]
            | null
            | undefined
    ) ?? [];
    const tailByRisk = new Map<string, number>();
    for (const e of perRiskRows) {
        if (e.aleP90 != null) tailByRisk.set(e.riskId, e.aleP90);
    }
    const topRisks = (analytics?.topByAle ?? []).slice(0, 5);

    // ── Hygiene ─────────────────────────────────────────────────────
    const totalCount = risks.length;
    const staleCount = staleness?.staleCount ?? 0;
    const stalePct = totalCount > 0 ? Math.round((staleCount / totalCount) * 100) : 0;

    // ── Appetite chip ───────────────────────────────────────────────
    const appetiteStatus = appetite?.status?.status ?? 'NONE';
    const appetiteVariant = APPETITE_VARIANT[appetiteStatus];
    const appetiteCopy = t(APPETITE_KEY[appetiteStatus] ?? 'board.noAppetite');

    return (
        <DashboardLayout
            header={{
                back: { smart: true },
                title: t('board.title'),
                description: t('board.description', { tenant: tenant.tenantName }),
                actions: (
                    <Link
                        href={href('/risks/dashboard')}
                        className={buttonVariants({ variant: 'secondary' })}
                        id="back-to-dashboard"
                    >
                        {t('board.operationalDashboard')}
                    </Link>
                ),
            }}
        >
            {/* ── 1. Position headline ──────────────────────────────── */}
            <Card data-testid="board-position-card">
                <Heading level={2} className="mb-2">{t('board.position')}</Heading>
                {headlineAle !== null ? (
                    <>
                        <KPIStat
                            value={money(headlineAle)}
                            label={headlineLabel}
                            tone={appetiteVariant === 'error' ? 'critical' : appetiteVariant === 'warning' ? 'attention' : 'success'}
                        />
                        <p className="mt-default text-sm text-content-muted">
                            {t('board.positionBody')}
                        </p>
                    </>
                ) : (
                    <p
                        className="text-sm text-content-warning"
                        data-testid="board-position-empty"
                    >
                        {t('board.positionEmpty')}
                    </p>
                )}
            </Card>

            {/* ── 2. Appetite chip ─────────────────────────────────── */}
            <Card data-testid="board-appetite-card">
                <Heading level={2} className="mb-2">{t('board.appetite')}</Heading>
                <div className="flex items-baseline gap-default">
                    <StatusBadge variant={appetiteVariant} data-testid="board-appetite-chip">
                        {appetiteCopy}
                    </StatusBadge>
                    {appetite?.config?.totalAleThreshold != null && (
                        <span className="text-sm text-content-muted">
                            {t('board.ceiling', { amount: money(appetite.config.totalAleThreshold) })}
                        </span>
                    )}
                </div>
                {appetiteStatus === 'NONE' && (
                    <p
                        className="mt-default text-sm text-content-subtle"
                        data-testid="board-appetite-empty"
                    >
                        {t('board.appetiteEmpty')}
                    </p>
                )}
            </Card>

            {/* ── 3. Top 5 contributors ─────────────────────────────── */}
            <Card data-testid="board-top-risks-card">
                <Heading level={2} className="mb-2">{t('board.topContributors')}</Heading>
                {topRisks.length === 0 ? (
                    <p
                        className="text-sm text-content-subtle"
                        data-testid="board-top-risks-empty"
                    >
                        {t('board.topEmpty')}
                    </p>
                ) : (
                    <ol className="space-y-tight" data-testid="board-top-risks-list">
                        {topRisks.map((row, idx) => (
                            <li
                                key={row.id}
                                className="flex items-baseline gap-tight"
                                data-testid={`board-top-risk-${row.id}`}
                            >
                                <span className="w-6 text-content-subtle text-xs tabular-nums">{idx + 1}.</span>
                                <Link
                                    href={href(`/risks/${row.id}?tab=assessment`)}
                                    className="flex-1 truncate text-content-emphasis hover:text-content-default"
                                >
                                    {row.title}
                                </Link>
                                <span className="shrink-0 tabular-nums text-content-muted">
                                    {formatTailAwareAle(row.ale, tailByRisk.get(row.id) ?? null, { money, compact: true })}
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </Card>

            {/* ── 4. Investment efficiency (RQ3-8) ─────────────────── */}
            <Card data-testid="board-best-value-card">
                <Heading level={2} className="mb-2">{t('board.bestValue')}</Heading>
                {!bestValue || bestValue.length === 0 ? (
                    <p
                        className="text-sm text-content-subtle"
                        data-testid="board-best-value-empty"
                    >
                        {t('board.bestValueEmpty')}
                    </p>
                ) : (
                    <ol className="space-y-tight" data-testid="board-best-value-list">
                        {bestValue.map((row, idx) => (
                            <li
                                key={row.controlId}
                                className="flex items-baseline gap-tight"
                                data-testid={`board-best-value-row-${row.controlId}`}
                            >
                                <span className="w-6 text-content-subtle text-xs tabular-nums">{idx + 1}.</span>
                                <Link
                                    href={href(`/controls/${row.controlId}`)}
                                    className="flex-1 truncate text-content-emphasis hover:text-content-default"
                                >
                                    {row.code ? `${row.code} — ${row.name}` : row.name}
                                </Link>
                                <span className="shrink-0 tabular-nums text-content-emphasis">
                                    {row.roiMultiple.toFixed(1)}×
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </Card>

            {/* ── 5. Hygiene ─────────────────────────────────────────── */}
            <Card data-testid="board-hygiene-card">
                <Heading level={2} className="mb-2">{t('board.hygiene')}</Heading>
                {totalCount === 0 ? (
                    <div data-testid="board-hygiene-empty">
                        <RiskFirstRunEmpty size="sm" />
                    </div>
                ) : (
                    <p className="text-sm text-content-default">
                        {t.rich('board.hygieneBody', {
                            stale: staleCount,
                            total: totalCount,
                            pct: stalePct,
                            b: (c) => <strong>{c}</strong>,
                            pctspan: (c) => <span data-testid="board-hygiene-pct">{c}</span>,
                        })}
                    </p>
                )}
                {staleCount === 0 && totalCount > 0 && (
                    <p className="mt-tight text-sm text-content-success" data-testid="board-hygiene-all-fresh">
                        {t('board.hygieneAllFresh')}
                    </p>
                )}
            </Card>

            {/* Pretend-suppressed link for translation key resolution. */}
            <span className="hidden">{t('dashboardTitle')}</span>
        </DashboardLayout>
    );
}
