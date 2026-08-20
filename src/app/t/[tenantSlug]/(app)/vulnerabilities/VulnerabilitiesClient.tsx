'use client';

/**
 * Vulnerabilities list — matched CVEs across the tenant's assets.
 *
 * Reads SSR-fetched rows, filters client-side by status / severity, and
 * exposes both the compliance-graph bridge (convert a vulnerability into a
 * Risk or a Finding) and the in-row triage workflow: change status, assign an
 * owner, set a remediation due date, and spawn a remediation Task — all with
 * optimistic updates over the existing PATCH / remediation-task endpoints.
 * Built on the shared EntityListPage + FilterToolbar + DataTable primitives.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ShieldAlert } from '@/components/ui/icons/nucleo/shield-alert';
import { ArrowUpRight } from '@/components/ui/icons/nucleo/arrow-up-right';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { PenWriting } from '@/components/ui/icons/nucleo/pen-writing';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox, type Member } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { toYMD } from '@/components/ui/date-picker/date-utils';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoTooltip } from '@/components/ui/tooltip';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { useToast, useEnterSubmit, useThresholdLoadMore } from '@/components/ui/hooks';
import { useTenantSWR } from '@/lib/hooks';
import { unwrapCappedList, type CappedList } from '@/lib/list-backfill-cap';
import { formatDate } from '@/lib/format-date';
import { buildVulnFilters, VULN_FILTER_KEYS, buildVulnStatusLabels } from './filter-defs';

/** CVE-sync freshness + reach, lazy-fetched from /vulnerabilities/status. */
interface CveSyncStatus {
    syncEnabled: boolean;
    lastSyncedAt: string | null;
    assetsTotal: number;
    assetsWithIdentity: number;
}

const VULN_STATUS_ORDER = ['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'FALSE_POSITIVE'] as const;

export interface VulnRow {
    id: string;
    status: string;
    matchedVia: string;
    cveId: string;
    ownerUserId: string | null;
    ownerUser: { id: string; name: string | null; email: string | null } | null;
    remediationDueAt: string | Date | null;
    remediationTaskId: string | null;
    remediationTask: { id: string; key: string | null } | null;
    /** Free-text analyst note (encrypted at rest; plaintext on the row). */
    note: string | null;
    cve: {
        id: string;
        cvssScore: number | null;
        cvssSeverity: string | null;
        summary: string;
        references: string[];
    };
    asset: { id: string; key: string | null; name: string };
}

interface Props {
    initialRows: VulnRow[];
    tenantSlug: string;
    canWrite: boolean;
}

/** Minimal asset shape the "Link CVE" picker consumes from GET /assets. */
interface AssetOption {
    id: string;
    name: string;
    key: string | null;
}

const SEVERITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    OPEN: 'error',
    MITIGATING: 'warning',
    MITIGATED: 'success',
    ACCEPTED: 'neutral',
    FALSE_POSITIVE: 'neutral',
};

export function VulnerabilitiesClient({ initialRows, tenantSlug, canWrite }: Props) {
    const tx = useTranslations('vulnerabilities');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildVulnFilters(
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tx, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...VULN_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <VulnerabilitiesInner initialRows={initialRows} tenantSlug={tenantSlug} canWrite={canWrite} />
        </FilterProvider>
    );
}

function VulnerabilitiesInner({ initialRows, tenantSlug, canWrite }: Props) {
    const t = useTranslations('vulnerabilities');
    const tGroup = useTranslations('common.filterGroups');
    const tAdapt = (k: string, v?: Record<string, unknown>) =>
        t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]);
    const statusLabels = useMemo(() => buildVulnStatusLabels(tAdapt), [t]);
    const filterDefs = useMemo(
        () => buildVulnFilters(tAdapt, (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const router = useRouter();
    const toast = useToast();
    const { state, hasActive } = useFilters();
    // Lazy CVE-sync status — powers the header strip + the honest empty state.
    const { data: syncStatus } = useTenantSWR<CveSyncStatus>('/vulnerabilities/status');
    const [pendingId, setPendingId] = useState<string | null>(null);
    // Optimistic overlay of triage edits on top of the SSR rows, keyed by id.
    // Whenever a router.refresh() delivers fresh server rows (new `initialRows`
    // identity) the overlay resets to server truth — React's "adjust state
    // during render" pattern, no effect required.
    const [overrides, setOverrides] = useState<Record<string, Partial<VulnRow>>>({});
    const [prevInitial, setPrevInitial] = useState(initialRows);
    if (prevInitial !== initialRows) {
        setPrevInitial(initialRows);
        setOverrides({});
    }

    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const rowData = useMemo(
        () => initialRows.map((r) => (overrides[r.id] ? { ...r, ...overrides[r.id] } : r)),
        [initialRows, overrides],
    );

    const rows = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        const severities = (state.severity ?? []) as string[];
        return rowData.filter((r) => {
            if (statuses.length && !statuses.includes(r.status)) return false;
            if (severities.length && !severities.includes((r.cve.cvssSeverity ?? '').toUpperCase())) return false;
            return true;
        });
    }, [rowData, state.status, state.severity]);
    // Render a window, not the whole backfill-capped set. Without this the
    // page mounts every row it fetched and never virtualizes — the default
    // threshold is 1000, so a tenant can sit under it and still re-render
    // hundreds of rows on every filter or sort change. `onReachEnd` extends
    // the window on scroll, the same contract the other list pages use.
    const {
        visibleRows: visibleVulnRows,
        hasMore: hasMoreVulnRows,
        loadMore: loadMoreVulnRows,
    } = useThresholdLoadMore(rows);


    const applyOverride = useCallback(
        (id: string, patch: Partial<VulnRow>) =>
            setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })),
        [],
    );
    const clearOverride = useCallback(
        (id: string) => setOverrides((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
        }),
        [],
    );

    // ─── Optimistic PATCH over the existing /vulnerabilities/[id] endpoint ───
    const patchVuln = useCallback(
        async (id: string, body: Record<string, unknown>, optimistic: Partial<VulnRow>) => {
            applyOverride(id, optimistic);
            try {
                const res = await fetch(apiUrl(`/vulnerabilities/${id}`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch {
                clearOverride(id);
                toast.error(t('updateFailed'));
                router.refresh();
            }
        },
        [apiUrl, applyOverride, clearOverride, router, toast, t],
    );

    const patchStatus = useCallback(
        (id: string, status: string) => patchVuln(id, { status }, { status }),
        [patchVuln],
    );

    const patchOwner = useCallback(
        (id: string, userId: string | null, member: Member | null) =>
            patchVuln(
                id,
                { ownerUserId: userId },
                {
                    ownerUserId: userId,
                    ownerUser: userId && member ? { id: member.id, name: member.name, email: member.email } : null,
                },
            ),
        [patchVuln],
    );

    const patchDue = useCallback(
        (id: string, next: Date | null) => {
            const ymd = toYMD(next);
            return patchVuln(id, { remediationDueAt: ymd }, { remediationDueAt: ymd ?? null });
        },
        [patchVuln],
    );

    const patchNote = useCallback(
        (id: string, note: string | null) => {
            const trimmed = note && note.trim().length ? note.trim() : null;
            return patchVuln(id, { note: trimmed }, { note: trimmed });
        },
        [patchVuln],
    );

    // "Link CVE" modal (manual AssetVulnerability creation).
    const [linkOpen, setLinkOpen] = useState(false);

    const convertToRisk = useCallback(
        async (row: VulnRow) => {
            setPendingId(row.id);
            try {
                const res = await fetch(apiUrl(`/vulnerabilities/${row.id}/convert-to-risk`), { method: 'POST' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                toast.success(t('riskCreated'));
                router.refresh();
            } catch {
                toast.error(t('convertFailed', { target: 'risk' }));
            } finally {
                setPendingId(null);
            }
        },
        [apiUrl, router, toast, t],
    );

    const convert = useCallback(
        async (row: VulnRow, target: 'risk' | 'finding') => {
            if (target === 'risk') return convertToRisk(row);
            setPendingId(row.id);
            try {
                const res = await fetch(apiUrl(`/vulnerabilities/${row.id}/convert-to-finding`), { method: 'POST' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = (await res.json().catch(() => null)) as { nudge?: { suggestElevateToRisk?: boolean } } | null;
                if (body?.nudge?.suggestElevateToRisk) {
                    // Finding may under-capture a HIGH/CRITICAL vuln — offer to
                    // also elevate to a Risk (opt-in, never automatic).
                    toast.info(t('elevateNudge'), { action: { label: t('elevateAction'), onClick: () => void convertToRisk(row) } });
                } else {
                    toast.success(t('findingCreated'));
                }
                router.refresh();
            } catch {
                toast.error(t('convertFailed', { target: 'finding' }));
            } finally {
                setPendingId(null);
            }
        },
        [apiUrl, convertToRisk, router, toast, t],
    );

    const createRemediationTask = useCallback(
        async (row: VulnRow) => {
            setPendingId(row.id);
            try {
                const res = await fetch(apiUrl(`/vulnerabilities/${row.id}/remediation-task`), { method: 'POST' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const task = (await res.json()) as { id: string; key: string | null };
                applyOverride(row.id, {
                    remediationTaskId: task.id,
                    remediationTask: { id: task.id, key: task.key },
                });
                toast.success(t('taskCreated'));
                router.refresh();
            } catch {
                toast.error(t('taskCreateFailed'));
            } finally {
                setPendingId(null);
            }
        },
        [apiUrl, applyOverride, router, toast, t],
    );

    const statusOptions = useMemo<ComboboxOption[]>(
        () => VULN_STATUS_ORDER.map((s) => ({ value: s, label: statusLabels[s] ?? s })),
        [statusLabels],
    );

    const columns = useMemo(() => createColumns<VulnRow>([
        {
            id: 'cve',
            header: t('colCve'),
            accessorFn: (r) => r.cve.id,
            cell: ({ row }) => {
                const cve = row.original.cve;
                const href = cve.references[0] ?? `https://nvd.nist.gov/vuln/detail/${cve.id}`;
                return (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`vuln-cve-${row.original.id}`}
                        className="inline-flex items-center gap-1 font-medium text-content-link hover:underline"
                    >
                        {cve.id}
                        <ArrowUpRight className="h-3 w-3 shrink-0" />
                    </a>
                );
            },
        },
        {
            id: 'asset',
            header: t('colAsset'),
            accessorFn: (r) => r.asset.name,
            cell: ({ row }) => (
                <span className="text-content-default">
                    {row.original.asset.key ? `${row.original.asset.key} · ` : ''}
                    {row.original.asset.name}
                </span>
            ),
        },
        {
            id: 'severity',
            header: t('colSeverity'),
            accessorFn: (r) => r.cve.cvssSeverity ?? '',
            cell: ({ row }) => {
                const sev = (row.original.cve.cvssSeverity ?? '').toUpperCase();
                if (!sev) return <span className="text-content-muted">—</span>;
                return <StatusBadge variant={SEVERITY_VARIANT[sev] ?? 'neutral'}>{sev}</StatusBadge>;
            },
        },
        {
            id: 'cvss',
            header: t('colCvss'),
            accessorFn: (r) => r.cve.cvssScore ?? -1,
            cell: ({ row }) => (
                <span className="tabular-nums text-content-muted">
                    {row.original.cve.cvssScore != null ? row.original.cve.cvssScore.toFixed(1) : '—'}
                </span>
            ),
        },
        {
            id: 'matchedVia',
            header: t('colMatched'),
            accessorFn: (r) => r.matchedVia,
            cell: ({ row }) => <span className="text-content-muted">{row.original.matchedVia}</span>,
        },
        {
            id: 'status',
            header: t('colStatus'),
            accessorFn: (r) => r.status,
            cell: ({ row }) => {
                const r = row.original;
                if (!canWrite) {
                    return (
                        <StatusBadge variant={STATUS_VARIANT[r.status] ?? 'neutral'}>
                            {statusLabels[r.status] ?? r.status}
                        </StatusBadge>
                    );
                }
                return (
                    <Combobox
                        options={statusOptions}
                        selected={statusOptions.find((o) => o.value === r.status) ?? null}
                        setSelected={(opt) => opt && patchStatus(r.id, opt.value)}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ size: 'sm', 'aria-label': t('colStatus') }}
                    />
                );
            },
        },
        {
            id: 'owner',
            header: t('colOwner'),
            accessorFn: (r) => r.ownerUser?.name ?? r.ownerUser?.email ?? '',
            cell: ({ row }) => {
                const r = row.original;
                if (!canWrite) {
                    const label = r.ownerUser?.name ?? r.ownerUser?.email;
                    return label ? (
                        <span className="text-content-default">{label}</span>
                    ) : (
                        <span className="text-content-muted">{t('unassigned')}</span>
                    );
                }
                return (
                    <UserCombobox
                        tenantSlug={tenantSlug}
                        size="sm"
                        matchTriggerWidth
                        selectedId={r.ownerUserId}
                        onChange={(userId, member) => patchOwner(r.id, userId, member)}
                        placeholder={t('assignOwner')}
                    />
                );
            },
        },
        {
            id: 'due',
            header: t('colDue'),
            accessorFn: (r) => (r.remediationDueAt ? new Date(r.remediationDueAt).getTime() : -1),
            cell: ({ row }) => {
                const r = row.original;
                if (!canWrite) {
                    return r.remediationDueAt ? (
                        <span className="tabular-nums text-content-default">{formatDate(r.remediationDueAt)}</span>
                    ) : (
                        <span className="text-content-muted">—</span>
                    );
                }
                return (
                    <DatePicker
                        clearable
                        align="start"
                        placeholder={t('setDue')}
                        value={r.remediationDueAt ? new Date(r.remediationDueAt) : null}
                        onChange={(next) => patchDue(r.id, next)}
                        aria-label={t('colDue')}
                    />
                );
            },
        },
        {
            id: 'remediation',
            header: t('colRemediation'),
            cell: ({ row }) => {
                const r = row.original;
                if (r.remediationTaskId) {
                    return (
                        <Link
                            href={`/t/${tenantSlug}/tasks/${r.remediationTaskId}`}
                            className="inline-flex items-center gap-1 font-medium text-content-link hover:underline"
                        >
                            {r.remediationTask?.key ?? t('viewTask')}
                            <ArrowUpRight className="h-3 w-3 shrink-0" />
                        </Link>
                    );
                }
                if (!canWrite) return <span className="text-content-muted">—</span>;
                return (
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={pendingId === r.id}
                        onClick={() => createRemediationTask(r)}
                    >
                        {t('createTask')}
                    </Button>
                );
            },
        },
        {
            id: 'note',
            header: t('colNote'),
            accessorFn: (r) => r.note ?? '',
            cell: ({ row }) => (
                <NoteCell
                    row={row.original}
                    canWrite={canWrite}
                    onSave={patchNote}
                    emptyLabel={t('addNote')}
                    editLabel={t('editNote')}
                    placeholder={t('notePlaceholder')}
                />
            ),
        },
        ...(canWrite
            ? [{
                id: 'actions',
                header: '',
                cell: ({ row }: { row: { original: VulnRow } }) => (
                    <div className="flex justify-end gap-default">
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={pendingId === row.original.id}
                            onClick={() => convert(row.original, 'risk')}
                        >
                            {t('toRisk')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={pendingId === row.original.id}
                            onClick={() => convert(row.original, 'finding')}
                        >
                            {t('toFinding')}
                        </Button>
                    </div>
                ),
            }]
            : []),
    ]), [
        canWrite,
        convert,
        createRemediationTask,
        patchStatus,
        patchOwner,
        patchDue,
        patchNote,
        pendingId,
        statusOptions,
        statusLabels,
        tenantSlug,
        t,
    ]);

    // Compact CVE-sync status strip — "CVE sync: on · last updated {date}"
    // or "CVE sync: disabled". Rendered in the header actions slot; only
    // appears once the lazy status has resolved.
    const syncStrip = syncStatus ? (
        <div className="flex items-center gap-tight text-xs text-content-muted">
            <span className="text-content-subtle">{t('cveSyncLabel')}</span>
            {syncStatus.syncEnabled ? (
                <StatusBadge variant="success">{t('cveSyncOn')}</StatusBadge>
            ) : (
                <StatusBadge variant="neutral">{t('cveSyncDisabled')}</StatusBadge>
            )}
            {syncStatus.syncEnabled && syncStatus.lastSyncedAt && (
                <span className="tabular-nums text-content-muted">
                    {t('cveSyncUpdated', { date: formatDate(syncStatus.lastSyncedAt) })}
                </span>
            )}
            <InfoTooltip content={t('cveSyncHelp')} aria-label={t('cveSyncLabel')} />
        </div>
    ) : undefined;

    // Header actions: the sync strip plus a manual "Link CVE" affordance
    // (write users only) that opens the AssetVulnerability create modal.
    const headerActions = (syncStrip || canWrite) ? (
        <div className="flex items-center gap-default">
            {syncStrip}
            {canWrite && (
                <Button
                    id="vuln-link-cve-trigger"
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-4 w-4" />}
                    onClick={() => setLinkOpen(true)}
                >
                    {t('linkCve')}
                </Button>
            )}
        </div>
    ) : undefined;

    // Honest empty state — distinguish filtered-out from three list-empty
    // cases (sync off → no asset identity → genuinely clean), checked in order.
    const emptyState = hasActive ? (
        <EmptyState icon={ShieldAlert} title={t('emptyFilteredTitle')} description={t('emptyFilteredDesc')} />
    ) : syncStatus && !syncStatus.syncEnabled ? (
        <EmptyState icon={ShieldAlert} title={t('emptyDisabledTitle')} description={t('emptyDisabledDesc')} />
    ) : syncStatus && syncStatus.assetsWithIdentity === 0 ? (
        <EmptyState
            icon={ShieldAlert}
            title={t('emptyNoIdentityTitle')}
            description={t('emptyNoIdentityDesc')}
            primaryAction={{ label: t('emptyNoIdentityAction'), href: `/t/${tenantSlug}/assets` }}
        />
    ) : (
        <EmptyState icon={ShieldAlert} title={t('emptyCleanTitle')} description={t('emptyCleanDesc')} />
    );

    return (
        <EntityListPage<VulnRow>
            header={{
                // Reached from the Risk register / asset detail, not the
                // sidebar. Smart back resolves "Back to Risk Register".
                back: { smart: true },
                breadcrumbs: [
                    { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('crumbRisk'), href: `/t/${tenantSlug}/risks` },
                    { label: t('crumbTitle') },
                ],
                title: (
                    <>
                        <ShieldAlert className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                        {t('title')}
                    </>
                ),
                description: t('description'),
                actions: headerActions,
            }}
            filters={{ defs: filterDefs }}
            table={{
                data: visibleVulnRows,
                onReachEnd: hasMoreVulnRows ? loadMoreVulnRows : undefined,
                columns,
                getRowId: (r) => r.id,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                emptyState,
            }}
        >
            {canWrite && linkOpen && (
                <LinkCveModal
                    apiUrl={apiUrl}
                    onClose={() => setLinkOpen(false)}
                    onSuccess={() => {
                        setLinkOpen(false);
                        router.refresh();
                    }}
                />
            )}
        </EntityListPage>
    );
}

/**
 * Inline-editable Note cell. Read users see the truncated note (or "—");
 * write users get a click-to-edit affordance that commits via the
 * optimistic `patchNote` on blur / Enter, and cancels on Escape.
 */
function NoteCell({
    row,
    canWrite,
    onSave,
    emptyLabel,
    editLabel,
    placeholder,
}: {
    row: VulnRow;
    canWrite: boolean;
    onSave: (id: string, note: string | null) => void;
    emptyLabel: string;
    editLabel: string;
    placeholder: string;
}) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(row.note ?? '');
    // Bare-Enter commits (single-line note); Escape cancels. Enter goes through
    // the shared useEnterSubmit hook rather than a hand-rolled key handler.
    const commit = () => {
        setEditing(false);
        const next = value.trim().length ? value.trim() : null;
        if ((row.note ?? null) !== next) onSave(row.id, next);
    };
    const { handleKeyDown } = useEnterSubmit({ modifier: 'always', onSubmit: () => commit() });

    if (!canWrite) {
        return row.note ? (
            <span className="block max-w-xs truncate text-content-default">
                {row.note}
            </span>
        ) : (
            <span className="text-content-muted">—</span>
        );
    }

    if (editing) {
        return (
            <Input
                autoFocus
                size="sm"
                value={value}
                placeholder={placeholder}
                aria-label={editLabel}
                onChange={(e) => setValue(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    handleKeyDown(e);
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        setValue(row.note ?? '');
                        setEditing(false);
                    }
                }}
            />
        );
    }

    return (
        <button
            type="button"
            aria-label={editLabel}
            onClick={() => {
                setValue(row.note ?? '');
                setEditing(true);
            }}
            className="group inline-flex max-w-xs items-center gap-tight text-left text-content-default hover:text-content-emphasis"
        >
            {row.note ? (
                <span className="truncate">{row.note}</span>
            ) : (
                <span className="text-content-muted">{emptyLabel}</span>
            )}
            <PenWriting className="h-3 w-3 shrink-0 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
    );
}

/**
 * Manual "Link a CVE to an asset" modal. Fetches the tenant's assets lazily
 * (only while mounted), then POSTs { assetId, cveId, note } to the
 * /vulnerabilities create endpoint, surfacing the server error message on
 * an unknown-CVE / unknown-asset failure.
 */
function LinkCveModal({
    apiUrl,
    onClose,
    onSuccess,
}: {
    apiUrl: (path: string) => string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('vulnerabilities');
    const tc = useTranslations('common');
    const toast = useToast();
    const { data: assets, isLoading } = useTenantSWR<
        CappedList<AssetOption> | AssetOption[]
    >('/assets');
    const [assetId, setAssetId] = useState<string | null>(null);
    const [cveId, setCveId] = useState('');
    const [note, setNote] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const assetOptions = useMemo<ComboboxOption[]>(
        () =>
            // GET /assets returns the backfill-capped `{ rows, truncated }`
            // envelope, not a bare array. Calling `.map` on the object threw
            // "map is not a function" and the error boundary replaced the
            // whole page — see `unwrapCappedList`.
            unwrapCappedList(assets).map((a) => ({
                value: a.id,
                label: a.key ? `${a.key} · ${a.name}` : a.name,
            })),
        [assets],
    );

    const valid = Boolean(assetId) && cveId.trim().length > 0;

    const handleSubmit = async () => {
        if (!valid || !assetId) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/vulnerabilities'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assetId,
                    cveId: cveId.trim(),
                    note: note.trim().length ? note.trim() : undefined,
                }),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as
                    | { error?: { message?: string } }
                    | null;
                throw new Error(body?.error?.message || t('linkCveFailed'));
            }
            toast.success(t('linkCveSuccess'));
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('linkCveFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()} size="sm">
            <Modal.Header title={t('linkCveHeader')} description={t('linkCveDescription')} />
            <Modal.Body>
                <div className="space-y-default">
                    <FormField label={t('linkCveAsset')} required>
                        <Combobox
                            id="vuln-link-asset"
                            options={assetOptions}
                            selected={assetOptions.find((o) => o.value === assetId) ?? null}
                            setSelected={(opt) => setAssetId(opt ? String(opt.value) : null)}
                            placeholder={isLoading ? tc('loading') : t('linkCveAssetPlaceholder')}
                            disabled={isLoading}
                        />
                    </FormField>
                    <FormField label={t('linkCveId')} required>
                        <Input
                            id="vuln-link-cve-id"
                            value={cveId}
                            onChange={(e) => setCveId(e.target.value)}
                            placeholder={t('linkCveIdPlaceholder')}
                        />
                    </FormField>
                    <FormField label={t('linkCveNote')}>
                        <Input
                            id="vuln-link-note"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={t('linkCveNotePlaceholder')}
                        />
                    </FormField>
                    {error ? (
                        <p className="text-sm text-content-error">{error}</p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Actions>
                <Button variant="secondary" size="sm" onClick={onClose}>
                    {tc('cancel')}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    disabled={!valid || submitting}
                    onClick={() => void handleSubmit()}
                >
                    {submitting ? t('linkCveSubmitting') : t('linkCveSubmit')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
