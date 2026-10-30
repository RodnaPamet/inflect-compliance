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
    // #4389 — set when a scheduled sync has nobody it may run as, so the
    // connection produces no executions at all. It therefore cannot be derived
    // from the freshness signals above: a connection tested OK last week and
    // blocked ever since reads "fresh" by every one of them.
    syncBlockedAt: string | null;
    syncBlockedReason: string | null;
}

interface HealthResponse {
    connections: HealthRow[];
    staleThresholdSeconds: number;
    staleCount?: number;
    blockedCount?: number;
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
 * last activity — a run of any status, or a successful connection test — with
 * a stale flag, beside the date of its last SUCCESSFUL execution. Read-only
 * view over GET /admin/integrations/health.
 *
 * `providerLabel` turns a provider id into the name the catalogue shows. The
 * health endpoint returns only the id, and the page that renders this panel
 * already holds the names; without it the id is shown.
 */
export function ConnectionHealthPanel({ providerLabel }: { providerLabel?: (id: string) => string } = {}) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const [data, setData] = useState<HealthResponse | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/integrations/health'));
            if (res.ok) setData(await res.json());
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    useEffect(() => { fetchHealth(); }, [fetchHealth]);

    /**
     * The stored reason is a machine token, so the words live here and can
     * change without a migration. An UNRECOGNISED token still produces a
     * sentence: a build that has not heard of a newer reason must say the sync
     * cannot run rather than render a raw enum or, worse, nothing at all.
     */
    const blockedReasonText = (reason: string | null): string => {
        switch (reason) {
            case 'NO_ACTIVE_ADMIN':
            case 'NO_ACTIVE_MEMBER':
                return t('integrations.health.blockedNoActiveAdmin');
            case 'NO_ADMIN_WITH_EVIDENCE_UPLOAD':
            case 'NO_QUALIFYING_ACTOR':
                return t('integrations.health.blockedNoAdminWithUpload');
            default:
                return t('integrations.health.blockedUnknown');
        }
    };

    // Only render the panel when there is at least one enabled connection.
    if (!loading && (!data || data.connections.length === 0)) return null;

    const cols = createColumns<HealthRow>([
        {
            accessorKey: 'provider', header: t('integrations.colProvider'),
            cell: ({ getValue }) => {
                const id = String(getValue());
                return <StatusBadge variant="info">{providerLabel ? providerLabel(id) : id}</StatusBadge>;
            },
        },
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
            // Blocked FIRST, and not folded into stale/fresh. A blocked
            // connection can satisfy every freshness test — a successful
            // "Test connection" counts as activity — so reading the two in the
            // other order reports the one state that needs a person as healthy.
            cell: ({ row }) => row.original.syncBlockedAt
                ? (
                    <div className="space-y-1">
                        <StatusBadge variant="warning">{t('integrations.health.blocked')}</StatusBadge>
                        <p className="text-xs text-content-muted max-w-xs text-pretty">
                            {blockedReasonText(row.original.syncBlockedReason)}
                        </p>
                    </div>
                )
                : row.original.isStale
                    ? <StatusBadge variant="error">{t('integrations.health.stale')}</StatusBadge>
                    : <StatusBadge variant="success">{t('integrations.health.fresh')}</StatusBadge>,
        },
    ]);

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <Heading level={2}>{t('integrations.health.title')}</Heading>
                <div className="flex items-center gap-tight">
                    {/* Plain text, not a second loud badge: the row below
                        carries the state, and this is a count. */}
                    {data && (data.blockedCount ?? 0) > 0 && (
                        <span className="text-xs text-content-muted">
                            {t('integrations.health.blockedSummary', { count: data.blockedCount ?? 0 })}
                        </span>
                    )}
                    {data && (data.staleCount ?? 0) > 0 && (
                        <StatusBadge variant="error">{t('integrations.health.staleSummary', { count: data.staleCount ?? 0 })}</StatusBadge>
                    )}
                </div>
            </div>
            <p className="text-sm text-content-subtle mb-3">{t('integrations.health.description')}</p>
            {/* `loading` on the table, not a spinner INSTEAD of it (#4482): the
                overlay is `absolute inset-0` and a zero-row table reserves
                `min-h-[400px]`, so this section no longer grows when the fetch
                resolves and shifts everything below it.

                The `sr-only` announcement is KEPT: it lived inside the spinner,
                so removing that left a screen reader with no loading signal at
                all. It is clipped, so it adds no height. */}
            {loading && <span className="sr-only">{t('integrations.fetching')}</span>}
            <DataTable
                data={data?.connections ?? []}
                columns={cols}
                loading={loading}
                getRowId={(r) => r.connectionId}
                // Read-only: nothing acts on a selected row.
                selectionEnabled={false}
                emptyState={t('integrations.emptyConfigured')}
                resourceName={(p) => p ? t('integrations.resourceConnections') : t('integrations.resourceConnection')}
            />
        </div>
    );
}
