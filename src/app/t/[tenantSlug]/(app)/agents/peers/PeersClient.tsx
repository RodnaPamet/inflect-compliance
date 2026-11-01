'use client';

/**
 * THE A2A PEERS LIST (#3679) — the agents in other organisations this tenant
 * exchanges tasks with, and the tenant's own signing key above them.
 *
 * Read-only at the row level: a row opens the peer, where its kill switch,
 * inbound credential, quota, card review and signed receipts live. The header's
 * Peer button opens the registration form above the list (#3807); a peer it
 * registers is refused until a person approves its card on the peer's page,
 * which is where the form lands.
 *
 * The CARD column reads the stored last observation, not the live card, and
 * the column says which: admission never trusts the stored hash, it reads the
 * live card before every message (`admitPeerMessage`).
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Globe, Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/hooks';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { createColumns } from '@/components/ui/table';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { buildPeerFilters, PEER_FILTER_KEYS } from './filter-defs';
import { PEER_CARD_LABEL_KEY, PEER_CARD_VARIANT, peerCardState, peerPinState } from './peer-state';
import { RegisterPeerForm, type PeerChoice, type RegisteredPeer } from './RegisterPeerForm';
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
    /** Who answers for the peer, and its supplier, by name (#4901). */
    ownerName: string | null;
    vendorName: string | null;
}

interface Props {
    tenantSlug: string;
    initialRows: PeerRow[];
    signingKey: SigningKeyView;
    canReviewProposals: boolean;
    canCompose: boolean;
    /** Active members, who may answer for a peer. */
    owners?: PeerChoice[];
    /** The first page of the tenant's suppliers; the form searches for the rest. */
    vendors?: PeerChoice[];
    /** The member or vendor read failed, so the form cannot offer them (#4901). */
    ownersUnavailable?: boolean;
    vendorsUnavailable?: boolean;
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

function PeersInner({
    tenantSlug,
    initialRows,
    signingKey,
    canReviewProposals,
    canCompose,
    owners = [],
    vendors = [],
    ownersUnavailable = false,
    vendorsUnavailable = false,
}: Props) {
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
                        const variant: StatusBadgeVariant = PEER_CARD_VARIANT[card];
                        const label = t(PEER_CARD_LABEL_KEY[card]);
                        return (
                            <StatusBadge variant={variant} size="sm" data-testid={`peer-card-${row.original.id}`}>
                                {label}
                            </StatusBadge>
                        );
                    },
                },
                {
                    id: 'owner',
                    header: t('peers.colOwner'),
                    accessorFn: (r) => r.ownerName ?? '',
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">{row.original.ownerName ?? '—'}</span>
                    ),
                },
                {
                    id: 'vendor',
                    header: t('peers.colVendor'),
                    accessorFn: (r) => r.vendorName ?? '',
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">{row.original.vendorName ?? '—'}</span>
                    ),
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

    const toast = useToast();
    const [registering, setRegistering] = useState(false);
    const onRegistered = useCallback(
        (registered: RegisteredPeer) => {
            // The peer is refused until its card is approved, which is done on
            // its page — so that is where the form lands.
            toast.success(
                registered.card.readable
                    ? t('peers.register.done', { name: registered.peer.name })
                    : t('peers.register.doneCardUnreadable', { name: registered.peer.name }),
            );
            setRegistering(false);
            guardedPush(`/t/${tenantSlug}/agents/peers/${registered.peer.id}`);
        },
        [guardedPush, t, tenantSlug, toast],
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
                actions: (
                    // Secondary: the form it opens carries the submit, and the
                    // list's own content is read-only.
                    <Button
                        type="button"
                        variant="secondary"
                        icon={<Plus className="h-4 w-4" />}
                        onClick={() => setRegistering(true)}
                        disabled={registering}
                        data-testid="peer-register-open"
                    >
                        {t('peers.register.open')}
                    </Button>
                ),
            }}
            banner={
                <div className="space-y-default">
                    {registering && (
                        <RegisterPeerForm
                            owners={owners}
                            vendors={vendors}
                            ownersUnavailable={ownersUnavailable}
                            vendorsUnavailable={vendorsUnavailable}
                            onRegistered={onRegistered}
                            onCancel={() => setRegistering(false)}
                        />
                    )}
                    <SigningKeyPanel view={signingKey} />
                </div>
            }
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
