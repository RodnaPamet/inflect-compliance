'use client';

/**
 * DORA Register of Information — the tenant's contractual arrangements
 * with ICT third-party service providers (Art. 28(3)).
 *
 * **A projection, not a second store.** Every row is a `Vendor`; nothing
 * here is authored on this page. That is the honest shape today: the
 * register describes ICT third-party arrangements, and the vendor
 * inventory is where a tenant already records them. Adding a parallel
 * "register entry" model would create two places to keep the same fact.
 *
 * **What the projection asserts, and on what basis.** DORA's register
 * turns on one distinction: does this arrangement support a critical or
 * important function? Inflect does not hold a separate CIF flag, so the
 * page derives it from vendor criticality (CRITICAL/HIGH → yes) and SAYS
 * SO in the scope note rather than presenting a derived answer as a
 * recorded one.
 *
 * **What it does not cover.** The ESAs' implementing templates ask for
 * fields Inflect has nowhere to hold — LEI codes, annual contract value,
 * the substitutability assessment, the exit-plan reference. The scope
 * note names them. A register that silently omitted them would read as
 * complete, which is the failure mode that matters when the reader is
 * preparing a supervisory submission.
 */
import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';

import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters, type FilterType } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoTooltip } from '@/components/ui/tooltip';
import { AppIcon } from '@/components/icons/AppIcon';
import { formatDate } from '@/lib/format-date';

export interface RegisterRow {
    id: string;
    name: string;
    legalName: string | null;
    country: string | null;
    status: string;
    criticality: string;
    dataAccess: string | null;
    isSubprocessor: boolean;
    contractRenewalAt: string | null;
    nextReviewAt: string | null;
    owner: { name: string | null } | null;
}

interface Props {
    rows: RegisterRow[];
    canWrite: boolean;
}

/**
 * The one derivation on this page, kept in a named function so the rule
 * is greppable and testable rather than inlined in a cell renderer.
 *
 * DORA distinguishes arrangements that support a **critical or important
 * function** — those carry the heavier contractual, exit-plan and
 * register obligations. Inflect records vendor criticality, not CIF
 * status, so CRITICAL and HIGH are read as "yes". The scope note tells
 * the reader this is derived.
 */
export function supportsCriticalFunction(criticality: string): boolean {
    return criticality === 'CRITICAL' || criticality === 'HIGH';
}

const CRITICALITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'neutral',
};

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    ONBOARDING: 'warning',
    OFFBOARDED: 'neutral',
    SUSPENDED: 'error',
};

/** Filter facets — both are enums the register is read by. */
const REGISTER_FILTER_KEYS = ['criticality', 'status'] as const;

export function InformationRegistryClient(props: Props) {
    const filterCtx = useFilterContext([], [...REGISTER_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <RegistryInner {...props} />
        </FilterProvider>
    );
}

function RegistryInner({ rows }: Props) {
    const t = useTranslations('risks.informationRegistry');
    const router = useRouter();
    const tenantHref = useTenantHref();
    const { state, hasActive, search } = useFilters();

    const filterDefs: FilterType[] = useMemo(
        () => [
            {
                key: 'criticality',
                label: t('colCriticality'),
                icon: <AppIcon name="warning" size={16} />,
                multiple: true,
                options: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((v) => ({
                    value: v,
                    label: v,
                })),
            },
            {
                key: 'status',
                label: t('colStatus'),
                icon: <AppIcon name="activity" size={16} />,
                multiple: true,
                options: ['ACTIVE', 'ONBOARDING', 'OFFBOARDED', 'SUSPENDED'].map((v) => ({
                    value: v,
                    label: v,
                })),
            },
        ],
        [t],
    );

    const visible = useMemo(() => {
        const crit = (state.criticality ?? []) as string[];
        const status = (state.status ?? []) as string[];
        const q = (search ?? '').trim().toLowerCase();
        return rows.filter((r) => {
            if (crit.length && !crit.includes(r.criticality)) return false;
            if (status.length && !status.includes(r.status)) return false;
            if (q) {
                const haystack = `${r.name} ${r.legalName ?? ''} ${r.country ?? ''}`.toLowerCase();
                if (!haystack.includes(q)) return false;
            }
            return true;
        });
    }, [rows, state.criticality, state.status, search]);

    const criticalCount = useMemo(
        () => rows.filter((r) => supportsCriticalFunction(r.criticality)).length,
        [rows],
    );

    const columns = useMemo(
        () =>
            createColumns<RegisterRow>([
                {
                    id: 'provider',
                    header: t('colProvider'),
                    accessorFn: (r) => r.name,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`register-row-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">
                                {row.original.name}
                            </div>
                            {/* The legal entity is the name a supervisor
                                matches against, not the trading name. */}
                            {row.original.legalName && (
                                <div className="truncate text-xs text-content-subtle">
                                    {row.original.legalName}
                                </div>
                            )}
                        </div>
                    ),
                },
                {
                    id: 'function',
                    header: t('colFunction'),
                    accessorFn: (r) => (supportsCriticalFunction(r.criticality) ? 1 : 0),
                    cell: ({ row }) =>
                        supportsCriticalFunction(row.original.criticality) ? (
                            <StatusBadge variant="error">{t('functionYes')}</StatusBadge>
                        ) : (
                            <span className="text-content-muted">{t('functionNo')}</span>
                        ),
                },
                {
                    id: 'criticality',
                    header: t('colCriticality'),
                    accessorFn: (r) => r.criticality,
                    cell: ({ row }) => (
                        <StatusBadge variant={CRITICALITY_VARIANT[row.original.criticality] ?? 'neutral'}>
                            {row.original.criticality}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'country',
                    header: t('colCountry'),
                    accessorFn: (r) => r.country ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.country || t('notRecorded')}
                        </span>
                    ),
                },
                {
                    id: 'dataAccess',
                    header: t('colDataAccess'),
                    accessorFn: (r) => r.dataAccess ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.dataAccess || t('notRecorded')}
                        </span>
                    ),
                },
                {
                    id: 'contractRenewalAt',
                    header: t('colContractEnd'),
                    accessorFn: (r) => r.contractRenewalAt ?? '',
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {row.original.contractRenewalAt
                                ? formatDate(row.original.contractRenewalAt)
                                : t('notRecorded')}
                        </span>
                    ),
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    accessorFn: (r) => r.status,
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>
                            {row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'owner',
                    header: t('colOwner'),
                    accessorFn: (r) => r.owner?.name ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.owner?.name || t('notRecorded')}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    // Stable identities — a fresh one rebuilds the table model mid-click
    // and kills row navigation (#1678).
    const getRowId = useCallback((r: RegisterRow) => r.id, []);
    const onRowClick = useCallback(
        (row: { original: RegisterRow }) => router.push(tenantHref(`/vendors/${row.original.id}`)),
        [router, tenantHref],
    );

    return (
        <EntityListPage<RegisterRow>
            header={{
                back: { smart: true },
                title: (
                    <>
                        {t('title')}
                        <InfoTooltip content={t('conceptHelp')} />
                    </>
                ),
                // `description` wins over `count` when both are passed,
                // so the tally rides inside it rather than being silently
                // dropped.
                description: (
                    <>
                        <span className="block">{t('subtitle')}</span>
                        <span className="mt-tight block" data-testid="register-count">
                            {t('count', { count: rows.length })} ·{' '}
                            {t('criticalCount', { count: criticalCount })}
                        </span>
                        {/* The honesty line: what is derived, and which of
                            DORA's fields this projection cannot hold. */}
                        <span
                            className="mt-tight block text-xs text-content-subtle"
                            data-testid="register-scope-note"
                        >
                            {t('scopeNote')}
                        </span>
                    </>
                ),
            }}
            filters={{
                defs: filterDefs,
                searchId: 'information-registry-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: visible,
                columns,
                getRowId,
                onRowClick,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                emptyState: (
                    <EmptyState
                        title={hasActive ? t('emptyFilteredTitle') : t('empty')}
                        description={hasActive ? t('emptyFilteredDesc') : t('emptyDesc')}
                    />
                ),
            }}
        />
    );
}
