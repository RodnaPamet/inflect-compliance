'use client';

/**
 * PR-1 — Automated-checks tab for the control detail page.
 *
 * Surfaces the `IntegrationExecution` history for a control whose evidence
 * source is INTEGRATION (an `automationKey` + `frequency`). The
 * `automation-runner` cron writes one execution per due check
 * (PASSED / FAILED / ERROR), auto-materializes evidence, and — since PR-1
 * — opens a de-duplicated Finding on FAILED. This tab is the read surface
 * for that loop: latest status up top, full recent history below.
 *
 * Self-fetching (mirrors TestPlansPanel) via the per-tab lazy SWR key, so
 * nothing loads until the user opens the tab.
 */
import { useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { cardVariants } from '@/components/ui/card';
import { formatDateTime } from '@inflect/ui/lib/format-date';

interface ExecutionRow {
    id: string;
    provider: string;
    automationKey: string;
    status: 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR' | 'NOT_APPLICABLE';
    resultJson: Record<string, unknown> | null;
    durationMs: number | null;
    triggeredBy: string | null;
    errorMessage: string | null;
    executedAt: string | null;
    completedAt: string | null;
}

function statusVariant(status: ExecutionRow['status']): StatusBadgeVariant {
    switch (status) {
        case 'PASSED':
            return 'success';
        case 'FAILED':
            return 'error';
        case 'ERROR':
            return 'warning';
        case 'NOT_APPLICABLE':
            // H2 — "no applicable data" reads distinctly from a green PASS.
            return 'neutral';
        default:
            return 'info';
    }
}

// R2-P4 — humanize the raw check-status enum. Reuses the localized labels
// P2 added under controls.health.checkStatus.*; unknown statuses fall back to
// the raw value so a new enum member never crashes the render.
const HUMANIZED_CHECK_STATUSES = new Set([
    'PASSED', 'FAILED', 'ERROR', 'NOT_APPLICABLE', 'PENDING', 'RUNNING',
]);

/** Compact one-line summary of a run's structured result. */
function resultSummary(row: ExecutionRow): string {
    if (row.status === 'ERROR') return row.errorMessage || '—';
    const d = row.resultJson;
    if (d && typeof d === 'object') {
        if (typeof d.summary === 'string' && d.summary) return d.summary;
        // Common per-item shape: {passed, failed, total}.
        const passed = typeof d.passed === 'number' ? d.passed : undefined;
        const failed = typeof d.failed === 'number' ? d.failed : undefined;
        if (passed !== undefined || failed !== undefined) {
            return `${passed ?? 0} passed · ${failed ?? 0} failed`;
        }
    }
    return '—';
}

export function ControlChecksTab({ controlId }: { controlId: string }) {
    const t = useTranslations('controls');
    const humanizeStatus = useCallback(
        (s: string) =>
            HUMANIZED_CHECK_STATUSES.has(s)
                ? t(`health.checkStatus.${s}` as Parameters<typeof t>[0])
                : s,
        [t],
    );
    const { data, isLoading } = useTenantSWR<{ executions: ExecutionRow[] }>(
        CACHE_KEYS.controls.executions(controlId),
    );
    const rows = data?.executions ?? [];
    const latest = rows[0];

    const columns = useMemo(
        () =>
            createColumns<ExecutionRow>([
                {
                    id: 'check',
                    header: t('checksTab.colCheck'),
                    cell: ({ row }) => (
                        <span className="text-xs font-mono text-content-default">
                            {row.original.automationKey}
                        </span>
                    ),
                },
                {
                    id: 'status',
                    header: t('checksTab.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={statusVariant(row.original.status)}>
                            {humanizeStatus(row.original.status)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'result',
                    header: t('checksTab.colResult'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">{resultSummary(row.original)}</span>
                    ),
                },
                {
                    id: 'lastRun',
                    header: t('checksTab.colLastRun'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.executedAt ? formatDateTime(row.original.executedAt) : '—'}
                        </span>
                    ),
                },
                {
                    id: 'trigger',
                    header: t('checksTab.colTrigger'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">{row.original.triggeredBy || '—'}</span>
                    ),
                },
            ]),
        [t, humanizeStatus],
    );

    if (!isLoading && rows.length === 0) {
        return (
            <div id="no-checks">
                <InlineEmptyState
                    title={t('checksTab.emptyTitle')}
                    description={t('checksTab.emptyDesc')}
                />
            </div>
        );
    }

    return (
        <div className="space-y-default">
            {/* PR-P (Prompt 1.3) — honest labeling. These are control-scoped
                automated monitoring checks (keyed to the control's automationKey),
                NOT plan test runs. They feed control health + open Findings on
                FAILED, but they are separate telemetry and do NOT count toward the
                test-run effectiveness pass-rate shown on the plan/run surfaces. */}
            <p id="checks-telemetry-note" className="text-xs text-content-subtle">
                {t('checksTab.telemetryNote')}
            </p>
            {latest && (
                <div className={cardVariants({ density: 'compact' })}>
                    <div className="flex items-center justify-between gap-default">
                        <div>
                            <span className="text-xs text-content-subtle uppercase">
                                {t('checksTab.latestStatus')}
                            </span>
                            <div className="mt-1 flex items-center gap-tight">
                                <StatusBadge variant={statusVariant(latest.status)}>
                                    {humanizeStatus(latest.status)}
                                </StatusBadge>
                                <span className="text-xs font-mono text-content-muted">
                                    {latest.automationKey}
                                </span>
                            </div>
                        </div>
                        <span className="text-xs text-content-muted">
                            {latest.executedAt ? formatDateTime(latest.executedAt) : '—'}
                        </span>
                    </div>
                </div>
            )}
            <div id="checks-table">
                <DataTable
                    data={rows}
                    columns={columns}
                    getRowId={(r) => r.id}
                    loading={isLoading}
                    selectionEnabled={false}
                />
            </div>
        </div>
    );
}
