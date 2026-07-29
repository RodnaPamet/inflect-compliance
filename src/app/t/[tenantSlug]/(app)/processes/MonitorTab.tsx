'use client';

/**
 * Live run monitor (Automation Epic 10).
 *
 * The operator console: a live recent-activity feed (5s refresh, all
 * statuses incl. failures) as the primary surface, a conditional
 * stuck-execution watchdog that only appears when an execution is
 * genuinely hung past its timeout (with a cancel affordance), and the
 * manual trigger panel. The Dynamic-Workflow-Tracker equivalent.
 */
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { formatDateTime } from '@/lib/format-date';
import { ManualTriggerPanel } from '@/components/processes/ManualTriggerPanel';

interface ExecRow {
    id: string;
    ruleName: string;
    triggerEvent: string;
    status: string;
    triggeredBy: string;
    createdAt: string;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    SUCCEEDED: 'success',
    FAILED: 'error',
    RUNNING: 'info',
    PENDING: 'neutral',
    SKIPPED: 'neutral',
};

export function MonitorTab() {
    const t = useTranslations('processes');
    const apiUrl = useTenantApiUrl();
    const key = apiUrl(CACHE_KEYS.automation.executions.live());
    const { data, mutate } = useSWR<{ stuck: ExecRow[]; recent: ExecRow[] }>(
        key,
        (url: string) => fetch(url).then((r) => r.json()),
        { refreshInterval: 5000, revalidateOnFocus: true },
    );

    async function cancel(id: string) {
        await fetch(apiUrl(`/automation/executions/${id}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel' }),
        });
        await mutate();
    }

    const stuck = data?.stuck ?? [];
    const recent = data?.recent ?? [];

    return (
        <div className="grid grid-cols-1 gap-section p-default lg:grid-cols-3">
            <div className="space-y-section lg:col-span-2">
                <Card>
                    <p className="mb-default text-[11px] uppercase tracking-wide text-content-subtle">
                        {t('monitor.recentActivity')}
                    </p>
                    {recent.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('monitor.recentEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight" data-testid="recent-feed">
                            {recent.map((e) => (
                                <li key={e.id} className="flex items-center justify-between gap-default text-sm">
                                    <span className="flex items-center gap-compact">
                                        <StatusBadge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>
                                            {e.status}
                                        </StatusBadge>
                                        <span className="truncate text-content-default">{e.ruleName}</span>
                                    </span>
                                    <span className="shrink-0 text-xs text-content-subtle tabular-nums">
                                        {formatDateTime(e.createdAt)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                {stuck.length > 0 && (
                    <Card>
                        <p className="mb-default text-[11px] uppercase tracking-wide text-content-subtle">
                            {t('monitor.stuckExecutions', { count: stuck.length })}
                        </p>
                        <ul className="space-y-tight" data-testid="stuck-list">
                            {stuck.map((e) => (
                                <li key={e.id} className="flex items-center justify-between gap-default">
                                    <span className="flex items-center gap-compact text-sm">
                                        <StatusBadge variant="warning">{t('monitor.stuck')}</StatusBadge>
                                        <span className="text-content-default">{e.ruleName}</span>
                                    </span>
                                    <Button variant="ghost" size="sm" onClick={() => cancel(e.id)}>
                                        {t('monitor.cancel')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </Card>
                )}
            </div>
            <ManualTriggerPanel />
        </div>
    );
}
