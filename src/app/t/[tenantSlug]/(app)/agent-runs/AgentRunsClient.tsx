'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

export interface RunRow {
    id: string;
    workflowKey: string;
    status: string;
    stepCount: number;
    costTokens: number;
    startedAt: string;
    completedAt: string | null;
    summary: string | null;
}

interface WorkflowOption {
    key: string;
    name: string;
    description: string;
}

const STATUS_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'error' | 'neutral'> = {
    RUNNING: 'info',
    AWAITING_APPROVAL: 'warning',
    PAUSED: 'warning',
    COMPLETED: 'success',
    ABORTED: 'neutral',
    FAILED: 'error',
};

/**
 * The agent-runs client. Lists runs with live status + cost, lets an operator
 * start a workflow, resume an AWAITING_APPROVAL run (after acting on its
 * proposals in the agent-proposals queue), or abort an in-flight run.
 */
export function AgentRunsClient({
    initialRuns,
    workflows,
}: {
    tenantSlug: string;
    initialRuns: RunRow[];
    workflows: WorkflowOption[];
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [runs, setRuns] = useState(initialRuns);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        const res = await fetch(apiUrl('/agent-runs'));
        if (res.ok) setRuns((await res.json()) as RunRow[]);
    }

    async function start(workflowKey: string) {
        setBusy('start');
        setError(null);
        try {
            const res = await fetch(apiUrl('/agent-runs'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workflowKey }),
            });
            if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } })?.error?.message ?? t('runs.startFailed'));
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('runs.startFailed'));
        } finally {
            setBusy(null);
        }
    }

    async function act(id: string, action: 'resume' | 'abort') {
        setBusy(id);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/agent-runs/${id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } })?.error?.message ?? t(`runs.${action}Failed`));
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t(`runs.${action}Failed`));
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumbAdmin'), href: tenantHref('/admin') },
                    { label: t('crumbMcp'), href: tenantHref('/admin/mcp') },
                    { label: t('runs.crumb') },
                ]}
                title={t('runs.title')}
                description={t('runs.description')}
            />

            {workflows.length > 0 && (
                <div className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}>
                    <p className="text-sm font-medium text-content-emphasis">{t('runs.startWorkflow')}</p>
                    <div className="flex flex-wrap gap-tight">
                        {workflows.map((w) => (
                            <Button
                                key={w.key}
                                variant="secondary"
                                size="sm"
                                disabled={busy === 'start'}
                                onClick={() => start(w.key)}
                                title={w.description}
                            >
                                {w.name}
                            </Button>
                        ))}
                    </div>
                </div>
            )}

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')}>{error}</div>
            )}

            {runs.length === 0 ? (
                <EmptyState
                    title={t('runs.emptyTitle')}
                    description={t('runs.emptyDesc')}
                />
            ) : (
                <ul className="space-y-default">
                    {runs.map((r) => (
                        <li key={r.id} id={`run-${r.id}`} className={cn(cardVariants({ density: 'comfortable' }), 'space-y-tight')}>
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    <StatusBadge variant={STATUS_VARIANT[r.status] ?? 'neutral'}>{r.status}</StatusBadge>
                                    <span className="text-sm font-medium text-content-emphasis">{r.workflowKey}</span>
                                    <span className="text-xs text-content-subtle">
                                        {t('runs.stepMeta', {
                                            steps: r.stepCount,
                                            tokens: r.costTokens,
                                            date: formatDateTime(r.startedAt),
                                        })}
                                    </span>
                                </div>
                                <div className="flex items-center gap-tight">
                                    {r.status === 'AWAITING_APPROVAL' && (
                                        <Button variant="secondary" size="sm" disabled={busy === r.id} onClick={() => act(r.id, 'resume')}>
                                            {t('runs.resume')}
                                        </Button>
                                    )}
                                    {['RUNNING', 'AWAITING_APPROVAL', 'PAUSED'].includes(r.status) && (
                                        <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => act(r.id, 'abort')}>
                                            {t('runs.abort')}
                                        </Button>
                                    )}
                                </div>
                            </div>
                            {r.status === 'AWAITING_APPROVAL' && (
                                <p className="text-xs text-content-muted">
                                    {t('runs.awaitingApprovalPre')}
                                    <a className="underline" href={tenantHref('/agent-proposals')}>{t('runs.proposalsLink')}</a>
                                    {t('runs.awaitingApprovalPost')}
                                </p>
                            )}
                            {r.summary && <p className="text-sm text-content-default">{r.summary}</p>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
