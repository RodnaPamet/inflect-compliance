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
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { summariseSync, type SyncConnectionResponse, type SyncTone } from '@/lib/integrations/sync-outcome';
import { LABELLED_PROVIDERS } from '@/lib/integrations/provider-labels';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { RefreshCw } from 'lucide-react';
import { cn } from '@inflect/ui/lib/cn';
import { RequirePermission } from '@/components/require-permission';
import { LegacyAccessMappingCard } from './LegacyAccessMappingCard';
import { LegacyAccessRunsCard } from './LegacyAccessRunsCard';
import { IntegrationOwnerCard } from './IntegrationOwnerCard';
import { IntegrationPassportCard } from './IntegrationPassportCard';

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
    const [msg, setMsg] = useState<{ tone: SyncTone; text: string } | null>(null);

    const load = useCallback(async () => {
        setError(false);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/executions`));
            if (!res.ok) { setError(true); return; }
            setRows((await res.json()).executions ?? []);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, connectionId]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const syncNow = async () => {
        setSyncing(true); setMsg(null);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/sync`), { method: 'POST' });
            const d = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: 'error', text: apiErrorMessage(d, t('integrations.syncFailed')) }); return; }
            // The same summary the Integrations page shows (#4466): a 200 can
            // carry a directory or HR read that failed or stopped early.
            const summary = summariseSync((d ?? {}) as SyncConnectionResponse);
            setMsg({
                tone: summary.tone,
                text: summary.parts
                    .map((p) => t(`integrations.syncResult.${p.key}` as Parameters<typeof t>[0], p.values))
                    .join(' '),
            });
            await load();
        } catch {
            setMsg({ tone: 'error', text: t('integrations.syncFailed') });
        } finally {
            setSyncing(false);
        }
    };

    const providerId = rows[0]?.provider ?? null;
    // The provider's translated name, as the Integrations page shows it — not
    // the id (`mcp-server`) in the page title (#4466).
    const provider = providerId && LABELLED_PROVIDERS.has(providerId)
        ? t(`integrations.providerLabels.${providerId}` as Parameters<typeof t>[0])
        : providerId;
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
            {msg && <InlineNotice variant={msg.tone}>{msg.text}</InlineNotice>}

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

            {/*
              * Renders only for a `legacy-mcp` connection — the card decides that
              * from the connection's PROVIDER rather than from whether it happens
              * to carry an endpoint, so every other provider's page is unchanged.
              */}
            <LegacyAccessMappingCard connectionId={connectionId} />

            {/*
              * Reading the accounts and matching them to people, for a
              * `legacy-mcp` connection only. Both are background jobs whose
              * result is an execution row, so the card reads the rows this page
              * already loaded for Check runs, and Refresh reloads them here too.
              */}
            <LegacyAccessRunsCard
                connectionId={connectionId}
                runs={rows}
                runsLoading={loading}
                runsError={error}
                onReloadRuns={load}
            />

            {/*
              * #3672 — the integration passport. Both cards render only for an
              * `mcp-server` connection, and each is gated at the mount on the
              * key its route holds: naming the owner is the connection-write
              * key (admin.manage); reading the passport is OWNER-only, because
              * it shows the write rung and the prior-state pairings. Gating the
              * mount means an ADMIN is never shown a card whose request would
              * be refused — and never writes an AUTHZ_DENIED row by visiting.
              */}
            <RequirePermission resource="admin" action="manage">
                <IntegrationOwnerCard connectionId={connectionId} />
            </RequirePermission>
            <RequirePermission resource="admin" action="tenant_lifecycle">
                <IntegrationPassportCard connectionId={connectionId} />
            </RequirePermission>
        </div>
    );
}
