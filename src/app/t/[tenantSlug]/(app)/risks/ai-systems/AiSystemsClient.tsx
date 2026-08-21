'use client';

/**
 * EU AI Act AI-System Registry — the register of each AI system a tenant
 * provides/deploys, with its risk-tier classification and obligation count.
 * A subpage of Risks (reached from the AI-risk area). Built on EntityListPage.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTenantHref } from '@/lib/tenant-context-provider';
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
import { usePublishDisplayedOrder } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { buildAiSystemFilters, AI_SYSTEM_FILTER_KEYS } from './filter-defs';
import { NewAiSystemModal } from './NewAiSystemModal';

export interface AiSystemRow {
    id: string;
    name: string;
    provider: string | null;
    deploymentRole: string;
    riskTier: string;
    classificationClauseId: string | null;
    status: string;
    ownerUserId: string | null;
    createdAt: string;
    _count: { requirementLinks: number };
}

interface Props {
    initialRows: AiSystemRow[];
    tenantSlug: string;
    canWrite: boolean;
}

export const TIER_VARIANT: Record<string, StatusBadgeVariant> = {
    PROHIBITED: 'error',
    HIGH: 'error',
    LIMITED: 'warning',
    MINIMAL: 'neutral',
};

const ROLE_LABEL: Record<string, string> = { PROVIDER: 'Provider', DEPLOYER: 'Deployer' };

export function AiSystemsClient(props: Props) {
    const tx = useTranslations('risks');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildAiSystemFilters(
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tx, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...AI_SYSTEM_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <AiSystemsInner {...props} />
        </FilterProvider>
    );
}

function AiSystemsInner({ initialRows, tenantSlug, canWrite }: Props) {
    const router = useRouter();
    const tenantHref = useTenantHref();
    const tx = useTranslations('risks');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () =>
            buildAiSystemFilters(
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tx, tGroup],
    );
    const { state, hasActive } = useFilters();
    const [showNew, setShowNew] = useState(false);

    const rows = useMemo(() => {
        const tiers = (state.riskTier ?? []) as string[];
        return tiers.length ? initialRows.filter((r) => tiers.includes(r.riskTier)) : initialRows;
    }, [initialRows, state.riskTier]);

    // #107 PUBLISH side. `rows` is what the table renders: the server order
    // narrowed by the risk-tier filter. There is no client sort here (no
    // column is sortable), so the filtered array IS the painted order.
    //
    // Publishing matters more here than on an SWR-backed list, not less: this
    // page is server-rendered, so the detail page has no list cache entry to
    // fall back to and the published order is the ONLY thing that can give it
    // arrows.
    usePublishDisplayedOrder(CACHE_KEYS.aiSystems.list(), rows);

    const summary = useMemo(() => {
        const high = initialRows.filter((r) => r.riskTier === 'HIGH').length;
        const prohibited = initialRows.filter((r) => r.riskTier === 'PROHIBITED').length;
        return { total: initialRows.length, high, prohibited };
    }, [initialRows]);

    const columns = useMemo(
        () =>
            createColumns<AiSystemRow>([
                {
                    id: 'name',
                    header: tx('aiSystems.colSystem'),
                    accessorFn: (r) => r.name,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`ai-system-row-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">{row.original.name}</div>
                            {row.original.provider && (
                                <div className="truncate text-xs text-content-subtle">{row.original.provider}</div>
                            )}
                        </div>
                    ),
                },
                {
                    id: 'riskTier',
                    header: tx('aiSystems.colRiskTier'),
                    accessorFn: (r) => r.riskTier,
                    cell: ({ row }) => (
                        <StatusBadge variant={TIER_VARIANT[row.original.riskTier] ?? 'neutral'}>
                            {row.original.riskTier}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'clause',
                    header: tx('aiSystems.colBasis'),
                    accessorFn: (r) => r.classificationClauseId ?? '',
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {row.original.classificationClauseId ?? '—'}
                        </span>
                    ),
                },
                {
                    id: 'role',
                    header: tx('aiSystems.colRole'),
                    accessorFn: (r) => r.deploymentRole,
                    cell: ({ row }) => (
                        <span className="text-content-muted">{ROLE_LABEL[row.original.deploymentRole] ?? row.original.deploymentRole}</span>
                    ),
                },
                {
                    id: 'obligations',
                    header: tx('aiSystems.colObligations'),
                    accessorFn: (r) => r._count.requirementLinks,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">{row.original._count.requirementLinks}</span>
                    ),
                },
            ]),
        [tx],
    );

    // Stable table-model identities — a fresh identity here rebuilds
    // the table model mid-double-click and kills row navigation (#1678).
    const getAiSystemRowId = useCallback((r: AiSystemRow) => r.id, []);
    const handleAiSystemRowClick = useCallback(
        (row: { original: AiSystemRow }) =>
            router.push(tenantHref(`/risks/ai-systems/${row.original.id}`)),
        [router, tenantHref],
    );

    return (
        <>
            <EntityListPage<AiSystemRow>
                header={{
                    back: { smart: true },
                    breadcrumbs: [
                        { label: tx('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: tx('aiSystems.risksCrumb'), href: `/t/${tenantSlug}/risks` },
                        { label: tx('aiSystems.title') },
                    ],
                    title: (
                        <>
                            <Robot className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                            {tx('aiSystems.title')}
                        </>
                    ),
                    description: tx('aiSystems.description', {
                        total: summary.total,
                        high: summary.high,
                        prohibited: summary.prohibited,
                    }),
                    actions: canWrite ? (
                        <Button variant="primary" icon={<Plus />} onClick={() => setShowNew(true)}>
                            {tx('aiSystems.addSystem')}
                        </Button>
                    ) : undefined,
                }}
                filters={{ defs: filterDefs }}
                table={{
                    data: rows,
                    columns,
                    getRowId: getAiSystemRowId,
                    onRowClick: handleAiSystemRowClick,
                    resourceName: (plural) =>
                        plural ? tx('aiSystems.resourcePlural') : tx('aiSystems.resourceSingular'),
                    emptyState: (
                        <EmptyState
                            icon={Robot}
                            title={hasActive ? tx('aiSystems.emptyMatchingTitle') : tx('aiSystems.emptyTitle')}
                            description={
                                hasActive
                                    ? tx('aiSystems.emptyMatchingDesc')
                                    : tx('aiSystems.emptyDesc')
                            }
                        />
                    ),
                }}
            />
            {showNew && (
                <NewAiSystemModal
                    tenantSlug={tenantSlug}
                    onClose={() => setShowNew(false)}
                    onCreated={(id) => {
                        setShowNew(false);
                        router.push(`/t/${tenantSlug}/risks/ai-systems/${id}`);
                    }}
                />
            )}
        </>
    );
}
