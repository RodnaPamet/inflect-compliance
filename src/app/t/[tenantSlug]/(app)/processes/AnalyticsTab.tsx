'use client';

/**
 * Automation analytics tab (Automation Epic 9).
 *
 * Near-real-time visibility into automation health: rule counts, execution
 * volume over time, success/error rates, SLA breaches, and the most-fired
 * rules. Reads the aggregated /automation/analytics endpoint.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { KPIStat } from '@/components/ui/metric';
import { MiniAreaChart } from '@/components/ui/mini-area-chart';
import type { TimeSeriesPoint } from '@/components/ui/charts';

interface Analytics {
    totalRules: number;
    enabledRules: number;
    windowDays: number;
    executions: Array<{ date: string; succeeded: number; failed: number; skipped: number }>;
    topRules: Array<{ ruleId: string; name: string; count: number; successRate: number }>;
    slaBreaches: number;
    avgDurationMs: number;
    /** Both over TERMINAL runs only — see AutomationAnalytics on the server. */
    successRate: number;
    errorRate: number;
    totalExecutions: number;
    terminalExecutions: number;
    /** The server capped the window at MAX_ROWS; every KPI below undercounts. */
    truncated: boolean;
}

const WINDOWS = [7, 30, 90] as const;

function Stat({ label, value }: { label: string; value: string | number }) {
    // Numbers flow through KPIStat (locks tabular-nums + the single metric
    // typographic register — metric-typography ratchet).
    return (
        <Card>
            <KPIStat label={label} value={value} size="md" />
        </Card>
    );
}

export function AnalyticsTab() {
    const t = useTranslations('processes');
    const [days, setDays] = useState<number>(30);
    const { data, isLoading, error, mutate } = useTenantSWR<Analytics>(
        `${CACHE_KEYS.automation.analytics()}?days=${days}`,
    );

    const series: TimeSeriesPoint[] = useMemo(
        () =>
            (data?.executions ?? []).map((e) => ({
                date: new Date(e.date),
                value: e.succeeded + e.failed + e.skipped,
            })),
        [data],
    );

    // Without this branch a failed fetch left `data` undefined, the
    // totalRules === 0 guard below never fired, and the KPI row rendered
    // "0/0 · 100% success · 0ms" — invented numbers presented as fact, on the
    // one screen whose entire purpose is to be trusted.
    if (error) {
        return (
            <div className="p-default" data-testid="automation-analytics-error">
                <ErrorState
                    title={t('analytics.errorTitle')}
                    description={t('analytics.errorDesc')}
                    onRetry={() => mutate()}
                    retryLabel={t('analytics.retry')}
                />
            </div>
        );
    }

    if (!isLoading && data && data.totalRules === 0) {
        return (
            <div className="p-default">
                <EmptyState
                    title={t('analytics.emptyTitle')}
                    description={t('analytics.emptyDesc')}
                />
            </div>
        );
    }

    return (
        <div className="space-y-section p-default" data-testid="automation-analytics">
            <div className="flex gap-tight">
                {WINDOWS.map((w) => (
                    <button
                        key={w}
                        type="button"
                        onClick={() => setDays(w)}
                        className={`rounded-full px-2.5 py-0.5 text-xs ${days === w ? 'bg-bg-inverted text-content-inverted' : 'bg-bg-muted text-content-muted'}`}
                    >
                        {w}d
                    </button>
                ))}
            </div>

            {data?.truncated && (
                <InlineNotice variant="warning">
                    {t('analytics.truncated', { days })}
                </InlineNotice>
            )}

            <div className="grid grid-cols-2 gap-default md:grid-cols-3 lg:grid-cols-6">
                <Stat label={t('analytics.enabledRules')} value={`${data?.enabledRules ?? 0}/${data?.totalRules ?? 0}`} />
                <Stat label={t('analytics.executions', { days })} value={data?.totalExecutions ?? 0} />
                <Stat label={t('analytics.successRate')} value={`${data?.successRate ?? 0}%`} />
                <Stat label={t('analytics.avgDuration')} value={`${data?.avgDurationMs ?? 0}ms`} />
                <Stat label={t('analytics.stuckExecutionBreaches')} value={data?.slaBreaches ?? 0} />
                <Stat label={t('analytics.errorRate')} value={`${data?.errorRate ?? 0}%`} />
            </div>

            <Card>
                <p className="mb-default text-[11px] uppercase tracking-wide text-content-subtle">
                    {t('analytics.executionsOverTime')}
                </p>
                {series.length >= 2 ? (
                    <div className="h-40 w-full">
                        <MiniAreaChart data={series} variant="brand" aria-label={t('analytics.executionsOverTime')} className="h-full w-full" />
                    </div>
                ) : (
                    <p className="text-sm text-content-muted">{t('analytics.notEnoughData')}</p>
                )}
            </Card>

            <Card>
                <p className="mb-default text-[11px] uppercase tracking-wide text-content-subtle">
                    {t('analytics.mostFired')}
                </p>
                {data && data.topRules.length > 0 ? (
                    <ul className="space-y-tight">
                        {data.topRules.map((r) => (
                            <li key={r.ruleId} className="flex items-center justify-between gap-default text-sm">
                                <span className="truncate text-content-default">{r.name}</span>
                                <span className="shrink-0 tabular-nums text-content-muted">
                                    {t('analytics.runsOk', { count: r.count, rate: r.successRate })}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-content-muted">{t('analytics.executionsEmpty')}</p>
                )}
            </Card>
        </div>
    );
}
