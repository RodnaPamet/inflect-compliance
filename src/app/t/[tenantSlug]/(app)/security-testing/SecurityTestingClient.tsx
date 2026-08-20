'use client';

/**
 * Security Testing list — DevSecOps scanner findings ingested via SARIF.
 *
 * Sibling of the Vulnerabilities page in the same external-security-signal
 * subsystem: reads SSR-fetched findings, filters client-side by source /
 * severity / status, and surfaces the CWE → OWASP/SSDF cross-walk. Built on
 * the shared EntityListPage + FilterToolbar + DataTable primitives.
 *
 * Findings auto-materialise into the Findings register (the triage surface)
 * on ingest. Per-row triage status edits are live — via
 * `PATCH /security-testing/findings/[id]` (`updateScannerFindingStatus`),
 * surfaced on this page and inline on the asset detail Vulnerabilities tab.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ShieldAlert } from '@/components/ui/icons/nucleo/shield-alert';
import { CloudUpload } from '@/components/ui/icons/nucleo/cloud-upload';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns, DataTable } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast, useThresholdLoadMore } from '@/components/ui/hooks';
import { formatDateTime } from '@/lib/format-date';
import {
    buildScannerFilters,
    SCANNER_FILTER_KEYS,
    buildScannerSourceLabels,
    buildScannerStatusLabels,
} from './filter-defs';

export interface ScannerFindingRow {
    id: string;
    fingerprint: string;
    ruleId: string;
    severity: string;
    title: string;
    description: string | null;
    location: string | null;
    cweIds: string[];
    status: string;
    scannerRun: { source: string; scanType: string; ranAt: string } | null;
    frameworks: { owasp: string[]; ssdf: string[] };
}

export interface ScannerRunRow {
    id: string;
    source: string;
    scanType: string;
    ranAt: string;
    outcome: string;
    repoRef: string | null;
    findingCount: number;
    ingestedVia: string;
}

interface Props {
    initialFindings: ScannerFindingRow[];
    runs: ScannerRunRow[];
    tenantSlug: string;
    canWrite: boolean;
}

const SEVERITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    OPEN: 'error',
    TRIAGED: 'warning',
    FIXED: 'success',
    FALSE_POSITIVE: 'neutral',
    ACCEPTED: 'neutral',
};

// Triage status vocabulary for the editable per-finding control.
const STATUS_ORDER = ['OPEN', 'TRIAGED', 'FIXED', 'FALSE_POSITIVE', 'ACCEPTED'] as const;

// Scanner-run history outcome → StatusBadge tone.
const RUN_OUTCOME_VARIANT: Record<string, StatusBadgeVariant> = {
    PASS: 'success',
    FAIL: 'error',
    ERROR: 'warning',
};

export function SecurityTestingClient(props: Props) {
    const tx = useTranslations('securityTesting');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildScannerFilters(
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tx, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...SCANNER_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <SecurityTestingInner {...props} />
        </FilterProvider>
    );
}

function SecurityTestingInner({ initialFindings, runs, tenantSlug, canWrite }: Props) {
    const t = useTranslations('securityTesting');
    const tGroup = useTranslations('common.filterGroups');
    const router = useRouter();
    const toast = useToast();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    // Local, optimistic view of the SSR findings so per-row triage edits
    // render instantly. Whenever a router.refresh() delivers fresh server
    // rows (new `initialFindings` identity) the local copy resets to server
    // truth — React's "adjust state during render" pattern, no effect needed.
    const [findingRows, setFindingRows] = useState(initialFindings);
    const [prevInitial, setPrevInitial] = useState(initialFindings);
    if (prevInitial !== initialFindings) {
        setPrevInitial(initialFindings);
        setFindingRows(initialFindings);
    }

    // ─── Optimistic PATCH over /security-testing/findings/[id] ───
    const patchStatus = useCallback(
        async (id: string, status: string) => {
            let prevStatus: string | undefined;
            setFindingRows((current) =>
                current.map((r) => {
                    if (r.id !== id) return r;
                    prevStatus = r.status;
                    return { ...r, status };
                }),
            );
            try {
                const res = await fetch(`/api/t/${tenantSlug}/security-testing/findings/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch {
                // Revert the optimistic edit and surface the failure.
                setFindingRows((current) =>
                    current.map((r) =>
                        r.id === id && prevStatus !== undefined ? { ...r, status: prevStatus } : r,
                    ),
                );
                toast.error(t('updateFailed'));
            }
        },
        [tenantSlug, toast, t],
    );

    // ─── SARIF scan upload — read + parse client-side, POST to the ingest
    //     route, then refresh the SSR list with the newly-materialised rows. ──
    const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // Reset the input so re-selecting the same file re-fires onChange.
        event.target.value = '';
        if (!file) return;

        let sarif: unknown;
        try {
            sarif = JSON.parse(await file.text());
        } catch {
            toast.error(t('uploadParseError'));
            return;
        }

        setUploading(true);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/security-testing/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sarif, ingestedVia: 'UPLOAD' }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = (await res.json()) as { findingsIngested?: number };
            toast.success(t('uploadSuccess', { count: result.findingsIngested ?? 0 }));
            router.refresh();
        } catch {
            toast.error(t('uploadError'));
        } finally {
            setUploading(false);
        }
    };

    const uploadAction = canWrite ? (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept=".sarif,.json"
                className="hidden"
                onChange={handleFileSelected}
                aria-hidden="true"
                tabIndex={-1}
            />
            <Button
                variant="secondary"
                icon={<CloudUpload />}
                loading={uploading}
                onClick={() => fileInputRef.current?.click()}
            >
                {t('uploadScan')}
            </Button>
        </>
    ) : undefined;

    // Header actions: a link out to the global Vulnerabilities register
    // alongside the (write-gated) SARIF upload button.
    const headerActions = (
        <div className="flex items-center gap-default">
            <Link
                href={`/t/${tenantSlug}/vulnerabilities`}
                className="inline-flex items-center gap-1 text-sm font-medium text-content-link hover:underline"
            >
                {t('viewAllVulnerabilities')}
            </Link>
            {uploadAction}
        </div>
    );
    const tAdapt = (k: string, v?: Record<string, unknown>) =>
        t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]);
    const sourceLabels = useMemo(() => buildScannerSourceLabels(tAdapt), [t]);
    const statusLabels = useMemo(() => buildScannerStatusLabels(tAdapt), [t]);
    const filterDefs = useMemo(
        () => buildScannerFilters(tAdapt, (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { state, hasActive } = useFilters();

    const rows = useMemo(() => {
        const sources = (state.source ?? []) as string[];
        const severities = (state.severity ?? []) as string[];
        const statuses = (state.status ?? []) as string[];
        return findingRows.filter((r) => {
            if (sources.length && !sources.includes(r.scannerRun?.source ?? '')) return false;
            if (severities.length && !severities.includes(r.severity)) return false;
            if (statuses.length && !statuses.includes(r.status)) return false;
            return true;
        });
    }, [findingRows, state.source, state.severity, state.status]);
    // Render a window, not the whole backfill-capped set. Without this the
    // page mounts every row it fetched and never virtualizes — the default
    // threshold is 1000, so a tenant can sit under it and still re-render
    // hundreds of rows on every filter or sort change. `onReachEnd` extends
    // the window on scroll, the same contract the other list pages use.
    const {
        visibleRows: visibleSecFindings,
        hasMore: hasMoreSecFindings,
        loadMore: loadMoreSecFindings,
    } = useThresholdLoadMore(rows);


    const openCritical = useMemo(
        () => findingRows.filter((r) => r.severity === 'CRITICAL' && r.status === 'OPEN').length,
        [findingRows],
    );

    const statusOptions = useMemo<ComboboxOption[]>(
        () => STATUS_ORDER.map((s) => ({ value: s, label: statusLabels[s] ?? s })),
        [statusLabels],
    );

    const columns = useMemo(
        () =>
            createColumns<ScannerFindingRow>([
                {
                    id: 'severity',
                    header: t('colSeverity'),
                    accessorFn: (r) => r.severity,
                    cell: ({ row }) => (
                        <StatusBadge variant={SEVERITY_VARIANT[row.original.severity] ?? 'neutral'}>
                            {row.original.severity}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'title',
                    header: t('colFinding'),
                    accessorFn: (r) => r.title,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`scanner-finding-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">{row.original.title}</div>
                            <code className="text-xs text-content-subtle font-mono">{row.original.ruleId}</code>
                        </div>
                    ),
                },
                {
                    id: 'source',
                    header: t('colSource'),
                    accessorFn: (r) => r.scannerRun?.source ?? '',
                    cell: ({ row }) => {
                        const src = row.original.scannerRun?.source;
                        if (!src) return <span className="text-content-muted">—</span>;
                        return (
                            <span className="text-content-muted">
                                {sourceLabels[src] ?? src}
                                <span className="text-content-subtle"> · {row.original.scannerRun?.scanType}</span>
                            </span>
                        );
                    },
                },
                {
                    id: 'location',
                    header: t('colLocation'),
                    accessorFn: (r) => r.location ?? '',
                    cell: ({ row }) =>
                        row.original.location ? (
                            <code className="text-xs text-content-muted font-mono">{row.original.location}</code>
                        ) : (
                            <span className="text-content-muted">—</span>
                        ),
                },
                {
                    id: 'frameworks',
                    header: t('colMapsTo'),
                    accessorFn: (r) => r.frameworks.owasp.join(',') + r.frameworks.ssdf.join(','),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const { owasp, ssdf } = row.original.frameworks;
                        if (!owasp.length && !ssdf.length) return <span className="text-content-muted">—</span>;
                        return (
                            <div className="flex flex-wrap gap-tight">
                                {owasp.map((o) => (
                                    <span key={o} className="text-xs text-content-muted">
                                        {o.split('-')[0]}
                                    </span>
                                ))}
                                {ssdf.map((s) => (
                                    <span key={s} className="text-xs text-content-subtle">
                                        SSDF {s}
                                    </span>
                                ))}
                            </div>
                        );
                    },
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
            ]),
        [t, canWrite, statusOptions, statusLabels, patchStatus, sourceLabels],
    );

    // ─── Scanner-run history table (own card, below the findings table) ───
    const runColumns = useMemo(
        () =>
            createColumns<ScannerRunRow>([
                {
                    id: 'outcome',
                    header: t('colOutcome'),
                    accessorFn: (r) => r.outcome,
                    cell: ({ row }) => (
                        <StatusBadge variant={RUN_OUTCOME_VARIANT[row.original.outcome] ?? 'neutral'}>
                            {row.original.outcome}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'source',
                    header: t('colSourceScan'),
                    accessorFn: (r) => r.source,
                    cell: ({ row }) => (
                        <span className="text-content-default">
                            {sourceLabels[row.original.source] ?? row.original.source}
                            <span className="text-content-subtle"> · {row.original.scanType}</span>
                        </span>
                    ),
                },
                {
                    id: 'repo',
                    header: t('colRepo'),
                    accessorFn: (r) => r.repoRef ?? '',
                    cell: ({ row }) =>
                        row.original.repoRef ? (
                            <code className="text-xs text-content-muted font-mono">{row.original.repoRef}</code>
                        ) : (
                            <span className="text-content-muted">—</span>
                        ),
                },
                {
                    id: 'ranAt',
                    header: t('colRan'),
                    accessorFn: (r) => new Date(r.ranAt).getTime(),
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">{formatDateTime(row.original.ranAt)}</span>
                    ),
                },
                {
                    id: 'ingestedVia',
                    header: t('colVia'),
                    accessorFn: (r) => r.ingestedVia,
                    cell: ({ row }) => <span className="text-content-muted">{row.original.ingestedVia}</span>,
                },
                {
                    id: 'findingCount',
                    header: t('colFindings'),
                    accessorFn: (r) => r.findingCount,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-default">{row.original.findingCount}</span>
                    ),
                },
            ]),
        [t, sourceLabels],
    );

    const runsHistory = (
        <Card as="section" className="mt-section space-y-default">
            <Heading level={3}>{t('runsHistoryTitle')}</Heading>
            <DataTable<ScannerRunRow>
                fillBody={false}
                data={runs}
                columns={runColumns}
                getRowId={(r) => r.id}
                resourceName={(plural) => (plural ? t('resourceRuns') : t('resourceRun'))}
                emptyState={
                    <EmptyState
                        icon={ShieldAlert}
                        title={t('runsEmptyTitle')}
                        description={t('runsEmptyDesc')}
                    />
                }
            />
        </Card>
    );

    const description =
        runs.length === 0
            ? t('descEmpty')
            : t('descActive', { runs: runs.length, critical: openCritical });

    return (
        <EntityListPage<ScannerFindingRow>
            header={{
                // Reached from the Internal Audit "Scans" link, not the
                // sidebar. Smart back resolves "Back to Internal Audit".
                back: { smart: true },
                title: (
                    <>
                        <ShieldAlert className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                        {t('title')}
                    </>
                ),
                description,
                actions: headerActions,
            }}
            filters={{ defs: filterDefs }}
            tableFooter={runsHistory}
            table={{
                fillBody: false,
                data: visibleSecFindings,
                onReachEnd: hasMoreSecFindings ? loadMoreSecFindings : undefined,
                columns,
                getRowId: (r) => r.id,
                resourceName: (plural) => (plural ? t('resourceFindings') : t('resourceFinding')),
                emptyState: (
                    <EmptyState
                        icon={ShieldAlert}
                        title={hasActive ? t('emptyMatchTitle') : t('emptyTitle')}
                        description={
                            hasActive
                                ? t('emptyMatchDesc')
                                : t('emptyDesc', { slug: tenantSlug })
                        }
                    />
                ),
            }}
        />
    );
}
