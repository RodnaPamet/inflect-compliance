'use client';

/**
 * Device inventory (PR-5). Managed endpoints reported by an agent (token) or
 * entered manually, with per-device posture (encryption / screen lock /
 * antivirus / password manager). Posture is TRI-STATE: Yes / No / N-A (null =
 * NOT_APPLICABLE, e.g. Linux screen lock). Built on EntityListPage.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { DEVICE_LIST_CAP } from '@/lib/device-list';
import { Desktop } from '@inflect/ui/components/ui/icons/nucleo/desktop';
import { buildDeviceFilters, DEVICE_FILTER_KEYS } from './filter-defs';

export interface DeviceRow {
    id: string;
    serialNumber: string | null;
    hostname: string | null;
    platform: string;
    source: string;
    diskEncrypted: boolean | null;
    screenLockEnabled: boolean | null;
    antivirusRunning: boolean | null;
    passwordManagerPresent: boolean | null;
    /** The employee the device belongs to, when it is linked to one. */
    employee: { fullName: string } | null;
    lastCheckIn: string | null;
}

interface Props {
    initialRows: DeviceRow[];
    /** The inventory holds more than `DEVICE_LIST_CAP` devices. */
    truncated?: boolean;
}

/** A stored value's label, or the value itself for one this build does not know. */
function labelOr(t: (k: string) => string, has: (k: string) => boolean, key: string, raw: string): string {
    return has(key) ? t(key) : raw;
}

/** Tri-state posture badge: true=Yes(success), false=No(error), null=N/A(neutral). */
function posture(t: (k: string) => string, v: boolean | null) {
    let variant: StatusBadgeVariant = 'neutral';
    let label = t('naShort');
    if (v === true) {
        variant = 'success';
        label = t('yes');
    } else if (v === false) {
        variant = 'error';
        label = t('no');
    }
    return <StatusBadge variant={variant}>{label}</StatusBadge>;
}

export function DevicesClient(props: Props) {
    const t = useTranslations('devices');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () => buildDeviceFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...DEVICE_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <DevicesInner {...props} />
        </FilterProvider>
    );
}

function DevicesInner({ initialRows, truncated = false }: Props) {
    const t = useTranslations('devices');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () => buildDeviceFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { state, hasActive, search } = useFilters();
    const term = search.trim().toLowerCase();

    const rows = useMemo(() => {
        const platforms = (state.platform ?? []) as string[];
        return initialRows.filter((r) => {
            if (platforms.length && !platforms.includes(r.platform)) return false;
            if (!term) return true;
            return [r.hostname, r.serialNumber, r.employee?.fullName]
                .some((v) => v != null && v.toLowerCase().includes(term));
        });
    }, [initialRows, state.platform, term]);

    const columns = useMemo(
        () => {
            const tAny = t as unknown as ((k: string) => string) & { has: (k: string) => boolean };
            const platformLabel = (p: string) => labelOr(tAny, tAny.has, `filterEnums.platform.${p}`, p);
            const sourceLabel = (src: string) => labelOr(tAny, tAny.has, `source.${src}`, src);
            return createColumns<DeviceRow>([
                {
                    id: 'device',
                    header: t('colDevice'),
                    accessorFn: (r) => r.hostname ?? r.serialNumber ?? '',
                    cell: ({ row }) => (
                        <div className="min-w-0">
                            <div className="truncate font-medium text-content-default">{row.original.hostname ?? row.original.serialNumber ?? '—'}</div>
                            <div className="truncate text-xs text-content-subtle">{platformLabel(row.original.platform)} · {sourceLabel(row.original.source)}</div>
                        </div>
                    ),
                },
                {
                    id: 'owner',
                    header: t('colOwner'),
                    accessorFn: (r) => r.employee?.fullName ?? '',
                    cell: ({ row }) => <span className="text-content-default">{row.original.employee?.fullName ?? '—'}</span>,
                },
                {
                    id: 'lastCheckIn',
                    header: t('colLastCheckIn'),
                    accessorFn: (r) => r.lastCheckIn ?? '',
                    cell: ({ row }) => (
                        <span className="whitespace-nowrap text-content-muted">
                            {row.original.lastCheckIn ? formatDateTime(row.original.lastCheckIn) : '—'}
                        </span>
                    ),
                },
                { id: 'encrypted', header: t('colEncrypted'), accessorFn: (r) => String(r.diskEncrypted), cell: ({ row }) => posture(t, row.original.diskEncrypted) },
                { id: 'screenlock', header: t('colScreenLock'), accessorFn: (r) => String(r.screenLockEnabled), cell: ({ row }) => posture(t, row.original.screenLockEnabled) },
                { id: 'antivirus', header: t('colAntivirus'), accessorFn: (r) => String(r.antivirusRunning), cell: ({ row }) => posture(t, row.original.antivirusRunning) },
                { id: 'pwmanager', header: t('colPwManager'), accessorFn: (r) => String(r.passwordManagerPresent), cell: ({ row }) => posture(t, row.original.passwordManagerPresent) },
            ]);
        },
        [t],
    );

    return (
        <EntityListPage<DeviceRow>
            header={{
                title: (
                    <>
                        <Desktop className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                        {t('title')}
                    </>
                ),
                description: t('description', { total: initialRows.length }),
                back: { smart: true },
            }}
            filters={{ defs: filterDefs, searchId: 'devices-search', searchPlaceholder: t('searchPlaceholder') }}
            banner={<TruncationBanner truncated={truncated} cap={DEVICE_LIST_CAP} />}
            table={{
                data: rows,
                columns,
                getRowId: (r) => r.id,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                emptyState: (
                    <EmptyState
                        icon={Desktop}
                        title={hasActive || term ? t('emptyMatchingTitle') : t('emptyTitle')}
                        description={hasActive || term ? t('emptyMatchingDesc') : t('emptyDesc')}
                    />
                ),
            }}
        />
    );
}
