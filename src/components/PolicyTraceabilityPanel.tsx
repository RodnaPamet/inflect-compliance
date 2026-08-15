'use client';

/**
 * Traceability for the Policy detail page.
 *
 * A policy links DIRECTLY to controls (`PolicyControlLink`); the risks
 * those controls mitigate and the assets they protect are INHERITED
 * through the controls. So this panel surfaces three sections —
 * linked Controls, then the Risks and Assets reachable via them (each
 * tagged "via N controls"). In `editable` mode the Controls section
 * carries a link picker + per-row unlink (undo-toast) that drive the
 * policy↔control link flow; the derived Risks and Assets sections stay
 * read-only (coverage is purely inherited). The shape mirrors the
 * Asset/Risk inherited data panels for visual consistency.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useToastWithUndo } from '@/components/ui/hooks';
import { CONTROL_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';

interface ControlOption { id: string; code: string | null; name: string; status: string | null; }

interface ControlRef {
    id: string;
    code: string | null;
    name: string;
    status: string | null;
    category: string | null;
}
interface RiskRef {
    id: string;
    title: string;
    status: string | null;
    score: number | null;
    category: string | null;
}
interface AssetRef {
    id: string;
    name: string;
    type: string | null;
    criticality: string | null;
    status: string | null;
}
interface ControlEntry {
    id: string;
    control: ControlRef;
}
interface RiskEntry {
    id: string;
    risk: RiskRef;
    viaControls: number;
}
interface AssetEntry {
    id: string;
    asset: AssetRef;
    viaControls: number;
}
interface PolicyTraceData {
    policyId: string;
    controls: ControlEntry[];
    risks: RiskEntry[];
    assets: AssetEntry[];
}

// Was a seventh private copy, and the one that DIVERGED: it rendered PLANNED
// as `info` while the SoA, the controls list and the health card rendered it
// `neutral`. Same control, two colours, depending on which page you opened.
const CONTROL_STATUS_BADGE = CONTROL_STATUS_VARIANT;
const RISK_STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    OPEN: 'error',
    MITIGATING: 'warning',
    MITIGATED: 'success',
    ACCEPTED: 'info',
    CLOSED: 'success',
};
const CRITICALITY_BADGE: Record<string, StatusBadgeVariant> = {
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'neutral',
};

export default function PolicyTraceabilityPanel({
    endpoint,
    tenantHref,
    policyId,
    apiUrl,
    canWrite = false,
}: {
    /** Fully-qualified tenant API path, e.g. apiUrl('/policies/123/traceability'). */
    endpoint: string;
    tenantHref: (path: string) => string;
    /** Enables the link/unlink affordances when provided with canWrite. */
    policyId?: string;
    apiUrl?: (path: string) => string;
    canWrite?: boolean;
}) {
    const [data, setData] = useState<PolicyTraceData | null>(null);
    const [loading, setLoading] = useState(true);
    const [availableControls, setAvailableControls] = useState<ControlOption[]>([]);
    const [linking, setLinking] = useState(false);
    const t = useTranslations('panels');
    const tr = useTranslations();
    const triggerUndoToast = useToastWithUndo();
    // Link/unlink is available only when the page passes policyId + apiUrl + canWrite.
    const editable = canWrite && !!policyId && !!apiUrl;
    const controlLinksUrl = apiUrl && policyId ? apiUrl(`/policies/${policyId}/control-links`) : '';

    const CONTROL_STATUS_LABELS = useMemo<Record<string, string>>(() => ({
        NOT_STARTED: tr('controls.statusLabels.NOT_STARTED'), IN_PROGRESS: tr('controls.statusLabels.IN_PROGRESS'),
        IMPLEMENTED: tr('controls.statusLabels.IMPLEMENTED'), NEEDS_REVIEW: tr('controls.statusLabels.NEEDS_REVIEW'),
        IMPLEMENTING: tr('controls.implementing'), PLANNED: tr('controls.planned'),
        NOT_APPLICABLE: tr('controls.notApplicable'),
    }), [tr]);
    const RISK_STATUS_LABELS = useMemo<Record<string, string>>(() => ({
        OPEN: tr('risks.bulkStatus.open'), MITIGATING: tr('risks.bulkStatus.mitigating'),
        MITIGATED: tr('risks.bulkStatus.mitigated'), ACCEPTED: tr('risks.bulkStatus.accepted'),
        CLOSED: tr('risks.bulkStatus.closed'),
    }), [tr]);
    const ASSET_TYPE_LABELS = useMemo<Record<string, string>>(() => ({
        INFORMATION: tr('assets.filterEnums.type.INFORMATION'), SYSTEM: tr('assets.filterEnums.type.SYSTEM'),
        SERVICE: tr('assets.filterEnums.type.SERVICE'), DATA_STORE: tr('assets.filterEnums.type.DATA_STORE'),
        VENDOR: tr('assets.filterEnums.type.VENDOR'), PEOPLE_PROCESS: tr('assets.filterEnums.type.PEOPLE_PROCESS'),
        APPLICATION: tr('assets.filterEnums.type.APPLICATION'), INFRASTRUCTURE: tr('assets.filterEnums.type.INFRASTRUCTURE'),
        PROCESS: tr('assets.filterEnums.type.PROCESS'), OTHER: tr('assets.filterEnums.type.OTHER'),
    }), [tr]);
    const CRIT_LABELS = useMemo<Record<string, string>>(() => ({
        LOW: t('criticalityLabels.LOW'), MEDIUM: t('criticalityLabels.MEDIUM'),
        HIGH: t('criticalityLabels.HIGH'), CRITICAL: t('criticalityLabels.CRITICAL'),
    }), [t]);

    const load = useCallback(async () => {
        try {
            const res = await fetch(endpoint);
            setData(res.ok ? await res.json() : null);
        } catch {
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [endpoint]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        setLoading(true);
        void load();
    }, [load]);

    // Available controls for the link picker (only when editable).
    useEffect(() => {
        if (!editable || !apiUrl) return;
        fetch(apiUrl('/controls?limit=100'))
            .then((r) => (r.ok ? r.json() : []))
            .then((d) => {
                const list = Array.isArray(d) ? d : (d?.controls ?? d?.items ?? []);
                setAvailableControls(list as ControlOption[]);
            })
            .catch(() => setAvailableControls([]));
    }, [editable, apiUrl]);

    const linkedControlIds = useMemo(() => new Set((data?.controls ?? []).map((c) => c.control.id)), [data]);
    const linkOptions = availableControls
        .filter((c) => !linkedControlIds.has(c.id))
        .map((c) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name }));

    const handleLink = async (controlId: string) => {
        if (!controlLinksUrl || linking) return;
        setLinking(true);
        try {
            const res = await fetch(controlLinksUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ controlIds: [controlId] }),
            });
            if (res.ok) await load();
        } finally {
            setLinking(false);
        }
    };

    // Unlink — Epic 67 delayed-commit undo-toast. Optimistic removal; the DELETE
    // is deferred 5s, and Undo (or a failure) restores the snapshot.
    const handleUnlink = (controlId: string) => {
        if (!controlLinksUrl) return;
        const previous = data;
        if (previous) setData({ ...previous, controls: previous.controls.filter((c) => c.control.id !== controlId) });
        triggerUndoToast({
            message: t('policyTrace.controlUnlinked'),
            undoMessage: t('policyTrace.undo'),
            action: async () => {
                const res = await fetch(controlLinksUrl, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ controlIds: [controlId] }),
                });
                if (!res.ok) throw new Error('Unlink failed');
                await load();
            },
            undoAction: () => { if (previous) setData(previous); },
            onError: () => { if (previous) setData(previous); },
        });
    };

    const viaLabelT = (n: number) => n === 1 ? t('policyTrace.viaOne', { count: n }) : t('policyTrace.viaMany', { count: n });

    const controlColumns = createColumns<ControlEntry>([
        {
            id: 'control',
            header: t('col.control'),
            cell: ({ row }) => (
                <TableTitleCell href={tenantHref(`/controls/${row.original.control.id}`)}>
                    {row.original.control.code || row.original.control.name}
                </TableTitleCell>
            ),
        },
        {
            id: 'name',
            header: t('col.name'),
            cell: ({ row }) => (
                <span className="text-sm text-content-default">{row.original.control.name}</span>
            ),
        },
        {
            id: 'category',
            header: t('col.category'),
            cell: ({ row }) =>
                row.original.control.category ? (
                    <span className="text-sm text-content-muted">{row.original.control.category}</span>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'status',
            header: t('col.status'),
            cell: ({ row }) => {
                const s = row.original.control.status;
                return s ? (
                    <StatusBadge variant={CONTROL_STATUS_BADGE[s] ?? 'neutral'} size="sm">
                        {CONTROL_STATUS_LABELS[s] ?? s.replace(/_/g, ' ')}
                    </StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                );
            },
        },
        ...(editable
            ? [{
                  id: 'unlink',
                  header: '',
                  cell: ({ row }: { row: { original: ControlEntry } }) => (
                      <div className="text-right">
                          <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleUnlink(row.original.control.id)}
                              aria-label={t('policyTrace.unlinkControl')}
                          >
                              {t('policyTrace.unlink')}
                          </Button>
                      </div>
                  ),
              }]
            : []),
    ]);

    const riskColumns = createColumns<RiskEntry>([
        {
            id: 'risk',
            header: t('col.risk'),
            cell: ({ row }) => (
                <TableTitleCell href={tenantHref(`/risks/${row.original.risk.id}`)}>
                    {row.original.risk.title}
                </TableTitleCell>
            ),
        },
        {
            id: 'category',
            header: t('col.category'),
            cell: ({ row }) =>
                row.original.risk.category ? (
                    <span className="text-sm text-content-muted">{row.original.risk.category}</span>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'score',
            header: t('col.score'),
            cell: ({ row }) => (
                <span className="text-sm tabular-nums text-content-default">
                    {row.original.risk.score ?? '—'}
                </span>
            ),
        },
        {
            id: 'status',
            header: t('col.status'),
            cell: ({ row }) => {
                const s = row.original.risk.status;
                return s ? (
                    <StatusBadge variant={RISK_STATUS_BADGE[s] ?? 'neutral'} size="sm">
                        {RISK_STATUS_LABELS[s] ?? s}
                    </StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                );
            },
        },
        {
            id: 'via',
            header: t('col.coverage'),
            cell: ({ row }) => (
                <span className="text-xs text-content-subtle">{viaLabelT(row.original.viaControls)}</span>
            ),
        },
    ]);

    const assetColumns = createColumns<AssetEntry>([
        {
            id: 'asset',
            header: t('col.asset'),
            cell: ({ row }) => (
                <TableTitleCell href={tenantHref(`/assets/${row.original.asset.id}`)}>
                    {row.original.asset.name}
                </TableTitleCell>
            ),
        },
        {
            id: 'type',
            header: t('col.type'),
            cell: ({ row }) =>
                row.original.asset.type ? (
                    <span className="text-sm text-content-muted">
                        {ASSET_TYPE_LABELS[row.original.asset.type] ?? row.original.asset.type.replace(/_/g, ' ')}
                    </span>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'criticality',
            header: t('col.criticality'),
            cell: ({ row }) => {
                const c = row.original.asset.criticality;
                return c ? (
                    <StatusBadge variant={CRITICALITY_BADGE[c] ?? 'neutral'} size="sm">
                        {CRIT_LABELS[c] ?? c}
                    </StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                );
            },
        },
        {
            id: 'via',
            header: t('col.coverage'),
            cell: ({ row }) => (
                <span className="text-xs text-content-subtle">{viaLabelT(row.original.viaControls)}</span>
            ),
        },
    ]);

    return (
        <div className="space-y-section">
            {!editable && (
                <InlineNotice variant="info">
                    {t('policyTrace.notice')}
                </InlineNotice>
            )}

            <div className="space-y-default">
                <div className="flex items-center justify-between gap-default">
                    <Heading level={3}>{tr('common.sections.controls')}</Heading>
                    {editable && linkOptions.length > 0 && (
                        <div className="w-72 max-w-full">
                            <Combobox
                                id="policy-link-control"
                                selected={null}
                                setSelected={(o) => { if (o?.value) void handleLink(o.value); }}
                                options={linkOptions}
                                placeholder={t('policyTrace.linkControl')}
                                searchPlaceholder={t('policyTrace.linkControlSearch')}
                                disabled={linking}
                                matchTriggerWidth
                            />
                        </div>
                    )}
                </div>
                <DataTable<ControlEntry>
                    data={data?.controls ?? []}
                    columns={controlColumns}
                    loading={loading}
                    getRowId={(r) => r.id}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('policyTrace.emptyLinkedControls')}
                            description={t('policyTrace.emptyLinkedControlsDesc')}
                        />
                    }
                />
            </div>

            <div className="space-y-default">
                <Heading level={3}>{tr('common.sections.risks')}</Heading>
                <DataTable<RiskEntry>
                    data={data?.risks ?? []}
                    columns={riskColumns}
                    loading={loading}
                    getRowId={(r) => r.id}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('policyTrace.emptyRelatedRisks')}
                            description={t('policyTrace.emptyRelatedRisksDesc')}
                        />
                    }
                />
            </div>

            <div className="space-y-default">
                <Heading level={3}>{tr('common.sections.assets')}</Heading>
                <DataTable<AssetEntry>
                    data={data?.assets ?? []}
                    columns={assetColumns}
                    loading={loading}
                    getRowId={(r) => r.id}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('policyTrace.emptyRelatedAssets')}
                            description={t('policyTrace.emptyRelatedAssetsDesc')}
                        />
                    }
                />
            </div>
        </div>
    );
}
