"use client";

/**
 * Epic 41 page rewire — extracted dashboard section primitives.
 *
 * The org overview page used to render `TenantCoverageList` /
 * `DrillDownCtas` / `RagPill` / `CoverageBar` inline. The widget
 * dispatcher (`widget-dispatcher.tsx`) needs them as standalone
 * components to mount inside a `<DashboardWidget>` for `TENANT_LIST`
 * and `DRILLDOWN_CTAS` widget types. The visual / a11y / token
 * choices are unchanged from the prior page — no design drift.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, Layers, Paperclip, ShieldCheck } from 'lucide-react';

import { AnimatedNumber } from '@/components/ui/animated-number';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import type {
    PortfolioSummary,
    RagBadge,
    TenantHealthRow,
} from '@/app-layer/schemas/portfolio';

// ─── Tenant coverage list ──────────────────────────────────────────

export function TenantCoverageList({
    rows,
    sortBy = 'rag',
    limit,
}: {
    rows: TenantHealthRow[];
    sortBy?: 'rag' | 'name' | 'coverage';
    limit?: number;
}) {
    const t = useTranslations('org');
    if (rows.length === 0) {
        return (
            <EmptyState
                icon={Layers}
                title={t('dashboard.emptyTenantsTitle')}
                description={t('dashboard.emptyTenantsDesc')}
            />
        );
    }

    const ragOrder: Record<RagBadge | 'PENDING', number> = {
        RED: 0, AMBER: 1, GREEN: 2, PENDING: 3,
    };
    const sorted = [...rows].sort((a, b) => {
        if (sortBy === 'rag') {
            const ra = ragOrder[a.rag ?? 'PENDING'];
            const rb = ragOrder[b.rag ?? 'PENDING'];
            if (ra !== rb) return ra - rb;
            return a.name.localeCompare(b.name);
        }
        if (sortBy === 'coverage') {
            const ca = a.coveragePercent ?? -1;
            const cb = b.coveragePercent ?? -1;
            if (ca !== cb) return ca - cb;
            return a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
    });
    const visible = limit ? sorted.slice(0, limit) : sorted;

    return (
        <ul
            className="divide-y divide-border-subtle"
            data-testid="org-tenant-coverage-list"
        >
            {visible.map((row) => (
                <li key={row.tenantId} className="py-2">
                    <Link
                        href={row.drillDownUrl}
                        className="flex items-center gap-default hover:bg-bg-muted -mx-3 px-3 py-2 rounded-lg transition-colors group"
                        data-testid={`org-tenant-row-${row.slug}`}
                    >
                        <RagPill rag={row.rag} />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-tight">
                                <span className="text-sm font-medium text-content-emphasis truncate">
                                    {row.name}
                                </span>
                                <span className="text-xs tabular-nums text-content-muted">
                                    {row.coveragePercent !== null ? (
                                        <AnimatedNumber
                                            value={row.coveragePercent}
                                            format={{ kind: 'percent', fractionDigits: 1 }}
                                        />
                                    ) : (
                                        '—'
                                    )}
                                </span>
                            </div>
                            <CoverageBar percent={row.coveragePercent} rag={row.rag} />
                            <div className="mt-1.5 flex items-center gap-default text-xs text-content-muted">
                                <span>{row.openRisks ?? '—'} {t('dashboard.openRisksLower')}</span>
                                <span>{row.criticalRisks ?? 0} {t('dashboard.criticalLower')}</span>
                                <span>{row.overdueEvidence ?? 0} {t('dashboard.overdueEvidenceLower')}</span>
                            </div>
                        </div>
                        <ChevronRight
                            className="w-4 h-4 text-content-subtle group-hover:text-content-emphasis transition-colors"
                            aria-hidden="true"
                        />
                    </Link>
                </li>
            ))}
        </ul>
    );
}

export function RagPill({ rag }: { rag: RagBadge | null }) {
    const t = useTranslations('org');
    if (rag === null) return <StatusBadge variant="neutral">{t('common.pending')}</StatusBadge>;
    const variant: 'success' | 'warning' | 'error' =
        rag === 'GREEN' ? 'success' : rag === 'AMBER' ? 'warning' : 'error';
    // The stored GREEN / AMBER / RED is a code; the pill says what it means
    // (#4842), from the same `org.health` words as the workspaces list.
    return <StatusBadge variant={variant}>{t(`health.${rag}`)}</StatusBadge>;
}

export function CoverageBar({
    percent,
    rag,
}: {
    percent: number | null;
    rag: RagBadge | null;
}) {
    const t = useTranslations('org');
    const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
    const colorClass =
        rag === 'GREEN' ? 'bg-bg-success-emphasis'
        : rag === 'AMBER' ? 'bg-bg-warning-emphasis'
        : rag === 'RED' ? 'bg-bg-error-emphasis'
        : 'bg-border-emphasis';
    return (
        <div className="mt-1 h-1.5 rounded-full bg-bg-muted overflow-hidden">
            <div
                className={`h-full ${colorClass} transition-all`}
                style={{ width: `${width}%` }}
                role="progressbar"
                aria-valuenow={width}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={
                    percent !== null
                        ? t('dashboard.coverageAria', { percent: percent.toFixed(1) })
                        : t('dashboard.coveragePending')
                }
            />
        </div>
    );
}

// ─── Drill-down CTAs ───────────────────────────────────────────────

export function DrillDownCtas({
    summary,
    orgSlug,
    entries,
}: {
    summary: PortfolioSummary;
    orgSlug: string;
    entries?: ReadonlyArray<'controls' | 'risks' | 'evidence'>;
}) {
    const t = useTranslations('org');
    const all = [
        {
            key: 'controls' as const,
            label: t('nav.nonPerformingControls'),
            count: summary.controls.applicable - summary.controls.implemented,
            href: `/org/${orgSlug}/controls`,
            icon: ShieldCheck,
            tone: 'rose',
        },
        {
            key: 'risks' as const,
            label: t('nav.criticalRisks'),
            count: summary.risks.critical,
            href: `/org/${orgSlug}/risks`,
            icon: AlertTriangle,
            tone: 'amber',
        },
        {
            key: 'evidence' as const,
            label: t('nav.overdueEvidence'),
            count: summary.evidence.overdue,
            href: `/org/${orgSlug}/evidence`,
            icon: Paperclip,
            tone: 'orange',
        },
    ] as const;
    const visible = entries
        ? all.filter((cta) => entries.includes(cta.key))
        : all;

    return (
        <div
            className="grid grid-cols-1 sm:grid-cols-3 gap-compact h-full"
            data-testid="org-drilldown-ctas"
        >
            {visible.map((cta) => (
                <Link
                    key={cta.href}
                    href={cta.href}
                    className="rounded-lg border border-border-subtle hover:border-border-default hover:bg-bg-muted/50 transition-colors duration-150 ease-out p-3 group"
                    data-testid={`org-drilldown-${cta.key}`}
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-tight text-content-emphasis">
                            <cta.icon
                                className={`w-4 h-4 text-${cta.tone}-500`}
                                aria-hidden="true"
                            />
                            <span className="font-medium text-xs">{cta.label}</span>
                        </div>
                        <ChevronRight
                            className="w-4 h-4 text-content-subtle group-hover:text-content-emphasis transition-colors"
                            aria-hidden="true"
                        />
                    </div>
                    <p className="mt-2 text-xl font-bold text-content-emphasis tabular-nums">
                        <AnimatedNumber
                            value={cta.count}
                            format={{ kind: 'integer' }}
                        />
                    </p>
                    <p className="text-xs text-content-muted">
                        {cta.count === 1 ? t('dashboard.item') : t('dashboard.items')} {t('dashboard.acrossThePortfolio')}
                    </p>
                </Link>
            ))}
        </div>
    );
}
