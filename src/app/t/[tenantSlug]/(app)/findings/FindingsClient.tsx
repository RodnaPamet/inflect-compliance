'use client';
import { useCallback, useState, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { ownerDisplayName } from '@/lib/owner-display';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { DataTable, createColumns, useColumnsDropdown } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { Plus } from '@/components/ui/icons/nucleo';
import { CreateFindingModal } from './CreateFindingModal';

const SEV_BADGE: Record<string, StatusBadgeVariant> = { LOW: 'info', MEDIUM: 'warning', HIGH: 'error', CRITICAL: 'error' };
const STATUS_BADGE: Record<string, StatusBadgeVariant> = { OPEN: 'error', IN_PROGRESS: 'info', READY_FOR_VERIFICATION: 'warning', CLOSED: 'success' };

// listFindings → FindingRepository.list (findingListSelect). Cell/accessor
// callbacks stay explicitly-untyped (the file-level disable above covers them
// — a separate ratchet category); this types the query payload + factory.
interface FindingRow {
    id: string;
    title: string;
    severity: string;
    type: string;
    status: string;
    owner: string | null;
    assignee: { id: string; name: string | null; email: string | null } | null;
    control: { id: string; code: string | null; name: string } | null;
    // feat/audit-cycle-unify — audit/cycle provenance.
    audit: {
        id: string;
        title: string;
        auditCycleId: string | null;
        auditCycle: { id: string; name: string } | null;
    } | null;
    _count: { riskLinks: number };
}

interface FindingsClientProps {

    initialFindings: FindingRow[];
    tenantSlug: string;
    translations: {
        title: string;
        listDescription: string;
        open: string;
        newFinding: string;
        findingTitle: string;
        severity: string;
        type: string;
        owner: string;
        status: string;
        description: string;
        dueDate: string;
        createFinding: string;
        noFindings: string;
        low: string;
        medium: string;
        high: string;
        critical: string;
        nonconformity: string;
        observation: string;
        opportunity: string;
        inProgress: string;
        readyForVerification: string;
        closed: string;
        cancel: string;
        actions: string;
    };
}

/**
 * Client island for findings — handles create form and status updates.
 * Data is pre-fetched server-side and passed via props.
 */
export function FindingsClient({ initialFindings, tenantSlug, translations: t }: FindingsClientProps) {
    const tx = useTranslations('findings');
    const [showForm, setShowForm] = useState(false);

    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    // PR-5 — API returns `{ rows, truncated }`; SSR initial wraps
    // with `truncated: false` (SSR cap < backfill cap).
    // `/findings` is fetched whole and filtered client-side, so the key is
    // static — the SSR payload always matches and seeds the cache directly.
    const findingsQuery = useTenantSWR<CappedList<FindingRow>>(
        CACHE_KEYS.findings.list(),
        { fallbackData: { rows: initialFindings, truncated: false } },
    );
    const findings = findingsQuery.data?.rows ?? [];
    const truncated = findingsQuery.data?.truncated ?? false;

    // Optimistic status flip on the static findings list key: the hook
    // applies `optimisticUpdate` synchronously, runs the PUT, then
    // revalidates (background GET) to reconcile — rolling back the row on
    // error. Replaces the hand-rolled cancel/getQueryData/setQueryData dance.
    const statusMutation = useTenantMutation<
        CappedList<FindingRow>,
        { id: string; status: string },
        FindingRow
    >({
        key: CACHE_KEYS.findings.list(),
        optimisticUpdate: (current, { id, status }) => {
            // `current` is always populated in practice (the status button
            // only shows on a loaded row). The fallback used to synthesise an
            // empty list purely to satisfy a non-optional return type —
            // painting "you have no findings" would have been worse than
            // painting nothing. `undefined` says exactly that.
            if (!current) return undefined;
            return {
                ...current,
                rows: current.rows.map((f) =>
                    f.id === id ? { ...f, status } : f,
                ),
            };
        },
        mutationFn: async ({ id, status }) => {
            const res = await fetch(apiUrl(`/findings/${id}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) throw new Error('Failed to update status');
            return res.json();
        },
    });

    const updateStatus = (id: string, status: string) => {
        void statusMutation.trigger({ id, status });
    };

    const sevLabel = (sev: string) => {
        const map: Record<string, string> = { LOW: t.low, MEDIUM: t.medium, HIGH: t.high, CRITICAL: t.critical };
        return map[sev] || sev;
    };

    const typeLabel = (type: string) => {
        const map: Record<string, string> = { NONCONFORMITY: t.nonconformity, OBSERVATION: t.observation, OPPORTUNITY: t.opportunity };
        return map[type] || type;
    };

    const statusLabel = (status: string) => {
        const map: Record<string, string> = { OPEN: t.open, IN_PROGRESS: t.inProgress, READY_FOR_VERIFICATION: t.readyForVerification, CLOSED: t.closed };
        return map[status] || status;
    };

    // R10-PR11 — column-visibility gear.
    const findingColumnList = useMemo(
        () => [
            { id: 'title', label: tx('colVis.title') },
            { id: 'severity', label: tx('colVis.severity') },
            { id: 'type', label: tx('colVis.type') },
            { id: 'control', label: tx('colVis.control') },
            { id: 'source', label: tx('colVis.source') },
            { id: 'owner', label: tx('colVis.owner') },
            { id: 'status', label: tx('colVis.status') },
        ],
        [tx],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:findings',
        columns: findingColumnList,
    });


    const findingColumns = useMemo(() => createColumns<FindingRow>([
        {
            accessorKey: 'title',
            header: t.findingTitle,

            cell: ({ getValue }) => <TableTitleCell>{getValue()}</TableTitleCell>,
        },
        {
            accessorKey: 'severity',
            header: t.severity,

            cell: ({ row }) => <StatusBadge variant={SEV_BADGE[row.original.severity]}>{sevLabel(row.original.severity)}</StatusBadge>,
        },
        {
            accessorKey: 'type',
            header: t.type,

            cell: ({ row }) => <span className="text-xs">{typeLabel(row.original.type)}</span>,
        },
        {
            // feat/audit-cycle-unify — the control the finding is raised
            // against (relation was loaded but never rendered).
            id: 'control',
            header: tx('colHeaders.control'),
            accessorFn: (f) => (f.control ? (f.control.code ?? f.control.name) : '—'),
            cell: ({ row }) => {
                const c = row.original.control;
                if (!c) return <span className="text-xs text-content-subtle">—</span>;
                return (
                    <Link href={`/t/${tenantSlug}/controls/${c.id}`} className="text-xs text-content-default underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
                        {c.code ?? c.name}
                    </Link>
                );
            },
        },
        {
            // feat/audit-cycle-unify — provenance: the audit (and its cycle)
            // the finding was raised under, or "Ad-hoc" for register-created.
            id: 'source',
            header: tx('colHeaders.source'),
            accessorFn: (f) => f.audit?.auditCycle?.name ?? f.audit?.title ?? tx('adHoc'),
            cell: ({ row }) => {
                const a = row.original.audit;
                if (!a) return <span className="text-xs text-content-subtle">{tx('adHoc')}</span>;
                if (a.auditCycle) {
                    return (
                        <Link href={`/t/${tenantSlug}/audits/cycles/${a.auditCycle.id}`} className="text-xs text-content-default underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
                            {a.auditCycle.name}
                        </Link>
                    );
                }
                return (
                    <Link href={`/t/${tenantSlug}/audits/${a.id}`} className="text-xs text-content-default underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
                        {a.title}
                    </Link>
                );
            },
        },
        {
            id: 'owner',
            header: t.owner,

            // Prefer the assignee (the canonical owner relation); fall
            // back to the legacy free-text `owner` for older findings.
            accessorFn: (f) =>
                ownerDisplayName(f.assignee?.name, f.assignee?.email) ?? f.owner ?? '—',

            cell: ({ getValue }) => <span className="text-xs">{getValue()}</span>,
        },
        {
            accessorKey: 'status',
            header: t.status,

            // R8-PR5 — secondary (workflow) badge demotes to `tone="subtle"`
            // so the loud severity badge in the prior column reads as the
            // primary state signal. Keeps the workflow tone visible without
            // creating a two-loud-badge wall per row.
            cell: ({ row }) => <StatusBadge tone="subtle" variant={STATUS_BADGE[row.original.status]}>{statusLabel(row.original.status)}</StatusBadge>,
        },
        {
            id: 'actions',
            header: t.actions,
            enableHiding: false,

            cell: ({ row }) => {
                const f = row.original;
                return (
                    <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        {f.status === 'OPEN' && <Button variant="secondary" size="sm" onClick={() => updateStatus(f.id, 'IN_PROGRESS')}>{t.inProgress}</Button>}
                        {f.status === 'IN_PROGRESS' && <Button variant="secondary" size="sm" onClick={() => updateStatus(f.id, 'READY_FOR_VERIFICATION')}>{t.readyForVerification}</Button>}
                        {f.status === 'READY_FOR_VERIFICATION' && <Button variant="secondary" size="sm" onClick={() => updateStatus(f.id, 'CLOSED')}>{t.closed}</Button>}
                    </div>
                );
            },
        },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ]), [t]);

    // `orderColumns` spreads its input, so it returns a NEW array every
    // call. Calling it inline in JSX would hand DataTable a fresh
    // `columns` identity every render despite the memo above.
    const orderedFindingColumns = useMemo(
        () => orderColumns(findingColumns),
        [orderColumns, findingColumns],
    );
    const getFindingRowId = useCallback((f: FindingRow) => f.id, []);

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <PageHeader
                    breadcrumbs={[
                        { label: tx('list.crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t.title },
                    ]}
                    title={t.title}
                    description={t.listDescription || undefined}
                    actions={
                        <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setShowForm(!showForm)}>{t.newFinding}</Button>
                    }
                />
            </ListPageShell.Header>

            <CreateFindingModal
                open={showForm}
                setOpen={setShowForm}
                tenantSlug={tenantSlug}
                apiUrl={apiUrl}
            />

            <ListPageShell.Body>
                <TruncationBanner truncated={truncated} />
                <div className="flex justify-end mb-tight">
                    {columnsDropdown}
                </div>
                <DataTable
                    fillBody
                    data={findings}
                    columns={orderedFindingColumns}
                    getRowId={getFindingRowId}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t.noFindings}
                            description={tx('list.emptyDesc')}
                        />
                    }
                    resourceName={(p) => p ? 'findings' : 'finding'}
                    data-testid="findings-table"
                />
            </ListPageShell.Body>
        </ListPageShell>
    );
}
