'use client';
/* PR-Q — migrated to useTenantSWR (Epic 69 shape); the fetch-on-mount +
 * setState pattern (and its react-hooks/set-state-in-effect disables) is gone. */

import { formatDate } from '@/lib/format-date';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/components/ui/hooks/use-toast';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { TestsSubNav } from '../_components/TestsSubNav';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { IconAction } from '@/components/ui/icon-action';
import { AppIcon } from '@/components/icons/AppIcon';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { ErrorState } from '@/components/ui/error-state';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface DuePlan {
    id: string;
    name: string;
    frequency: string;
    nextDueAt: string | null;
    nextRunAt: string | null;
    // PR-Q — reconciled due date (earliest of nextDueAt/nextRunAt), computed
    // server-side; drives isOverdue + the "next due" column.
    effectiveDueAt: string | null;
    controlId: string;
    isOverdue: boolean;
    hasPendingRun: boolean;
    control: { id: string; name: string; code: string | null };
    owner: { id: string; name: string | null; email: string } | null;
    _count: { runs: number };
}

const freqLabels = (t: (key: string) => string): Record<string, string> => ({
    AD_HOC: t('freq.adHoc'), DAILY: t('freq.daily'), WEEKLY: t('freq.weekly'),
    MONTHLY: t('freq.monthly'), QUARTERLY: t('freq.quarterly'), ANNUALLY: t('freq.annually'),
});

export default function DueQueuePage() {
    const t = useTranslations('controlTests');
    const FREQ_LABELS = freqLabels(t);
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();
    const router = useRouter();
    const toast = useToast();

    const { data: queueData, isLoading: loading, error: queueError, mutate } = useTenantSWR<DuePlan[]>(CACHE_KEYS.tests.due());
    const queue = queueData ?? [];
    const [planning, setPlanning] = useState(false);
    const [planningResult, setPlanningResult] = useState<{ checked: number; created: number; alreadyPending: number } | null>(null);
    const [error, setError] = useState('');

    const handleRunDuePlanning = async () => {
        setPlanning(true);
        setPlanningResult(null);
        setError('');
        try {
            const res = await fetch(apiUrl('/tests/due'), { method: 'POST' });
            if (res.ok) {
                const result = await res.json();
                setPlanningResult(result);
                await mutate();
            } else {
                setError(t('due.planningFailed'));
                toast.error(t('due.planningFailed'));
            }
        } catch {
            setError(t('due.planningFailed'));
            toast.error(t('due.planningFailed'));
        } finally {
            setPlanning(false);
        }
    };

    const handleQuickRun = async (planId: string) => {
        try {
            const res = await fetch(apiUrl(`/tests/plans/${planId}/runs`), { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            const run = await res.json();
            // R3-P2 — client-side navigation keeps the SPA shell (no full
            // reload); the old window.location.href discarded app state.
            router.push(tenantHref(`/tests/runs/${run.id}`));
        } catch {
            toast.error(t('due.runFailed'));
        }
    };

    const overdueCount = queue.filter(p => p.isOverdue).length;
    const pendingCount = queue.filter(p => p.hasPendingRun).length;

    return (
        <ListPageShell className="animate-fadeIn gap-section">
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.tests'), href: tenantHref('/tests') },
                        { label: t('due.crumb') },
                    ]}
                    className="mb-1"
                />
                <TestsSubNav active="due" className="mb-3" />
                <div className="flex items-center justify-between">
                    <div>
                        <Heading level={1} id="due-queue-title">{t('due.title')}</Heading>
                        <p className="text-sm text-content-muted mt-1">{t('due.description')}</p>
                    </div>
                    {permissions.canWrite && (
                        <IconAction
                            variant="primary"
                            onClick={handleRunDuePlanning}
                            loading={planning}
                            id="run-due-planning-btn"
                            icon={<AppIcon name="run" size={16} />}
                            label={t('due.runPlanning')}
                        />
                    )}
                </div>
            </ListPageShell.Header>

            <ListPageShell.Filters className="space-y-section">
                {/* Planning result */}
            {planningResult && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-success bg-bg-success')} id="planning-result">
                    <p className="text-sm text-content-success">
                        {t('due.planningResult', {
                            checked: planningResult.checked,
                            created: planningResult.created,
                            alreadyPending: planningResult.alreadyPending,
                        })}
                    </p>
                </div>
            )}
            {error && <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-error text-content-error text-sm')}>{error}</div>}

            {/* Stats — Polish PR-2: KPIStat primitive. */}
            <div className="grid grid-cols-3 gap-default">
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat value={queue.length} label={t('due.kpi.due')} />
                </div>
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat value={overdueCount} label={t('due.kpi.overdue')} tone={overdueCount > 0 ? 'critical' : 'success'} />
                </div>
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat value={pendingCount} label={t('due.kpi.pending')} tone={pendingCount > 0 ? 'attention' : 'default'} />
                </div>
            </div>

            </ListPageShell.Filters>

            <ListPageShell.Body>
                {/* Queue Table — a failed fetch shows a retry affordance, not an
                    empty queue that reads as "nothing due". The header + sub-nav
                    above stay mounted. */}
                {queueError ? (
                    <ErrorState
                        title={t('due.loadErrorTitle')}
                        description={t('due.loadErrorBody')}
                        onRetry={() => { mutate(); }}
                        retryLabel={t('due.retry')}
                        data-testid="due-load-error"
                    />
                ) : (() => {
                const dueColumns = createColumns<DuePlan>([
                    {
                        id: 'plan', header: t('due.col.plan'), accessorKey: 'name',
                        cell: ({ row }) => (
                            <Link href={tenantHref(`/tests/plans/${row.original.id}`)} className="text-content-emphasis font-medium hover:text-[var(--brand-default)] transition">
                                {row.original.name}
                            </Link>
                        ),
                    },
                    {
                        id: 'control', header: t('due.col.control'), accessorFn: (p) => p.control?.code || p.control?.name || '—',
                        cell: ({ row }) => (
                            <Link href={tenantHref(`/controls/${row.original.controlId}`)} className="text-content-muted hover:text-content-emphasis text-xs transition">
                                {row.original.control?.code || row.original.control?.name || '—'}
                            </Link>
                        ),
                    },
                    { id: 'frequency', header: t('due.col.frequency'), accessorFn: (p) => FREQ_LABELS[p.frequency] || p.frequency },
                    {
                        id: 'dueDate', header: t('due.col.dueDate'), accessorKey: 'effectiveDueAt',
                        cell: ({ row }) => (
                            <span className={row.original.isOverdue ? 'text-content-error font-semibold' : 'text-content-warning'}>
                                {formatDate(row.original.effectiveDueAt ?? row.original.nextDueAt)}
                                {row.original.isOverdue && ' !'}
                            </span>
                        ),
                    },
                    { id: 'owner', header: t('due.col.owner'), accessorFn: (p) => p.owner?.name || p.owner?.email || '—', cell: ({ getValue }) => <span className="text-content-muted text-xs">{getValue()}</span> },
                    {
                        id: 'status', header: t('due.col.status'),
                        cell: ({ row }) => row.original.hasPendingRun
                            ? <StatusBadge variant="warning" size="sm">{t('due.runPending')}</StatusBadge>
                            : <StatusBadge variant="error" size="sm">{t('due.needsRun')}</StatusBadge>,
                    },
                    {
                        id: 'actions', header: '',
                        cell: ({ row }) => !row.original.hasPendingRun && permissions.canWrite ? (
                            <Button variant="primary" size="xs" onClick={() => handleQuickRun(row.original.id)}>{t('due.runNow')}</Button>
                        ) : null,
                    },
                ]);
                return (
                    <DataTable
                        fillBody
                        data={queue}
                        columns={dueColumns}
                        getRowId={(p) => p.id}
                        loading={loading}
                        emptyState={t('due.empty')}
                        resourceName={(p) => p ? t('list.entityPlural') : t('list.entitySingular')}
                        data-testid="due-queue-table"
                    />
                );
            })()}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
