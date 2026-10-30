'use client';
import { useCallback, useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useThresholdLoadMore, useToast } from '@/components/ui/hooks';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { ownerDisplayName } from '@/lib/owner-display';
import { apiErrorMessage } from '@/lib/api-error';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { DataTable, createColumns, useColumnsDropdown } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import { useSsrFallback } from '@inflect/ui/components/ui/hooks/use-ssr-fallback';
import { CreateFindingModal } from './CreateFindingModal';
import { FindingDetailSheet } from './FindingDetailSheet';
import { buildFindingFilters, FINDING_FILTER_KEYS, FINDING_STATUSES } from './filter-defs';

/**
 * The register's address for one finding: `?finding=<id>` opens its panel.
 * There is no `/findings/[id]` route, so other surfaces (the integration
 * passport, the calendar) link here.
 */
export const FINDING_PARAM = 'finding';

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
    /** The status facet the server rendered `initialFindings` with. */
    initialFilters?: Record<string, string>;
    tenantSlug: string;
    /**
     * The coarse write tier. `createFinding` and `updateFinding` both
     * `assertCanWrite` and nothing more (findings carry no granular key), so
     * this alone decides whether the create button and the status actions
     * are offered. Without it Readers, Auditors and AI admins were shown both
     * and refused by the server.
     */
    canWrite: boolean;
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
 * Client island for findings — handles the status filter, the create form,
 * status updates and the detail panel. Data is pre-fetched server-side and
 * passed via props.
 */
export function FindingsClient(props: FindingsClientProps) {
    // Named apart from the inner component's `tx`: `i18n-keys-resolve` binds
    // each translator identifier to one namespace, and a second `tx` binding
    // in the file would leave the whole file unchecked.
    const tFilters = useTranslations('findings');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildFindingFilters(
                (k, v) => tFilters(k as Parameters<typeof tFilters>[0], v as Parameters<typeof tFilters>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tFilters, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...FINDING_FILTER_KEYS], {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <FindingsPageInner {...props} filterDefs={filters} />
        </FilterProvider>
    );
}

function FindingsPageInner({
    initialFindings,
    initialFilters,
    tenantSlug,
    canWrite,
    translations: t,
    filterDefs,
}: FindingsClientProps & { filterDefs: ReturnType<typeof buildFindingFilters> }) {
    const tx = useTranslations('findings');
    const toast = useToast();
    const [showForm, setShowForm] = useState(false);

    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    // ─── Status filter (server-side) ───
    // The facet goes to the API rather than over the loaded rows, so that it
    // narrows past the backfill cap. Only real statuses are sent: a value
    // carried over from another list's URL (`?status=ACTIVE`) is ignored here
    // rather than turning the whole register into a 400.
    const { state, hasActive, clearAll } = useFilters();
    const fetchParams = useMemo(
        () =>
            toApiSearchParams({
                status: (state.status ?? []).filter((v) =>
                    (FINDING_STATUSES as readonly string[]).includes(v),
                ),
            }),
        [state.status],
    );
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of fetchParams) obj[k] = v;
        return obj;
    }, [fetchParams]);
    const filtersMatchInitial = useSsrFallback({
        queryKeyFilters,
        initialFilters,
        serverHadFilters: initialFilters && Object.keys(initialFilters).length > 0,
        hasActive,
    });
    const findingsKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs ? `${CACHE_KEYS.findings.list()}?${qs}` : CACHE_KEYS.findings.list();
    }, [fetchParams]);

    // PR-5 — API returns `{ rows, truncated }`; SSR initial wraps
    // with `truncated: false` (SSR cap < backfill cap). The SSR rows seed the
    // cache only while the filter still describes the query they answered.
    const findingsQuery = useTenantSWR<CappedList<FindingRow>>(findingsKey, {
        fallbackData: filtersMatchInitial ? { rows: initialFindings, truncated: false } : undefined,
    });
    const findings = findingsQuery.data?.rows ?? [];
    // Render a window, not the whole backfill-capped set. Without this the
    // page mounts every row it fetched and never virtualizes — the default
    // threshold is 1000, so a tenant can sit under it and still re-render
    // hundreds of rows on every filter or sort change. `onReachEnd` extends
    // the window on scroll, the same contract the other list pages use.
    const {
        visibleRows: visibleFindings,
        hasMore: hasMoreFindings,
        loadMore: loadMoreFindings,
    } = useThresholdLoadMore(findings);

    const truncated = findingsQuery.data?.truncated ?? false;

    // ─── Detail panel ───
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [openFindingId, setOpenFindingId] = useState<string | null>(null);
    const linkedFindingId = searchParams?.get(FINDING_PARAM) ?? null;
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (linkedFindingId) setOpenFindingId(linkedFindingId);
    }, [linkedFindingId]);
    const closeFinding = useCallback(() => {
        setOpenFindingId(null);
        // Drop the deep-link parameter so a reload or Back does not reopen
        // the panel the user has just closed. Other parameters stay.
        if (searchParams?.has(FINDING_PARAM)) {
            const next = new URLSearchParams(searchParams.toString());
            next.delete(FINDING_PARAM);
            const qs = next.toString();
            router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
        }
    }, [pathname, router, searchParams]);
    const handleFindingRowClick = useCallback(
        (row: { original: FindingRow }) => setOpenFindingId(row.original.id),
        [],
    );
    // A save changes what the register shows (title, severity, owner, the
    // control column), so every cached variant of the list is refetched.
    const { mutate: swrMutate } = useSWRConfig();
    const revalidateFindingLists = useCallback(() => {
        const base = `/api/t/${tenantSlug}${CACHE_KEYS.findings.list()}`;
        void swrMutate(
            (key: unknown) => typeof key === 'string' && (key === base || key.startsWith(`${base}?`)),
        );
    }, [swrMutate, tenantSlug]);

    // Optimistic status flip on the current findings list key: the hook
    // applies `optimisticUpdate` synchronously, runs the PUT, then
    // revalidates (background GET) to reconcile — rolling back the row on
    // error. Replaces the hand-rolled cancel/getQueryData/setQueryData dance.
    const statusMutation = useTenantMutation<
        CappedList<FindingRow>,
        { id: string; status: string },
        FindingRow
    >({
        key: findingsKey,
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
            if (!res.ok) {
                // The server's reason (a refusal, a finding that is gone),
                // read through the shared envelope helper.
                const body = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(body, tx('statusUpdateFailed')));
            }
            return res.json();
        },
    });

    // The hook rolls the row back and re-throws. Without this catch the
    // status flipped and flipped back with nothing said; now the reason is
    // shown.
    const updateStatus = (id: string, status: string) => {
        statusMutation.trigger({ id, status }).catch((err: unknown) => {
            toast.error(err instanceof Error && err.message ? err.message : tx('statusUpdateFailed'));
        });
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


    const findingColumns = useMemo(() => [...createColumns<FindingRow>([
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
                // There is no `/audits/[id]` route — the hub is master-detail,
                // so an audit's address is the hub with the pane pre-opened.
                // This linked to `/audits/${a.id}` and 404'd on every finding
                // raised outside a cycle.
                return (
                    <Link href={`/t/${tenantSlug}/audits?selected=${a.id}`} className="text-xs text-content-default underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
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
    ]),
    // The status actions only for a role the server lets write; for any
    // other the column would be empty, so it is not built at all.
    ...(canWrite ? createColumns<FindingRow>([
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
    ]) : []),
    // `findingsKey` is listed because the status actions' `updateStatus` is
    // captured here, and it targets the CURRENT list key: without it, a
    // status change after the filter moved painted, and refetched, the list
    // the page was no longer showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ], [t, canWrite, findingsKey]);

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
                        canWrite ? (
                            <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setShowForm(!showForm)}>{t.newFinding}</Button>
                        ) : undefined
                    }
                />
            </ListPageShell.Header>

            {canWrite && (
                <CreateFindingModal
                    open={showForm}
                    setOpen={setShowForm}
                    tenantSlug={tenantSlug}
                    apiUrl={apiUrl}
                />
            )}

            <ListPageShell.Filters>
                <FilterToolbar filters={filterDefs} actions={columnsDropdown} />
            </ListPageShell.Filters>

            <ListPageShell.Body>
                <TruncationBanner truncated={truncated} />
                <DataTable
                    fillBody
                    data={visibleFindings}
                    onReachEnd={hasMoreFindings ? loadMoreFindings : undefined}
                    columns={orderedFindingColumns}
                    getRowId={getFindingRowId}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    // No bulk actions act on ticked rows, so the default-on
                    // select column only made a click tick a row (#4275).
                    // With it off, one click opens the finding's panel.
                    selectionEnabled={false}
                    onRowClick={handleFindingRowClick}
                    emptyState={
                        hasActive ? (
                            <EmptyState
                                size="sm"
                                variant="no-results"
                                title={tx('list.emptyMatchTitle')}
                                description={tx('list.emptyMatchDesc')}
                                secondaryAction={{
                                    label: tx('list.clearFilters'),
                                    onClick: () => clearAll(),
                                }}
                            />
                        ) : (
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t.noFindings}
                                description={tx('list.emptyDesc')}
                            />
                        )
                    }
                    resourceName={(p) => p ? 'findings' : 'finding'}
                    data-testid="findings-table"
                />
            </ListPageShell.Body>

            <FindingDetailSheet
                findingId={openFindingId}
                onClose={closeFinding}
                canWrite={canWrite}
                tenantSlug={tenantSlug}
                onSaved={revalidateFindingLists}
            />
        </ListPageShell>
    );
}
