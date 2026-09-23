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
    /** The engine that walked this run, as recorded on the row at its start. */
    driver: 'STATIC' | 'FLUE';
    startedAt: string;
    completedAt: string | null;
    summary: string | null;
    /**
     * PENDING proposals this run queued, for the paused-run hint below.
     *
     * `AWAITING_APPROVAL` is not the same statement as "there is something in
     * the queue for you": a HUMAN_CHECKPOINT pauses a run whether or not it
     * proposed anything, and a content-guard flag pauses one that proposed
     * nothing at all.
     */
    pendingProposals: number;
}

interface WorkflowOption {
    key: string;
    name: string;
    description: string;
}

/**
 * The driver chip is rendered on EVERY row, including `STATIC`.
 *
 * Showing it only for `FLUE` would make "this run used the static engine" and
 * "this row predates the column" look identical, which is the one distinction
 * the chip exists to make. `neutral` for static and `info` for flue: the
 * engine is not a health signal, so neither reads as good or bad.
 */
const DRIVER_VARIANT: Record<string, 'info' | 'neutral'> = {
    STATIC: 'neutral',
    FLUE: 'info',
};

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
                                    <StatusBadge variant={DRIVER_VARIANT[r.driver] ?? 'neutral'}>
                                        {t(`runs.driver.${r.driver}`)}
                                    </StatusBadge>
                                    {/* The row's way into the step ledger. Until
                                        this link existed the timeline was served
                                        by the API and reachable from nowhere —
                                        `agentic-route-inbound-links` exists
                                        because two agentic pages shipped in
                                        exactly that state. */}
                                    <a
                                        className="text-sm font-medium text-content-emphasis underline"
                                        href={tenantHref(`/agents/runs/${r.id}`)}
                                    >
                                        {r.workflowKey}
                                    </a>
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
                                    {/*
                                      * WHAT IS ACTUALLY WAITING, not what usually is.
                                      *
                                      * This used to send every paused run to the
                                      * proposals queue — "approve its proposals … then
                                      * Resume" — on the assumption that a pause means
                                      * something was proposed. Two pauses break it: a
                                      * HUMAN_CHECKPOINT fires whether or not the run
                                      * queued anything, and a content-guard flag pauses
                                      * a run that queued nothing by construction. Both
                                      * sent a reviewer to an empty queue to look for
                                      * work that was never there, on a page whose job
                                      * is to say where the work is.
                                      */}
                                    {r.pendingProposals > 0 ? (
                                        <>
                                            {t('runs.awaitingApprovalPre')}
                                            <a className="underline" href={tenantHref('/agents/proposals')}>{t('runs.proposalsLink')}</a>
                                            {t('runs.awaitingApprovalPost')}
                                        </>
                                    ) : (
                                        t('runs.awaitingApprovalNoProposals')
                                    )}
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
