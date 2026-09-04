'use client';

/**
 * The agent register.
 *
 * One row per autonomous agent the tenant runs, showing the four properties
 * that decide how much authority it may hold. Two things about the columns are
 * deliberate and easy to get wrong:
 *
 *   • "Authority tier" and "AI Act" are DIFFERENT taxonomies and sit in
 *     separate columns. One is the agent's operational authority, the other is
 *     the Regulation's classification of the AI system it belongs to. A LOW
 *     agent inside a HIGH AI system is an ordinary combination, and merging the
 *     two columns would make that look like a contradiction.
 *
 *   • An unscored tier renders as "Unscored", never as a dash and never as a
 *     low tier. NULL means nobody has assessed this agent, and the whole
 *     register exists because that is the state you most want to see.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { Robot } from '@/components/ui/icons/nucleo/robot';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoTooltip } from '@/components/ui/tooltip';
import { buildAgentFilters, AGENT_FILTER_KEYS } from './filter-defs';
import { NewAgentModal, type OwnerOption, type VendorOption } from './NewAgentModal';

export interface AgentRow {
    id: string;
    name: string;
    status: string;
    autonomyLevel: number;
    dataAccessScope: string;
    reversibility: string;
    provenance: string;
    riskTier: string | null;
    isLegacyPlaceholder: boolean;
    owner: { id: string; name: string | null } | null;
    aiSystem: { id: string; riskTier: string; classificationClauseId: string | null } | null;
    _count: { apiKeys: number };
}

interface Props {
    initialRows: AgentRow[];
    tenantSlug: string;
    owners: OwnerOption[];
    vendors: VendorOption[];
    canWrite: boolean;
}

/** Where an agent sits in its lifecycle. Only ACTIVE reaches the agent surface. */
const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    ACTIVE: 'success',
    SUSPENDED: 'warning',
    RETIRED: 'neutral',
};

/** Operational authority. UNSCORED is rendered separately — it is not a tier. */
const TIER_VARIANT: Record<string, StatusBadgeVariant> = {
    LOW: 'neutral',
    MODERATE: 'info',
    HIGH: 'warning',
    CRITICAL: 'error',
};

/** The Regulation's classification of the AI system the agent belongs to. */
const AI_ACT_VARIANT: Record<string, StatusBadgeVariant> = {
    PROHIBITED: 'error',
    HIGH: 'error',
    LIMITED: 'warning',
    MINIMAL: 'neutral',
};

const AUTONOMY_MAX = 6;

export function AgentsClient(props: Props) {
    const t = useTranslations('admin');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildAgentFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...AGENT_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <AgentsInner {...props} />
        </FilterProvider>
    );
}

function AgentsInner({ initialRows, tenantSlug, owners, vendors, canWrite }: Props) {
    const router = useRouter();
    const t = useTranslations('admin');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () =>
            buildAgentFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const { state, hasActive } = useFilters();
    const [showNew, setShowNew] = useState(false);

    const rows = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        const scopes = (state.dataAccessScope ?? []) as string[];
        return initialRows.filter(
            (r) =>
                (statuses.length === 0 || statuses.includes(r.status)) &&
                (scopes.length === 0 || scopes.includes(r.dataAccessScope)),
        );
    }, [initialRows, state.status, state.dataAccessScope]);

    const summary = useMemo(
        () => ({
            total: initialRows.length,
            active: initialRows.filter((r) => r.status === 'ACTIVE').length,
            unscored: initialRows.filter((r) => r.riskTier === null).length,
        }),
        [initialRows],
    );

    const columns = useMemo(
        () =>
            createColumns<AgentRow>([
                {
                    id: 'name',
                    header: t('agentRegistry.colAgent'),
                    accessorFn: (r) => r.name,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`agent-row-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">
                                {row.original.name}
                            </div>
                            <div className="truncate text-xs text-content-subtle">
                                {row.original.isLegacyPlaceholder
                                    ? t('agentRegistry.legacyPlaceholder')
                                    : (row.original.owner?.name ?? t('agentRegistry.noOwner'))}
                            </div>
                        </div>
                    ),
                },
                {
                    id: 'status',
                    header: t('agentRegistry.colStatus'),
                    accessorFn: (r) => r.status,
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>
                            {t(`agentRegistry.filterEnums.status.${row.original.status}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'autonomy',
                    header: t('agentRegistry.colAutonomy'),
                    accessorFn: (r) => r.autonomyLevel,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {t('agentRegistry.autonomyOf', {
                                level: row.original.autonomyLevel,
                                max: AUTONOMY_MAX,
                            })}
                        </span>
                    ),
                },
                {
                    id: 'dataAccessScope',
                    header: t('agentRegistry.colAccess'),
                    accessorFn: (r) => r.dataAccessScope,
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {t(`agentRegistry.filterEnums.accessScope.${row.original.dataAccessScope}`)}
                        </span>
                    ),
                },
                {
                    id: 'reversibility',
                    header: t('agentRegistry.colReversibility'),
                    accessorFn: (r) => r.reversibility,
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {t(`agentRegistry.reversibility.${row.original.reversibility}`)}
                        </span>
                    ),
                },
                {
                    id: 'riskTier',
                    header: t('agentRegistry.colTier'),
                    accessorFn: (r) => r.riskTier ?? '',
                    cell: ({ row }) =>
                        row.original.riskTier ? (
                            <StatusBadge variant={TIER_VARIANT[row.original.riskTier] ?? 'neutral'}>
                                {row.original.riskTier}
                            </StatusBadge>
                        ) : (
                            // Not a dash. NULL means nobody has assessed this
                            // agent, and every consumer reads that as deny.
                            <span className="inline-flex items-center gap-tight text-content-subtle">
                                {t('agentRegistry.unscored')}
                                <InfoTooltip content={t('agentRegistry.unscoredHint')} />
                            </span>
                        ),
                },
                {
                    id: 'aiAct',
                    header: t('agentRegistry.colAiAct'),
                    accessorFn: (r) => r.aiSystem?.riskTier ?? '',
                    cell: ({ row }) =>
                        row.original.aiSystem ? (
                            <span className="inline-flex items-center gap-tight">
                                <StatusBadge
                                    variant={AI_ACT_VARIANT[row.original.aiSystem.riskTier] ?? 'neutral'}
                                >
                                    {row.original.aiSystem.riskTier}
                                </StatusBadge>
                                <span className="tabular-nums text-xs text-content-subtle">
                                    {row.original.aiSystem.classificationClauseId ?? ''}
                                </span>
                            </span>
                        ) : null,
                },
                {
                    id: 'keys',
                    header: t('agentRegistry.colKeys'),
                    accessorFn: (r) => r._count.apiKeys,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {row.original._count.apiKeys}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    // Stable table-model identities — a fresh identity here rebuilds the table
    // model mid-click and kills row interaction (#1678).
    const getAgentRowId = useCallback((r: AgentRow) => r.id, []);

    return (
        <>
            <EntityListPage<AgentRow>
                header={{
                    back: { smart: true },
                    breadcrumbs: [
                        { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('crumb.admin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('crumb.agents') },
                    ],
                    title: (
                        <>
                            <Robot className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                            {t('agentRegistry.title')}
                        </>
                    ),
                    // `count`, not `description`: EntityListPage lets
                    // `description` WIN when both are passed, so passing both
                    // would silently drop the tally. The narrative intro has a
                    // home already — it is the /admin/mcp hub card's copy.
                    count: t('agentRegistry.count', summary),
                    actions: canWrite ? (
                        <Button variant="primary" icon={<Plus />} onClick={() => setShowNew(true)}>
                            {t('agentRegistry.addAgent')}
                        </Button>
                    ) : undefined,
                }}
                filters={{ defs: filterDefs }}
                table={{
                    'data-testid': 'agents-table',
                    data: rows,
                    columns,
                    getRowId: getAgentRowId,
                    resourceName: (plural) =>
                        plural
                            ? t('agentRegistry.resourcePlural')
                            : t('agentRegistry.resourceSingular'),
                    emptyState: (
                        <EmptyState
                            icon={Robot}
                            title={
                                hasActive
                                    ? t('agentRegistry.emptyMatchingTitle')
                                    : t('agentRegistry.emptyTitle')
                            }
                            description={
                                hasActive
                                    ? t('agentRegistry.emptyMatchingDesc')
                                    : t('agentRegistry.emptyDesc')
                            }
                        />
                    ),
                }}
            />
            {showNew && (
                <NewAgentModal
                    tenantSlug={tenantSlug}
                    owners={owners}
                    vendors={vendors}
                    onClose={() => setShowNew(false)}
                    onCreated={() => {
                        setShowNew(false);
                        router.refresh();
                    }}
                />
            )}
        </>
    );
}
