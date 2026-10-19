'use client';

/**
 * THE A2A PEERS LIST (#3679) — the agents in other organisations this tenant
 * exchanges tasks with, and the tenant's own signing key above them.
 *
 * Read-only at the row level: a row opens the peer, where its kill switch,
 * inbound credential, quota and signed receipts live. Registering a peer and
 * approving its card stay the API's (`/admin/agents/peers`, step 2e) — this
 * page shows what admits a peer and what stops one.
 *
 * The CARD column reads the stored last observation, not the live card, and
 * the column says which: admission never trusts the stored hash, it reads the
 * live card before every message (`admitPeerMessage`).
 */
import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Globe } from '@inflect/ui/components/ui/icons/nucleo';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { createColumns } from '@/components/ui/table';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { buildPeerFilters, PEER_FILTER_KEYS } from './filter-defs';
import { peerCardState, peerPinState } from './peer-state';
import { SigningKeyPanel, type SigningKeyView } from './SigningKeyPanel';

export interface PeerRow {
    id: string;
    name: string;
    cardUrl: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
    pinnedCardHash: string | null;
    pinRevision: number;
    observedCardHash: string | null;
    inboundMessagesPerHour: number;
}

interface Props {
    tenantSlug: string;
    initialRows: PeerRow[];
    signingKey: SigningKeyView;
    canReviewProposals: boolean;
    canCompose: boolean;
}

const STATUS_VARIANT: Record<PeerRow['status'], StatusBadgeVariant> = {
    ACTIVE: 'success',
    SUSPENDED: 'warning',
    RETIRED: 'neutral',
};

const STATUS_LABEL_KEY = {
    ACTIVE: 'peers.statusActive',
    SUSPENDED: 'peers.statusSuspended',
    RETIRED: 'peers.statusRetired',
} as const;

/** The filter labels, resolved by the caller's own bound translators. */
function usePeerFilters() {
    const tPeers = useTranslations('agents');
    const tGroup = useTranslations('common.filterGroups');
    return useMemo(
        () =>
            buildPeerFilters({
                status: tPeers('peers.filters.status'),
                statusDesc: tPeers('peers.filters.statusDesc'),
                group: tGroup('attributes'),
                statusValues: {
                    ACTIVE: tPeers('peers.filterEnums.status.ACTIVE'),
                    SUSPENDED: tPeers('peers.filterEnums.status.SUSPENDED'),
                    RETIRED: tPeers('peers.filterEnums.status.RETIRED'),
                },
            }),
        [tPeers, tGroup],
    );
}

export function PeersClient(props: Props) {
    const filters = usePeerFilters();
    const filterCtx = useFilterContext(filters, [...PEER_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <PeersInner {...props} />
        </FilterProvider>
    );
}

function PeersInner({ tenantSlug, initialRows, signingKey, canReviewProposals, canCompose }: Props) {
    // `useGuardedPush`, not `router.push`: a cold row click during hydration
    // can have its transition dropped by the client router (#3099).
    const guardedPush = useGuardedPush();
    const t = useTranslations('agents');
    const filterDefs = usePeerFilters();
    const { state, search, hasActive } = useFilters();

    const rows = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        const q = search.trim().toLowerCase();
        return initialRows.filter(
            (r) =>
                (statuses.length === 0 || statuses.includes(r.status)) &&
                (q === '' || r.name.toLowerCase().includes(q) || r.cardUrl.toLowerCase().includes(q)),
        );
    }, [initialRows, state.status, search]);

    const columns = useMemo(
        () =>
            createColumns<PeerRow>([
                {
                    id: 'name',
                    header: t('peers.colName'),
                    accessorFn: (r) => r.name,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`peer-row-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">{row.original.name}</div>
                            <div className="truncate font-mono text-xs text-content-subtle">{row.original.cardUrl}</div>
                        </div>
                    ),
                },
                {
                    id: 'status',
                    header: t('peers.colStatus'),
                    accessorFn: (r) => r.status,
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status]} size="sm">
                            {t(STATUS_LABEL_KEY[row.original.status])}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'pin',
                    header: t('peers.colPin'),
                    accessorFn: (r) => r.pinRevision,
                    cell: ({ row }) => {
                        const pin = peerPinState(row.original);
                        return pin.kind === 'none' ? (
                            <StatusBadge variant="error" size="sm" data-testid={`peer-pin-${row.original.id}`}>
                                {t('peers.pinNone')}
                            </StatusBadge>
                        ) : (
                            <span className="text-sm text-content-default" data-testid={`peer-pin-${row.original.id}`}>
                                {t('peers.pinRevision', { revision: pin.revision })}
                            </span>
                        );
                    },
                },
                {
                    id: 'card',
                    header: t('peers.colCard'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const card = peerCardState(row.original);
                        const variant: StatusBadgeVariant =
                            card === 'matches' ? 'success' : card === 'changed' ? 'error' : 'neutral';
                        const label =
                            card === 'matches'
                                ? t('peers.cardMatches')
                                : card === 'changed'
                                  ? t('peers.cardChanged')
                                  : t('peers.cardUnobserved');
                        return (
                            <StatusBadge variant={variant} size="sm" data-testid={`peer-card-${row.original.id}`}>
                                {label}
                            </StatusBadge>
                        );
                    },
                },
                {
                    id: 'quota',
                    header: t('peers.colQuota'),
                    accessorFn: (r) => r.inboundMessagesPerHour,
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {t('peers.quotaValue', { count: row.original.inboundMessagesPerHour })}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    const handleRowClick = useCallback(
        (row: { original: PeerRow }) => guardedPush(`/t/${tenantSlug}/agents/peers/${row.original.id}`),
        [guardedPush, tenantSlug],
    );

    return (
        <EntityListPage<PeerRow>
            header={{
                // A SUBPAGE of the register (`page-segregation`), so it carries
                // the smart Back as well as the trail.
                back: { smart: true },
                breadcrumbs: [
                    { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('register.breadcrumb'), href: `/t/${tenantSlug}/agents` },
                    { label: t('peers.breadcrumb') },
                ],
                title: (
                    <>
                        <Globe className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                        {t('peers.title')}
                    </>
                ),
                description: t('peers.description'),
            }}
            banner={<SigningKeyPanel view={signingKey} />}
            filters={{
                defs: filterDefs,
                searchId: 'peers-search',
                searchPlaceholder: t('peers.searchPlaceholder'),
                toolbarActions: (
                    <AgentsViewsMenu
                        current="peers"
                        tenantSlug={tenantSlug}
                        canReviewProposals={canReviewProposals}
                        canCompose={canCompose}
                        canInvestigate
                    />
                ),
            }}
            table={{
                'data-testid': 'peers-table',
                data: rows,
                columns,
                getRowId: (r) => r.id,
                onRowClick: handleRowClick,
                selectionEnabled: false,
                resourceName: (plural) => (plural ? t('peers.resourcePlural') : t('peers.resourceSingular')),
                emptyState: (
                    <EmptyState
                        icon={Globe}
                        title={hasActive ? t('peers.emptyMatchingTitle') : t('peers.emptyTitle')}
                        description={hasActive ? t('peers.emptyMatchingDesc') : t('peers.emptyDesc')}
                    />
                ),
            }}
        />
    );
}
