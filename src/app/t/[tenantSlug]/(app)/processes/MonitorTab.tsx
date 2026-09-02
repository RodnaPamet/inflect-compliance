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
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { formatDateTime } from '@/lib/format-date';
import { ManualTriggerPanel } from '@/components/processes/ManualTriggerPanel';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';
import { buildExecutionStatusLabels } from '@/lib/automation/execution-status-labels';

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
    // The execution-status vocabulary lives in `automation.executions` because
    // ExecutionsPanel owns it; this feed renders the SAME rows one click away
    // and used to print the raw enum beside the panel's readable labels.
    const tExec = useTranslations('automation.executions');
    const statusLabels = buildExecutionStatusLabels(
        (k) => tExec(k as Parameters<typeof tExec>[0]),
    );
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    // #2222 — `useTenantSWR`, not a bare `useSWR` with a hand-rolled fetcher.
    // Three things come with the swap, and the third is why it happened:
    //   • `errorRetryCount: 2`. SWR's own default is UNBOUNDED (`defaultConfig`
    //     never sets the key, and `onErrorRetry` returns early only when it is
    //     defined), so this feed used to retry forever with backoff — one
    //     request every 10-21 minutes for the life of the tab, plus a fresh
    //     burst on every window focus.
    //   • `apiGet` as the fetcher, which throws a typed `ApiClientError`
    //     carrying `.status` instead of an `Error` whose only record of the
    //     status is inside its message string.
    //   • that `.status` is what the app-wide 401 seam reads. A hand-rolled
    //     fetcher over raw `fetch` is invisible to it, so an expired session
    //     rendered this operator console as an empty "recent activity" feed —
    //     which is the exact misreport the old fetcher's comment existed to
    //     prevent, arrived at by a different route.
    // `error` is now READ (below). The previous code destructured only
    // `{ data, mutate }`, so nothing consumed what the throw produced.
    const { data, error, mutate } = useTenantSWR<{
        stuck: ExecRow[];
        recent: ExecRow[];
    }>(CACHE_KEYS.automation.executions.live(), {
        refreshInterval: 5000,
        // `dedupingInterval` must be BELOW `refreshInterval` or the poll
        // silently halves. `DEFAULT_SWR_CONFIG` sets it to 5000 for list
        // pages that mount several hooks on one key; SWR arms
        // `setTimeout(cleanupState, dedupingInterval)` only after the fetch
        // resolves, and the polling `execute()` revalidates WITH_DEDUPE — so
        // the tick at t=5000 finds the entry still present, dedupes, and
        // issues nothing. Real requests would land at ~0s, 10s, 20s while the
        // code, the guard grepping for `5000`, and this operator console all
        // said five seconds. The bare `useSWR` this replaced got 5s because
        // SWR's own default deduping is 2000.
        dedupingInterval: 2000,
    });

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
                    {error && !data ? (
                        // #2222 — an unreachable feed is not an empty feed. On a
                        // compliance console "no recent executions" reads as a
                        // fact about the tenant's automation, so a failure that
                        // renders as emptiness is a misreport, not a blank.
                        <p
                            className="text-sm text-content-muted"
                            data-testid="monitor-feed-unavailable"
                        >
                            {t('monitor.feedUnavailable')}
                        </p>
                    ) : recent.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('monitor.recentEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight" data-testid="recent-feed">
                            {recent.map((e) => (
                                <li key={e.id} className="flex items-center justify-between gap-default text-sm">
                                    <span className="flex items-center gap-compact">
                                        <StatusBadge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>
                                            {statusLabels[e.status] ?? e.status}
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
