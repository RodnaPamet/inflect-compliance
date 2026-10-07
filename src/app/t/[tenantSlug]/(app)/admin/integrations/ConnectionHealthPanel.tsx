'use client';
/* TODO(swr-migration): fetch-on-mount + setState, same pattern as the
 * parent integrations page. Migrates to useTenantSWR with the rest. */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { LoadingSpinner } from '@inflect/ui/components/ui/icons/loading-spinner';

interface HealthRow {
    connectionId: string;
    provider: string;
    name: string;
    lastSuccessAt: string | null;
    secondsSinceLastSuccess: number | null;
    hasEverSucceeded: boolean;
    isStale: boolean;
    // P1 — the nuanced signal: activity is a run of ANY status OR a successful
    // connection test, so a freshly-connected+tested connection reads healthy.
    lastActivityAt: string | null;
    secondsSinceActivity: number | null;
    lastTestStatus: string | null;
    lastTestedAt: string | null;
}

interface HealthResponse {
    connections: HealthRow[];
    staleThresholdSeconds: number;
    staleCount?: number;
    generatedAt: string;
}

/** Human "3h ago" / "2d ago" from a seconds delta. */
function humanizeAge(seconds: number | null): string {
    if (seconds == null) return '—';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

/**
 * GAP-3 — per-connection freshness. Seconds since each enabled connection's
 * last SUCCESSFUL (PASSED) execution, with a stale flag. Read-only view over
 * GET /admin/integrations/health.
 */
export function ConnectionHealthPanel() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const [data, setData] = useState<HealthResponse | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/integrations/health'));
            if (res.ok) setData(await res.json());
        } finally {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchHealth(); }, [fetchHealth]);

    // Only render the panel when there is at least one enabled connection.
    if (!loading && (!data || data.connections.length === 0)) return null;

    const cols = createColumns<HealthRow>([
        { accessorKey: 'provider', header: t('integrations.colProvider'), cell: ({ getValue }) => <StatusBadge variant="info">{getValue()}</StatusBadge> },
        { accessorKey: 'name', header: t('integrations.colName'), cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> },
        {
            id: 'lastSuccess', header: t('integrations.health.colLastSuccess'), accessorKey: 'lastSuccessAt',
            cell: ({ row }) => row.original.lastSuccessAt
                ? <span className="text-content-muted">{formatDate(row.original.lastSuccessAt)}</span>
                // P1 — a never-run-but-tested-OK connection now reads "Tested OK",
                // not "Never succeeded".
                : row.original.lastTestStatus === 'ok'
                    ? <span className="text-content-muted">{t('integrations.health.testedOk')}</span>
                    : <span className="text-content-subtle">{t('integrations.health.neverSucceeded')}</span>,
        },
        {
            id: 'freshness', header: t('integrations.health.colFreshness'),
            accessorFn: (r: HealthRow) => r.secondsSinceActivity ?? Number.MAX_SAFE_INTEGER,
            cell: ({ row }) => <span className="tabular-nums text-content-muted">{humanizeAge(row.original.secondsSinceActivity)}</span>,
        },
        {
            id: 'status', header: t('integrations.colStatus'), accessorKey: 'isStale',
            cell: ({ row }) => row.original.isStale
                ? <StatusBadge variant="error">{t('integrations.health.stale')}</StatusBadge>
                : <StatusBadge variant="success">{t('integrations.health.fresh')}</StatusBadge>,
        },
    ]);

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <Heading level={2}>{t('integrations.health.title')}</Heading>
                {data && (data.staleCount ?? 0) > 0 && (
                    <StatusBadge variant="error">{t('integrations.health.staleSummary', { count: data.staleCount ?? 0 })}</StatusBadge>
                )}
            </div>
            <p className="text-sm text-content-subtle mb-3">{t('integrations.health.description')}</p>
            {loading ? (
                <div className="p-8 text-center text-content-subtle">
                    <LoadingSpinner className="mx-auto mb-2" />
                    <span className="sr-only">{t('integrations.fetching')}</span>
                </div>
            ) : (
                <DataTable
                    data={data?.connections ?? []}
                    columns={cols}
                    getRowId={(r) => r.connectionId}
                    emptyState={t('integrations.emptyConfigured')}
                    resourceName={(p) => p ? t('integrations.resourceConnections') : t('integrations.resourceConnection')}
                />
            )}
        </div>
    );
}
