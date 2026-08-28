'use client';

/**
 * P1 — per-connection outcome view. Emulates the SharePoint health dashboard
 * for EVERY connector: this connection's check executions (status / last run /
 * summary) plus a connection-level "Sync now" trigger, independent of whether a
 * control is wired to it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDate } from '@/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';

interface ExecutionRow {
    id: string;
    provider: string;
    automationKey: string;
    controlId: string | null;
    status: string;
    triggeredBy: string | null;
    errorMessage: string | null;
    executedAt: string;
    completedAt: string | null;
}

/**
 * A loose Record with a `?? 'neutral'` fallback at the call site, so a status
 * missing here renders as a neutral badge rather than failing to compile. That
 * is the right default and the reason this needs watching: PARTIAL would have
 * shown up grey, reading as a non-status beside a red ERROR, while meaning "the
 * directory was only partly read".
 */
const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    PASSED: 'success',
    FAILED: 'error',
    ERROR: 'error',
    RUNNING: 'info',
    PENDING: 'neutral',
    NOT_APPLICABLE: 'neutral',
    // Not an error — the pass continues from a stored cursor — but not clean
    // either, and the difference is the whole point of recording it.
    PARTIAL: 'warning',
};

export default function ConnectionOutcomePage() {
    const { connectionId } = useParams<{ connectionId: string }>();
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [rows, setRows] = useState<ExecutionRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

    const load = useCallback(async () => {
        setError(false);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/executions`));
            if (!res.ok) { setError(true); return; }
            setRows((await res.json()).executions ?? []);
        } catch {
            setError(true);
        } finally {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLoading(false);
        }
    }, [apiUrl, connectionId]);
    useEffect(() => { void load(); }, [load]);

    const syncNow = async () => {
        setSyncing(true); setMsg(null);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/sync`), { method: 'POST' });
            if (!res.ok) { setMsg({ ok: false, text: t('integrations.syncFailed') }); return; }
            const d = await res.json() as { counts?: { total: number; passed: number; failed: number }; identity?: { upserted: number } | null };
            setMsg({ ok: (d.counts?.total ?? 0) > 0 || (d.identity?.upserted ?? 0) > 0, text: t('integrations.syncDone', { total: d.counts?.total ?? 0, passed: d.counts?.passed ?? 0, failed: d.counts?.failed ?? 0, accounts: d.identity?.upserted ?? 0 }) });
            await load();
        } catch {
            setMsg({ ok: false, text: t('integrations.syncFailed') });
        } finally {
            setSyncing(false);
        }
    };

    const provider = rows[0]?.provider ?? null;
    const cols = createColumns<ExecutionRow>([
        { accessorKey: 'automationKey', header: t('integrations.outcome.colCheck'), cell: ({ getValue }) => <span className="font-mono">{getValue()}</span> },
        { id: 'status', accessorKey: 'status', header: t('integrations.colStatus'), cell: ({ row }) => <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>{row.original.status}</StatusBadge> },
        { id: 'trigger', accessorKey: 'triggeredBy', header: t('integrations.outcome.colTrigger'), cell: ({ getValue }) => <span className="text-content-muted">{String(getValue() ?? '—')}</span> },
        { id: 'ran', accessorKey: 'executedAt', header: t('integrations.outcome.colRan'), cell: ({ row }) => <span className="text-content-muted tabular-nums">{formatDate(row.original.completedAt ?? row.original.executedAt)}</span> },
        {
            id: 'control', header: t('integrations.outcome.colControl'),
            cell: ({ row }) => row.original.controlId
                ? <a className="text-content-info underline underline-offset-2" href={tenantHref(`/controls/${row.original.controlId}`)}>{t('integrations.outcome.viewControl')}</a>
                : <span className="text-content-subtle">{t('integrations.outcome.unmapped')}</span>,
        },
    ]);

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('integrations.title'), href: tenantHref('/admin/integrations') }, { label: t('integrations.outcome.breadcrumb') }]} />
            <div className="flex items-center justify-between">
                <Heading level={1}>{provider ? t('integrations.outcome.titleFor', { provider }) : t('integrations.outcome.title')}</Heading>
                <Button variant="secondary" icon={<RefreshCw className={cn('size-4', syncing && 'animate-spin')} />} onClick={syncNow} disabled={syncing} id="connection-sync-btn">
                    {t('integrations.syncNow')}
                </Button>
            </div>
            {msg && <InlineNotice variant={msg.ok ? 'success' : 'error'}>{msg.text}</InlineNotice>}

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('integrations.outcome.checkRuns')}</Heading>
                {error ? (
                    <InlineNotice variant="error">{t('integrations.outcome.loadError')}</InlineNotice>
                ) : loading ? (
                    <p className="text-sm text-content-subtle">{t('integrations.fetching')}</p>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('integrations.outcome.empty')}</p>
                ) : (
                    <DataTable data={rows} columns={cols} getRowId={(r) => r.id} emptyState={t('integrations.outcome.empty')} />
                )}
            </Card>
        </div>
    );
}
