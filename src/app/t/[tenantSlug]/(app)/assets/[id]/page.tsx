'use client';

import { formatDate, formatDateTime } from '@/lib/format-date';
import { SkeletonCard } from '@/components/ui/skeleton';
import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMembers, UserCombobox, type Member } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { toYMD } from '@/components/ui/date-picker/date-utils';
import { Input } from '@/components/ui/input';
import { useEnterSubmit, useToast, useToastWithUndo } from '@/components/ui/hooks';
import { PenWriting } from '@/components/ui/icons/nucleo/pen-writing';
import { ownerDisplayName } from '@/lib/owner-display';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import LinkedTasksPanel from '@/components/LinkedTasksPanel';
import { LinkedVendorsPanel } from '@/components/LinkedVendorsPanel';
import { EmptyState } from '@/components/ui/empty-state';
import { CopyText } from '@/components/ui/copy-text';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Pen2, Trash } from '@/components/ui/icons/nucleo';
import { Tooltip, InfoTooltip } from '@/components/ui/tooltip';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { DataTable, type ColumnDef } from '@/components/ui/table';
import { Eyebrow } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import type { AuditLogEntry } from '@/lib/dto';
import { AssetCriticalityBadge } from '../_form/AssetCriticalityFields';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { ProcessNodeReverseLookupModal } from '@/components/processes/ProcessNodeReverseLookupModal';
import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { EditAssetModal } from '../EditAssetModal';
import { InheritedEvidencePanel } from '@/components/InheritedEvidencePanel';
import { AttachedEvidencePanel } from '@/components/AttachedEvidencePanel';
import { Heading } from '@/components/ui/typography';
import { InheritedTestPlansPanel } from '@/components/InheritedTestPlansPanel';
import { InheritedMappingsPanel } from '@/components/InheritedMappingsPanel';

const TraceabilityPanel = dynamic(() => import('@/components/TraceabilityPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});

// getAsset → AssetRepository.getById (the Asset model; controls relation
// fetched but unread here).
/**
 * `AssetDetail` and `AssetRollups` now live in `@/lib/dto/asset.types` —
 * this page is a route module, not a home for a domain type. They are
 * re-exported here only so existing `from './[id]/page'` imports keep
 * working; new code should import from the shared module directly.
 */
import type { AssetDetail } from '@/lib/dto/asset.types';
export type { AssetDetail, AssetRollups } from '@/lib/dto/asset.types';

/** One matched vulnerability row (GET /vulnerabilities?assetId=…). */
interface AssetVulnRow {
    id: string;
    status: string;
    matchedVia: string;
    remediationDueAt: string | null;
    note: string | null;
    ownerUserId: string | null;
    cve: { id: string; cvssScore: number | null; cvssSeverity: string | null; summary: string } | null;
    ownerUser: { id: string; name: string | null; email: string | null } | null;
}

/** One scanner finding resolved to this asset (GET /assets/[id]/scanner-findings). */
interface AssetScannerFindingRow {
    id: string;
    ruleId: string;
    severity: string;
    title: string;
    location: string | null;
    status: string;
    scannerRun: { source: string; scanType: string; ranAt: string } | null;
}

/** CVSS severity → StatusBadge variant. CRITICAL/HIGH → red, MEDIUM → amber, LOW → green. */
function severityVariant(sev: string | null | undefined): StatusBadgeVariant {
    const s = (sev ?? '').toUpperCase();
    if (s === 'CRITICAL' || s === 'HIGH') return 'error';
    if (s === 'MEDIUM') return 'warning';
    if (s === 'LOW') return 'success';
    return 'neutral';
}

/** Vuln remediation status → StatusBadge variant. */
function vulnStatusVariant(status: string): StatusBadgeVariant {
    switch (status) {
        case 'OPEN': return 'error';
        case 'MITIGATING': return 'warning';
        case 'MITIGATED': return 'success';
        case 'ACCEPTED': return 'info';
        default: return 'neutral';
    }
}

/** Scanner-finding triage status → StatusBadge variant (was hardcoded neutral). */
function scannerStatusVariant(status: string): StatusBadgeVariant {
    switch (status) {
        case 'OPEN': return 'error';
        case 'TRIAGED': return 'warning';
        case 'FIXED': return 'success';
        case 'ACCEPTED': return 'info';
        case 'FALSE_POSITIVE': return 'neutral';
        default: return 'neutral';
    }
}

// Client-safe copies of the server triage enums — do NOT import the server
// usecase consts (VULN_STATUSES / SCANNER_FINDING_STATUSES) into this client
// component; that would bundle server code.
const VULN_STATUS_VALUES = ['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'FALSE_POSITIVE'] as const;
const SCANNER_STATUS_VALUES = ['OPEN', 'TRIAGED', 'FIXED', 'FALSE_POSITIVE', 'ACCEPTED'] as const;

export default function AssetDetailPage() {
    const params = useParams();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions, tenantSlug } = useTenantContext();
    const t = useTranslations('assets');
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const assetId = params.id as string;

    const assetQuery = useTenantSWR<AssetDetail>(`/assets/${assetId}`);
    const asset = assetQuery.data ?? null;
    const loading = assetQuery.isLoading;
    const loadError = assetQuery.error
        ? (assetQuery.error instanceof Error ? assetQuery.error.message : String(assetQuery.error))
        : '';
    // Mutation-error channel (status change etc.); load errors come from SWR above.
    const [error, setError] = useState('');
    // PR-D — "Where used" (process maps) reverse-lookup modal.
    const tWhereUsed = useTranslations('panels.processWhereUsed');
    const [processWhereUsedOpen, setProcessWhereUsedOpen] = useState(false);

    // One owner concept: the resolved assignee (ownerUserId → member). The
    // server includes `ownerUser`; the tenant roster is a fallback. The legacy
    // free-text `owner` is import-only and shown separately (labeled) ONLY when
    // there is no assignee — never a competing second "Owner".
    const { data: members } = useTenantMembers(tenantSlug);
    const ownerName = asset
        ? (asset.ownerUser
              ? ownerDisplayName(asset.ownerUser.name, asset.ownerUser.email)
              : asset.ownerUserId
                ? ownerDisplayName(
                      members?.find((m) => m.id === asset.ownerUserId)?.name,
                      members?.find((m) => m.id === asset.ownerUserId)?.email,
                  )
                : null)
        : null;
    const importedOwner = asset && !ownerName && asset.owner ? asset.owner : null;

    // B6 +1 — canonical 7-tab strip on every detail page. Same shape
    // as Controls / Risks: Overview holds the existing asset body;
    // Tasks + Traceability are inline-routed to the already-mounted
    // panels; the other four explain where the related-entity surface
    // lives.
    type Tab =
        | 'overview'
        | 'vulnerabilities'
        | 'tasks'
        | 'evidence'
        | 'mappings'
        | 'traceability'
        | 'activity'
        | 'tests';
    const [activeTab, setActiveTab] = useState<Tab>('overview');
    const tabs: ReadonlyArray<{ key: Tab; label: string }> = [
        { key: 'overview', label: t('detail.tabs.overview') },
        { key: 'vulnerabilities', label: t('detail.tabs.vulnerabilities') },
        { key: 'tasks', label: t('detail.tabs.tasks') },
        { key: 'evidence', label: t('detail.tabs.evidence') },
        { key: 'mappings', label: t('detail.tabs.mappings') },
        { key: 'traceability', label: t('detail.tabs.traceability') },
        { key: 'activity', label: t('detail.tabs.activity') },
        { key: 'tests', label: t('detail.tabs.tests') },
    ];

    // ─── Activity feed (lazy, only while the Activity tab is open) ───
    // Asset mutations log with entity='Asset'; these are the action
    // types surfaced with a friendly label (unknown falls back to raw).
    const ASSET_EVENT_KEYS = ['CREATE', 'UPDATE', 'SOFT_DELETE', 'ENTITY_RESTORED', 'ASSET_EVIDENCE_LINKED', 'ASSET_EVIDENCE_UNLINKED'] as const;
    const EVENT_LABELS: Record<string, string> = Object.fromEntries(
        ASSET_EVENT_KEYS.map((k) => [k, t(`detail.eventLabels.${k}`)]),
    );
    const activityQuery = useTenantSWR<AuditLogEntry[]>(
        activeTab === 'activity' ? `/assets/${assetId}/activity` : null,
    );
    const activity = activityQuery.data ?? [];
    const activityLoading = activityQuery.isLoading;

    // ─── Vulnerabilities feed (lazy, only while that tab is open) ───
    const vulnQuery = useTenantSWR<{ rows: AssetVulnRow[] }>(
        activeTab === 'vulnerabilities' ? `/vulnerabilities?assetId=${assetId}` : null,
    );
    const vulnRows = vulnQuery.data?.rows ?? [];
    const vulnLoading = vulnQuery.isLoading;
    // Scanner findings resolved to this asset — rendered alongside the CVE
    // vulnerabilities so the asset shows its full vulnerability picture.
    const scannerQuery = useTenantSWR<{ rows: AssetScannerFindingRow[] }>(
        activeTab === 'vulnerabilities' ? `/assets/${assetId}/scanner-findings` : null,
    );
    const scannerRows = scannerQuery.data?.rows ?? [];
    const scannerLoading = scannerQuery.isLoading;
    // Per-row conversion state (id → 'risk' | 'finding' pending marker).
    const [convertingId, setConvertingId] = useState<string | null>(null);
    const convertVuln = async (id: string, kind: 'risk' | 'finding') => {
        setConvertingId(id);
        setError('');
        try {
            const endpoint = kind === 'risk' ? 'convert-to-risk' : 'convert-to-finding';
            const res = await fetch(apiUrl(`/vulnerabilities/${id}/${endpoint}`), { method: 'POST' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || t('detail.vuln.convertFailed'));
            }
            // Refresh both feeds so the converted row reflects its new state
            // (a converted vuln/finding no longer shows the convert affordance).
            vulnQuery.mutate();
            scannerQuery.mutate();
            toast.success(
                kind === 'risk'
                    ? t('detail.vuln.convertedRisk')
                    : t('detail.vuln.convertedFinding'),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : t('detail.vuln.convertFailed'));
        } finally {
            setConvertingId(null);
        }
    };

    // ─── Inline triage (subpoint 5): optimistic overrides + OPEN-scoped feeds ───
    // The two feeds default to OPEN — matching the "open vulnerabilities" framing
    // of the list column — with a toggle to reveal resolved rows. Edits reuse the
    // same PATCH endpoints the global Vulnerabilities / Security-testing pages use.
    const [showResolved, setShowResolved] = useState(false);
    const [vulnOverrides, setVulnOverrides] = useState<Record<string, Partial<AssetVulnRow>>>({});
    const [scannerOverrides, setScannerOverrides] = useState<Record<string, Partial<AssetScannerFindingRow>>>({});

    const patchVulnRow = async (id: string, body: Record<string, unknown>, optimistic: Partial<AssetVulnRow>) => {
        setVulnOverrides((p) => ({ ...p, [id]: { ...p[id], ...optimistic } }));
        try {
            const res = await fetch(apiUrl(`/vulnerabilities/${id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            vulnQuery.mutate();
        } catch {
            setVulnOverrides((p) => { const n = { ...p }; delete n[id]; return n; });
            setError(t('detail.vuln.updateFailed'));
            router.refresh();
        }
    };
    const patchScannerRow = async (id: string, status: string) => {
        setScannerOverrides((p) => ({ ...p, [id]: { ...p[id], status } }));
        try {
            const res = await fetch(apiUrl(`/security-testing/findings/${id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            scannerQuery.mutate();
        } catch {
            setScannerOverrides((p) => { const n = { ...p }; delete n[id]; return n; });
            setError(t('detail.vuln.updateFailed'));
            router.refresh();
        }
    };

    const visibleVulnRows = useMemo(() => {
        const merged = vulnRows.map((r) => ({ ...r, ...vulnOverrides[r.id] }));
        return showResolved ? merged : merged.filter((r) => r.status === 'OPEN');
    }, [vulnRows, vulnOverrides, showResolved]);
    const visibleScannerRows = useMemo(() => {
        const merged = scannerRows.map((r) => ({ ...r, ...scannerOverrides[r.id] }));
        return showResolved ? merged : merged.filter((r) => r.status === 'OPEN');
    }, [scannerRows, scannerOverrides, showResolved]);

    const vulnStatusOptions = useMemo<ComboboxOption[]>(
        () => VULN_STATUS_VALUES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
        [],
    );
    const scannerStatusOptions = useMemo<ComboboxOption[]>(
        () => SCANNER_STATUS_VALUES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
        [],
    );

    // Modal-form P2 — the inline-edit panel is replaced by an
    // EditAssetModal launched from the detail header. The page URL
    // stays canonical; modal state is purely overlay. Seeding values
    // are computed from the currently-loaded `asset` row at modal
    // open time.
    const [editing, setEditing] = useState(false);
    // Bumped on every open so <EditAssetModal> remounts and RE-SEEDS from the
    // current asset row — a reopened form never shows stale values (abandoned
    // edits from a prior cancel, or another asset's values). Bumped only on
    // open, so the close animation is preserved (no remount on close).
    const [editSeed, setEditSeed] = useState(0);
    const openEdit = () => {
        setEditSeed((n) => n + 1);
        setEditing(true);
    };

    // Single-asset soft-delete (reversible via the deleted-assets view →
    // Restore). The irreversible purge is gated behind a typed-confirmation
    // modal on the deleted-assets list.
    const router = useRouter();
    // Asset delete is a soft/restorable delete → Epic 67 undo-toast, not a
    // blocking confirm. Optimistically navigate back to the list, fire the
    // DELETE after the undo window, and return to the (un-deleted) asset on
    // Undo / failure. See docs/destructive-actions.md.
    const handleDelete = () => {
        router.push(tenantHref('/assets'));
        triggerUndoToast({
            message: t('detail.deletedToast'),
            undoMessage: t('detail.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/assets/${assetId}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            },
            undoAction: () => { router.push(tenantHref(`/assets/${assetId}`)); },
            onError: () => {
                toast.error(t('detail.deleteFailed'));
                router.push(tenantHref(`/assets/${assetId}`));
            },
        });
    };
    const editInitial = asset
        ? {
              name: asset.name || '',
              type: asset.type || 'SYSTEM',
              classification: asset.classification || '',
              ownerUserId: asset.ownerUserId || '',
              location: asset.location || '',
              status: asset.status || 'ACTIVE',
              dataResidency: asset.dataResidency || '',
              externalRef: asset.externalRef || '',
              dependencies: asset.dependencies || '',
              businessProcesses: asset.businessProcesses || '',
              retention: asset.retention || '',
              retentionUntil: asset.retentionUntil ? asset.retentionUntil.split('T')[0] : '',
              confidentiality: asset.confidentiality ?? 3,
              integrity: asset.integrity ?? 3,
              availability: asset.availability ?? 3,
              cpe: asset.cpe || '',
              vendor: asset.vendor || '',
              product: asset.product || '',
              version: asset.version || '',
          }
        : {};

    // Item — surface a "add product identity" hint when the asset lacks
    // ALL machine-readable identity fields (no cpe AND no vendor AND no
    // product). Without any of these the CVE feed can never match the
    // asset, so nudge the user to add them.
    const missingIdentity =
        !!asset && !asset.cpe && !asset.vendor && !asset.product;

    // B5 — ordered asset-id list for the prev/next nav beside the name.
    // The default list order so the up/down buttons walk the same sequence
    // the list page shows. Best-effort: failures just hide the affordance.
    const assetListQuery = useTenantSWR<Array<{ id?: string }>>('/assets');
    const assetIds = useMemo(
        () =>
            Array.isArray(assetListQuery.data)
                ? assetListQuery.data
                      .map((r) => r?.id)
                      .filter((id): id is string => Boolean(id))
                : [],
        [assetListQuery.data],
    );

    // Item 29 — brand-color status action on the asset detail header.
    // AssetStatus is a two-state lifecycle (ACTIVE / RETIRED).
    const ASSET_STATUS_OPTIONS: ComboboxOption[] = [
        { value: 'ACTIVE', label: t('detail.statusActive') },
        { value: 'RETIRED', label: t('detail.statusRetired') },
    ];
    const [changingStatus, setChangingStatus] = useState(false);
    const changeStatus = async (status: string) => {
        setChangingStatus(true);
        setError('');
        try {
            const res = await fetch(apiUrl(`/assets/${assetId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || t('detail.changeStatusFailed', { status: res.status }));
            }
            await assetQuery.mutate();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('detail.changeStatusFailedGeneric'));
        } finally {
            setChangingStatus(false);
        }
    };

    // CRITICAL + HIGH both render as the error (red) badge — the StatusBadge
    // palette has no distinct orange between amber (warning) and red (error);
    // MEDIUM stays amber, LOW green.
    // Shared with the list badge — see criticalityBadgeVariant.
    const critColor = criticalityBadgeVariant;

    const breadcrumbs = [
        { label: t('detail.crumbDashboard'), href: tenantHref('/dashboard') },
        { label: t('detail.crumbAssets'), href: tenantHref('/assets') },
        { label: asset?.name ?? t('detail.crumbFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (loadError && !asset) {
        return (
            <EntityDetailLayout error={loadError} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!asset) {
        return (
            <EntityDetailLayout empty={{ message: t('detail.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    return (
        <EntityDetailLayout
            id="asset-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(k) => setActiveTab(k)}
            actions={
                <>
                    {/* PR-D — Where used in process maps. Visible to all
                        viewers (readers + auditors need it most). */}
                    <Button
                        variant="secondary"
                        onClick={() => setProcessWhereUsedOpen(true)}
                        id="asset-where-used-btn"
                        data-testid="asset-where-used-btn"
                    >
                        {tWhereUsed('button')}
                    </Button>
                    {permissions.canWrite && (
                        <Combobox
                            hideSearch
                            id="asset-status-select"
                            selected={ASSET_STATUS_OPTIONS.find(o => o.value === (asset.status || 'ACTIVE')) ?? null}
                            setSelected={(opt) => { if (opt) changeStatus(opt.value); }}
                            options={ASSET_STATUS_OPTIONS}
                            disabled={changingStatus}
                            placeholder={t('detail.statusPlaceholder')}
                            // Item 29 — brand-color the status action (matches the
                            // primary "+ …" create buttons), consistent with risk /
                            // task / control detail headers.
                            buttonProps={{ variant: 'primary', className: 'text-sm' }}
                        />
                    )}
                    {permissions.canAdmin && (
                        <Tooltip content={t('detail.deleteAsset')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={handleDelete}
                                id="asset-delete-btn"
                                aria-label={t('detail.deleteAsset')}
                            >
                                <Trash className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </>
            }

            title={
                <span className="inline-flex items-center gap-2.5">
                    <span id="asset-title-heading">{asset.name}</span>
                    {/* B5 — step to the prev/next asset in list order. */}
                    <EntityPrevNextNav
                        ids={assetIds}
                        currentId={assetId}
                        hrefFor={(id) => tenantHref(`/assets/${id}`)}
                        labelSingular="asset"
                    />
                </span>
            }
            meta={
                <MetaStrip
                    items={[
                        {
                            label: t('detail.type'),
                            value: asset.type?.replace(/_/g, ' '),
                        },
                        ...(asset.criticality
                            ? [
                                  {
                                      kind: 'status' as const,
                                      label: t('colHeaders.criticality'),
                                      value: asset.criticality,
                                      variant: critColor(asset.criticality),
                                  },
                              ]
                            : []),
                        {
                            kind: 'status' as const,
                            label: t('detail.status'),
                            value: asset.status || 'ACTIVE',
                            variant:
                                asset.status === 'RETIRED'
                                    ? 'neutral'
                                    : 'success',
                        },
                    ]}
                />
            }
        >
            {error && <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-content-error text-sm')}>{error}</div>}

            {/* Edit modal — modal-form P2. Always mounted so the
                modal's own open/close state survives tab switches. */}
            {permissions.canWrite && (
                <EditAssetModal
                    key={`edit-${assetId}-${editSeed}`}
                    open={editing}
                    setOpen={setEditing}
                    assetId={assetId}
                    initial={editInitial}
                    onSaved={(updated) => assetQuery.mutate(updated, { revalidate: false })}
                />
            )}

            {activeTab === 'tasks' && (
                <div className={cardVariants()} id="asset-tasks-tab">
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="ASSET"
                        entityId={assetId}
                        tenantHref={tenantHref}
                        canWrite={permissions.canWrite}
                    />
                </div>
            )}
            {activeTab === 'vulnerabilities' && (
              <div className="space-y-section">
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="asset-vulnerabilities-tab">
                    {/* Inbound link to the global Vulnerabilities view, scoped to
                        this asset — the same deep-link the assets-list badge uses.
                        The Open/Resolved toggle governs BOTH feeds (CVE + scanner). */}
                    <div className="flex items-center justify-between gap-compact border-b border-border-subtle p-3">
                        <Button
                            variant="secondary"
                            size="sm"
                            id="asset-vulns-show-resolved"
                            aria-pressed={showResolved}
                            onClick={() => setShowResolved((v) => !v)}
                            text={showResolved ? t('detail.vuln.showingResolved') : t('detail.vuln.showResolved')}
                        />
                        <Link
                            href={tenantHref(`/vulnerabilities?assetId=${assetId}`)}
                            id="asset-see-all-vulns"
                            className="text-sm text-content-muted hover:text-content-default hover:underline"
                        >
                            {t('detail.vuln.seeAll')} →
                        </Link>
                    </div>
                    <DataTable<AssetVulnRow>
                        data={visibleVulnRows}
                        loading={vulnLoading}
                        getRowId={(v) => v.id}
                        resourceName={(plural) => (plural ? t('detail.tabs.vulnerabilities') : t('detail.tabs.vulnerabilities'))}
                        emptyState={
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t('detail.vuln.emptyTitle')}
                                description={t('detail.vuln.emptyDesc')}
                            />
                        }
                        columns={[
                            {
                                id: 'cve',
                                header: 'CVE',
                                cell: ({ row }) => <span className="font-medium text-content-default">{row.original.cve?.id ?? '—'}</span>,
                            },
                            {
                                id: 'severity',
                                header: t('detail.vuln.severity'),
                                cell: ({ row }) => (
                                    <StatusBadge variant={severityVariant(row.original.cve?.cvssSeverity)} size="sm">
                                        {row.original.cve?.cvssSeverity ?? t('detail.vuln.none')}
                                    </StatusBadge>
                                ),
                            },
                            {
                                id: 'score',
                                header: t('detail.vuln.score'),
                                cell: ({ row }) => <span className="text-sm tabular-nums">{row.original.cve?.cvssScore ?? t('detail.vuln.none')}</span>,
                            },
                            {
                                id: 'status',
                                header: t('detail.vuln.status'),
                                cell: ({ row }) => {
                                    const r = row.original;
                                    if (!permissions.canWrite) {
                                        return (
                                            <StatusBadge variant={vulnStatusVariant(r.status)} size="sm">
                                                {r.status}
                                            </StatusBadge>
                                        );
                                    }
                                    return (
                                        <Combobox
                                            options={vulnStatusOptions}
                                            selected={vulnStatusOptions.find((o) => o.value === r.status) ?? null}
                                            setSelected={(opt) => opt && patchVulnRow(r.id, { status: opt.value }, { status: opt.value })}
                                            hideSearch
                                            matchTriggerWidth
                                            buttonProps={{ size: 'sm', 'aria-label': t('detail.vuln.status') }}
                                        />
                                    );
                                },
                            },
                            {
                                id: 'matchedVia',
                                header: t('detail.vuln.matchedVia'),
                                cell: ({ row }) => <span className="text-sm text-content-muted">{row.original.matchedVia}</span>,
                            },
                            {
                                id: 'owner',
                                header: t('detail.vuln.owner'),
                                cell: ({ row }) => {
                                    const r = row.original;
                                    if (!permissions.canWrite) {
                                        return (
                                            <span className="text-sm text-content-muted">
                                                {r.ownerUser?.name || r.ownerUser?.email || t('detail.vuln.unassigned')}
                                            </span>
                                        );
                                    }
                                    return (
                                        <UserCombobox
                                            tenantSlug={tenantSlug}
                                            size="sm"
                                            matchTriggerWidth
                                            selectedId={r.ownerUserId}
                                            onChange={(userId, member: Member | null) =>
                                                patchVulnRow(
                                                    r.id,
                                                    { ownerUserId: userId },
                                                    {
                                                        ownerUserId: userId,
                                                        ownerUser: userId && member ? { id: member.id, name: member.name, email: member.email } : null,
                                                    },
                                                )
                                            }
                                            placeholder={t('detail.vuln.assignOwner')}
                                        />
                                    );
                                },
                            },
                            {
                                id: 'due',
                                header: t('detail.vuln.due'),
                                cell: ({ row }) => {
                                    const r = row.original;
                                    if (!permissions.canWrite) {
                                        return (
                                            <span className="text-sm text-content-muted">
                                                {r.remediationDueAt ? formatDate(r.remediationDueAt) : t('detail.vuln.none')}
                                            </span>
                                        );
                                    }
                                    return (
                                        <DatePicker
                                            clearable
                                            align="start"
                                            placeholder={t('detail.vuln.setDue')}
                                            value={r.remediationDueAt ? new Date(r.remediationDueAt) : null}
                                            onChange={(next) => {
                                                const ymd = toYMD(next);
                                                patchVulnRow(r.id, { remediationDueAt: ymd }, { remediationDueAt: ymd ?? null });
                                            }}
                                            aria-label={t('detail.vuln.due')}
                                        />
                                    );
                                },
                            },
                            {
                                id: 'note',
                                header: t('detail.vuln.note'),
                                cell: ({ row }) => (
                                    <VulnNoteCell
                                        row={row.original}
                                        canWrite={permissions.canWrite}
                                        onSave={(id, note) => patchVulnRow(id, { note }, { note })}
                                        emptyLabel={t('detail.vuln.addNote')}
                                        editLabel={t('detail.vuln.editNote')}
                                        placeholder={t('detail.vuln.notePlaceholder')}
                                    />
                                ),
                            },
                            ...(permissions.canWrite
                                ? [{
                                      id: 'actions',
                                      header: t('detail.vuln.actions'),
                                      cell: ({ row }: { row: { original: AssetVulnRow } }) => (
                                          <div className="flex items-center gap-compact">
                                              <Button
                                                  variant="secondary"
                                                  size="sm"
                                                  disabled={convertingId === row.original.id}
                                                  onClick={() => convertVuln(row.original.id, 'risk')}
                                              >
                                                  {t('detail.vuln.convertToRisk')}
                                              </Button>
                                              <Button
                                                  variant="secondary"
                                                  size="sm"
                                                  disabled={convertingId === row.original.id}
                                                  onClick={() => convertVuln(row.original.id, 'finding')}
                                              >
                                                  {t('detail.vuln.convertToFinding')}
                                              </Button>
                                          </div>
                                      ),
                                  }]
                                : []),
                        ] as ColumnDef<AssetVulnRow, unknown>[]}
                    />
                </div>
                {/* Scanner findings resolved to this asset (SAST / SCA / secrets
                    / IaC) — shown alongside the CVE-matched vulnerabilities so
                    the asset carries its full vulnerability picture. */}
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')} id="asset-scanner-findings">
                    <div className="flex items-center justify-between border-b border-border-subtle p-3">
                        <Heading level={3}>{t('detail.vuln.scannerTitle')}</Heading>
                        <Link
                            href={tenantHref('/security-testing')}
                            className="text-sm text-content-muted hover:text-content-default hover:underline"
                        >
                            {t('detail.vuln.scannerSeeAll')} →
                        </Link>
                    </div>
                    <DataTable<AssetScannerFindingRow>
                        data={visibleScannerRows}
                        loading={scannerLoading}
                        getRowId={(r) => r.id}
                        resourceName={() => t('detail.vuln.scannerTitle')}
                        emptyState={
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t('detail.vuln.scannerEmptyTitle')}
                                description={t('detail.vuln.scannerEmptyDesc')}
                            />
                        }
                        columns={[
                            { id: 'severity', header: t('detail.vuln.scannerSeverity'), accessorFn: (r: AssetScannerFindingRow) => r.severity, cell: ({ row }: { row: { original: AssetScannerFindingRow } }) => <StatusBadge variant={severityVariant(row.original.severity)} size="sm">{row.original.severity}</StatusBadge> },
                            { id: 'title', header: t('detail.vuln.scannerFinding'), accessorFn: (r: AssetScannerFindingRow) => r.title, cell: ({ row }: { row: { original: AssetScannerFindingRow } }) => <span className="text-sm">{row.original.title}</span> },
                            { id: 'rule', header: t('detail.vuln.scannerRule'), accessorFn: (r: AssetScannerFindingRow) => r.ruleId, cell: ({ row }: { row: { original: AssetScannerFindingRow } }) => <span className="text-xs text-content-muted">{row.original.ruleId}</span> },
                            { id: 'location', header: t('detail.vuln.scannerLocation'), accessorFn: (r: AssetScannerFindingRow) => r.location ?? '—', cell: ({ row }: { row: { original: AssetScannerFindingRow } }) => <span className="text-xs text-content-muted">{row.original.location ?? '—'}</span> },
                            { id: 'source', header: t('detail.vuln.scannerSource'), accessorFn: (r: AssetScannerFindingRow) => r.scannerRun?.source ?? '—', cell: ({ row }: { row: { original: AssetScannerFindingRow } }) => <span className="text-xs text-content-muted">{row.original.scannerRun?.source ?? '—'}</span> },
                            { id: 'status', header: t('detail.vuln.scannerStatus'), accessorFn: (r: AssetScannerFindingRow) => r.status, cell: ({ row }: { row: { original: AssetScannerFindingRow } }) => {
                                const r = row.original;
                                if (!permissions.canWrite) {
                                    return <StatusBadge variant={scannerStatusVariant(r.status)} size="sm">{r.status.replace(/_/g, ' ')}</StatusBadge>;
                                }
                                return (
                                    <Combobox
                                        options={scannerStatusOptions}
                                        selected={scannerStatusOptions.find((o) => o.value === r.status) ?? null}
                                        setSelected={(opt) => opt && patchScannerRow(r.id, opt.value)}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ size: 'sm', 'aria-label': t('detail.vuln.scannerStatus') }}
                                    />
                                );
                            } },
                        ] as ColumnDef<AssetScannerFindingRow, unknown>[]}
                    />
                </div>
              </div>
            )}
            {activeTab === 'traceability' && (
                <div className="space-y-default">
                    <div className="space-y-tight">
                        <Heading level={3}>{t('detail.traceabilityHeading')}</Heading>
                        <p className="text-sm text-content-muted">{t('detail.traceabilitySubtitle')}</p>
                    </div>
                    <TraceabilityPanel
                        apiBase={apiUrl('')}
                        entityType="asset"
                        entityId={assetId}
                        canWrite={permissions.canWrite}
                        tenantHref={tenantHref}
                    />
                    <div className="border-t border-border-subtle pt-default">
                        <LinkedVendorsPanel entityType="ASSET" entityId={assetId} />
                    </div>
                </div>
            )}
            {activeTab === 'evidence' && (
                <div className="space-y-section">
                    <div className="space-y-default">
                        <Heading level={3}>{t('detail.attachedEvidence')}</Heading>
                        <AttachedEvidencePanel
                            tenantSlug={tenantSlug}
                            entityId={assetId}
                            entity="asset"
                            endpoint={`/assets/${assetId}/evidence/attached`}
                            apiUrl={apiUrl}
                            tenantHref={tenantHref}
                            canWrite={permissions.canWrite}
                        />
                    </div>
                    <div className="space-y-default">
                        <Heading level={3}>{t('detail.inheritedFromControls')}</Heading>
                        <InheritedEvidencePanel
                            endpoint={apiUrl(`/assets/${assetId}/evidence`)}
                            tenantHref={tenantHref}
                            entityLabel="asset"
                        />
                    </div>
                </div>
            )}
            {activeTab === 'mappings' && (
                <InheritedMappingsPanel
                    endpoint={apiUrl(`/assets/${assetId}/mappings`)}
                    tenantHref={tenantHref}
                    entityLabel="asset"
                />
            )}
            {activeTab === 'activity' && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    {activityLoading ? (
                        <div className="p-8 text-center text-content-subtle animate-pulse">{t('detail.activityFeed.loading')}</div>
                    ) : activity.length === 0 ? (
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('detail.activityFeed.emptyTitle')}
                            description={t('detail.activityFeed.emptyDesc')}
                        />
                    ) : (
                        <div className="divide-y divide-border-default/50" id="asset-activity-feed">
                            {activity.map((ev) => (
                                <div key={ev.id} className="px-5 py-3 flex items-start gap-compact">
                                    <div className="mt-0.5">
                                        <StatusBadge variant="info">{EVENT_LABELS[ev.action] || ev.action}</StatusBadge>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-content-default">{ev.details}</p>
                                        <p className="text-xs text-content-subtle mt-0.5">
                                            {ev.user?.name || t('detail.activityFeed.systemActor')} · {formatDateTime(ev.createdAt)}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {activeTab === 'tests' && (
                <InheritedTestPlansPanel
                    endpoint={apiUrl(`/assets/${assetId}/test-plans`)}
                    tenantHref={tenantHref}
                    entityLabel="asset"
                />
            )}

            {activeTab === 'overview' && (
                <>

            {/* 360° relationship roll-ups — four clickable stats that jump to
                the relevant tab. Counts come from the getAsset usecase. */}
            {asset.rollups && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default" id="asset-rollups">
                    <button
                        type="button"
                        onClick={() => setActiveTab('traceability')}
                        className={cn(cardVariants({ density: 'compact' }), 'text-left hover:border-border-emphasis transition-colors')}
                    >
                        <KPIStat label={t('detail.rollups.risks')} value={asset.rollups.risks.count} />
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('traceability')}
                        className={cn(cardVariants({ density: 'compact' }), 'text-left hover:border-border-emphasis transition-colors')}
                    >
                        <KPIStat label={t('detail.rollups.controls')} value={asset.rollups.controls.count} />
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('vulnerabilities')}
                        className={cn(cardVariants({ density: 'compact' }), 'text-left hover:border-border-emphasis transition-colors')}
                    >
                        <KPIStat
                            label={t('detail.rollups.vulnerabilities')}
                            value={asset.rollups.vulnerabilities.openCount}
                            tone={asset.rollups.vulnerabilities.openCount > 0 ? 'attention' : 'default'}
                            description={asset.rollups.vulnerabilities.maxSeverity ? (
                                <StatusBadge variant={severityVariant(asset.rollups.vulnerabilities.maxSeverity)} size="sm">
                                    {asset.rollups.vulnerabilities.maxSeverity}
                                </StatusBadge>
                            ) : undefined}
                        />
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('tasks')}
                        className={cn(cardVariants({ density: 'compact' }), 'text-left hover:border-border-emphasis transition-colors')}
                    >
                        <KPIStat label={t('detail.rollups.tasks')} value={asset.rollups.tasks.openCount} />
                    </button>
                </div>
            )}

            {/* "Add product identity" hint — CVE→asset matching needs at
                least one of cpe / vendor / product. Lightweight inline
                callout; opens the edit modal so the user can add them. */}
            {missingIdentity && (
                <div
                    className={cn(
                        cardVariants({ density: 'compact' }),
                        'flex flex-col gap-compact border-border-emphasis/50 sm:flex-row sm:items-center sm:justify-between',
                    )}
                    id="asset-identity-hint"
                >
                    <div className="space-y-tight">
                        <p className="text-sm font-medium text-content-default">{t('detail.identityHintTitle')}</p>
                        <p className="text-xs text-content-muted">{t('detail.identityHintBody')}</p>
                    </div>
                    {permissions.canWrite && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={openEdit}
                            id="asset-identity-hint-btn"
                        >
                            {t('detail.identityHintAction')}
                        </Button>
                    )}
                </div>
            )}

            {/* Detail card — read-only view; edits flow through EditAssetModal. */}
            <div className={cn(cardVariants(), 'space-y-default')} id="asset-detail">
                {permissions.canWrite && (
                    <div className="flex justify-end -mt-1 -mb-2">
                        {/* B2 — icon-only edit affordance; opens the Edit
                            Asset modal, mirroring the control overview. */}
                        <Tooltip content={t('detail.editAsset')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={openEdit}
                                id="edit-asset-btn"
                                aria-label={t('detail.editAsset')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    </div>
                )}
                <>
                        {asset.classification && <div><Eyebrow>{t('detail.classification')}</Eyebrow><p className="text-sm">{asset.classification}</p></div>}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                            <div>
                                <Eyebrow>{t('detail.owner')}</Eyebrow>
                                {ownerName ? (
                                    <p className="text-sm">{ownerName}</p>
                                ) : importedOwner ? (
                                    <p className="text-sm">
                                        {importedOwner}{' '}
                                        <span className="text-xs text-content-subtle">({t('list.ownerImported')})</span>
                                    </p>
                                ) : (
                                    <p className="text-sm">—</p>
                                )}
                            </div>
                            <div><Eyebrow>{t('detail.location')}</Eyebrow><p className="text-sm">{asset.location || '—'}</p></div>
                            <div>
                                <Eyebrow>{t('detail.externalRef')}</Eyebrow>
                                {asset.externalRef ? (
                                    <CopyText
                                        value={asset.externalRef}
                                        label={t('detail.copyExternalRef', { ref: asset.externalRef })}
                                        successMessage={t('detail.externalRefCopied')}
                                        className="text-sm text-content-default"
                                    >
                                        {asset.externalRef}
                                    </CopyText>
                                ) : (
                                    <p className="text-sm">—</p>
                                )}
                            </div>
                            <div><Eyebrow>{t('detail.dataResidency')}</Eyebrow><p className="text-sm">{asset.dataResidency || '—'}</p></div>
                            {/* Structured retention-expiry date (the machine date the
                                data-lifecycle sweep acts on) — distinct from the free-text
                                retention note below. */}
                            <div><Eyebrow>{t('detail.retentionUntil')}</Eyebrow><p className="text-sm">{asset.retentionUntil ? formatDate(asset.retentionUntil) : '—'}</p></div>
                        </div>
                        {/* Context NOTES — free-text, not structured linkage.
                            `businessProcesses` in particular must not be mistaken
                            for the authoritative "Where used in process maps"
                            reverse-lookup above; these are operator notes that can
                            drift from it. De-emphasised + captioned accordingly. */}
                        <div className="space-y-tight">
                            <p className="text-xs text-content-subtle">{t('detail.contextNotesCaption')}</p>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-default">
                                <div><Eyebrow>{t('detail.dependencies')}</Eyebrow><p className="text-sm whitespace-pre-wrap text-content-muted">{asset.dependencies || '—'}</p></div>
                                <div><Eyebrow>{t('detail.businessProcesses')}</Eyebrow><p className="text-sm whitespace-pre-wrap text-content-muted">{asset.businessProcesses || '—'}</p></div>
                                <div><Eyebrow>{t('detail.retention')}</Eyebrow><p className="text-sm whitespace-pre-wrap text-content-muted">{asset.retention || '—'}</p></div>
                            </div>
                        </div>
                        {/* Product identity — the CVE→asset matching keys. */}
                        <div className="flex items-center gap-1.5 border-t border-border-default/50 pt-4">
                            <Heading level={3}>{t('detail.identityHeading')}</Heading>
                            <InfoTooltip content={t('form.identityTooltip')} aria-label={t('detail.identityHeading')} />
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                            <div className="col-span-2 md:col-span-4"><Eyebrow>{t('detail.cpe')}</Eyebrow><p className="text-sm break-all">{asset.cpe || '—'}</p></div>
                            <div><Eyebrow>{t('detail.vendor')}</Eyebrow><p className="text-sm">{asset.vendor || '—'}</p></div>
                            <div><Eyebrow>{t('detail.product')}</Eyebrow><p className="text-sm">{asset.product || '—'}</p></div>
                            <div><Eyebrow>{t('detail.version')}</Eyebrow><p className="text-sm">{asset.version || '—'}</p></div>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <Heading level={3}>{t('detail.criticalityHeading')}</Heading>
                            <InfoTooltip content={t('detail.ciaLegendBody')} aria-label={t('detail.criticalityHeading')} />
                        </div>
                        <AssetCriticalityBadge
                            confidentiality={asset.confidentiality ?? 3}
                            integrity={asset.integrity ?? 3}
                            availability={asset.availability ?? 3}
                            storedCriticality={asset.criticality}
                        />
                        <div className="grid grid-cols-2 gap-default border-t border-border-default/50 pt-4">
                            <div><Eyebrow>{t('detail.created')}</Eyebrow><p className="text-sm text-content-muted">{formatDate(asset.createdAt)}</p></div>
                            <div><Eyebrow>{t('detail.updated')}</Eyebrow><p className="text-sm text-content-muted">{formatDate(asset.updatedAt)}</p></div>
                        </div>
                    </>
            </div>

                </>
            )}

            {/* PR-D — Where used (process maps) reverse-lookup modal */}
            <ProcessNodeReverseLookupModal
                entityType="asset"
                entityId={assetId}
                tenantSlug={tenantSlug}
                open={processWhereUsedOpen}
                onOpenChange={setProcessWhereUsedOpen}
            />
        </EntityDetailLayout>
    );
}

/**
 * Inline-editable analyst-note cell for a CVE vulnerability row. Read users see
 * the truncated note (or an em dash); write users click-to-edit, committing via
 * the optimistic `onSave` on blur / Enter and cancelling on Escape. Mirrors the
 * global Vulnerabilities page NoteCell so the two triage surfaces feel identical.
 */
function VulnNoteCell({
    row,
    canWrite,
    onSave,
    emptyLabel,
    editLabel,
    placeholder,
}: {
    row: AssetVulnRow;
    canWrite: boolean;
    onSave: (id: string, note: string | null) => void;
    emptyLabel: string;
    editLabel: string;
    placeholder: string;
}) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(row.note ?? '');
    const commit = () => {
        setEditing(false);
        const next = value.trim().length ? value.trim() : null;
        if ((row.note ?? null) !== next) onSave(row.id, next);
    };
    const { handleKeyDown } = useEnterSubmit({ modifier: 'always', onSubmit: () => commit() });

    if (!canWrite) {
        return row.note ? (
            <span className="block max-w-xs truncate text-content-default">{row.note}</span>
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
