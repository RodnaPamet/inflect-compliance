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
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';

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
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    const key = apiUrl(CACHE_KEYS.automation.executions.live());
    const { data, mutate } = useSWR<{ stuck: ExecRow[]; recent: ExecRow[] }>(
        key,
        // `.then(r => r.json())` alone swallows the status: a 403 or 500 body
        // parses into an object with no `stuck`/`recent`, and the panel renders
        // as merely empty. Throwing lets SWR expose `error`.
        async (url: string) => {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`live feed ${r.status}`);
            return r.json();
        },
        { refreshInterval: 5000, revalidateOnFocus: true },
    );

    async function cancel(id: string) {
        const res = await fetch(apiUrl(`/automation/executions/${id}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel' }),
        });
        if (!res.ok) {
            toast.error(t('monitor.cancelFailed'));
            return;
        }
        toast.success(t('monitor.cancelDone'));
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
                                    {/* Cancel cannot recall an action already
                                        in flight — no cooperative abort exists
                                        for an outbound webhook. What it DOES do
                                        is settle the row as cancelled (the
                                        dispatcher's completion write is now
                                        scoped to RUNNING, so it no longer
                                        overwrites the operator) and stop the
                                        downstream chain. The tooltip says so
                                        rather than letting the verb imply more
                                        than it delivers. */}
                                    <Tooltip content={t('monitor.cancelHint')}>
                                        <Button variant="ghost" size="sm" onClick={() => cancel(e.id)}>
                                            {t('monitor.cancel')}
                                        </Button>
                                    </Tooltip>
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
