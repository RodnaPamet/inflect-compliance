'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PermissionGated } from '../PermissionGated';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
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
    tenantSlug,
    initialRuns,
    workflows,
    canOperate,
}: {
    tenantSlug: string;
    initialRuns: RunRow[];
    workflows: WorkflowOption[];
    /**
     * The role-tier `canWrite` (#2456), NOT a permissions-blob key.
     *
     * This page is gated on `admin.view`, but `startWorkflowRun`,
     * `resumeWorkflowRun` and `abortWorkflowRun` all open with
     * `assertCanWrite(ctx)` — so a READER or AUDITOR holding `admin.view`
     * reaches this page and is refused on press. Start, Resume and Abort
     * rendered enabled for exactly those people, and an operator discovered
     * which controls were theirs by trying them.
     *
     * DISABLED, never hidden: the detail tabs already settled this — "a greyed
     * tab tells you the surface exists and is not yours; a missing one would
     * tell you the product does not have it."
     */
    canOperate: boolean;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [runs, setRuns] = useState(initialRuns);
    const [busy, setBusy] = useState<string | null>(null);
    /** The run awaiting an abort confirmation — aborting stops a LIVE execution. */
    const [confirmAbort, setConfirmAbort] = useState<string | null>(null);
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

    const abortTarget = runs.find((r) => r.id === confirmAbort) ?? null;

    return (
        <div className="space-y-section animate-fadeIn">
            <ConfirmDialog
                showModal={confirmAbort !== null}
                setShowModal={(open) => { if (!open) setConfirmAbort(null); }}
                tone="danger"
                title={t('runs.abortConfirmTitle')}
                description={t('runs.abortConfirmBody', {
                    workflow: abortTarget?.workflowKey ?? '',
                })}
                confirmLabel={t('runs.abort')}
                onConfirm={async () => {
                    if (confirmAbort) await act(confirmAbort, 'abort');
                    setConfirmAbort(null);
                }}
                onCancel={() => setConfirmAbort(null)}
            />
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('register.breadcrumb'), href: tenantHref('/agents') },
                    { label: t('runs.crumb') },
                ]}
                title={t('runs.title')}
                description={t('runs.description')}
                actions={
                    <AgentsViewsMenu
                        current="runs"
                        tenantSlug={tenantSlug}
                        canReviewProposals
                        canInvestigate
                    />
                }
            />

            {workflows.length > 0 && (
                <div className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}>
                    <p className="text-sm font-medium text-content-emphasis">{t('runs.startWorkflow')}</p>
                    <div className="flex flex-wrap gap-tight">
                        {workflows.map((w) => (
                            <PermissionGated key={w.key} allowed={canOperate} reason={t('runs.needsWrite')}>
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={!canOperate || busy === 'start'}
                                onClick={() => start(w.key)}
                                title={w.description}
                            >
                                {w.name}
                            </Button>
                            </PermissionGated>
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
                                        <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={!canOperate || busy === r.id}
                                                onClick={() => act(r.id, 'resume')}
                                            >
                                                {t('runs.resume')}
                                            </Button>
                                        </PermissionGated>
                                    )}
                                    {['RUNNING', 'AWAITING_APPROVAL', 'PAUSED'].includes(r.status) && (
                                        <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={!canOperate || busy === r.id}
                                                data-testid={`agent-run-abort-${r.id}`}
                                                // Aborting stops a LIVE execution
                                                // mid-flight. It committed on one
                                                // click (#2454).
                                                onClick={() => setConfirmAbort(r.id)}
                                            >
                                                {t('runs.abort')}
                                            </Button>
                                        </PermissionGated>
                                    )}
                                </div>
                            </div>
                            {r.status === 'AWAITING_APPROVAL' && (
                                <p className="text-xs text-content-muted">
                                    {t('runs.awaitingApprovalPre')}
                                    <a className="underline" href={tenantHref('/agents/proposals')}>{t('runs.proposalsLink')}</a>
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
