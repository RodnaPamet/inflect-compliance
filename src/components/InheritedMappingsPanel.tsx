'use client';

/**
 * Read-only framework-mappings list for Asset / Risk detail pages.
 * Framework requirements map to controls, so an asset/risk inherits
 * its framework coverage from the controls it is mapped to. This
 * panel fetches the aggregated requirement links (each tagged with
 * its owning control) and renders them — no add/unlink, since the
 * mapping lives on the control.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';

interface ControlRef {
    id: string;
    code: string | null;
    annexId: string | null;
    name: string;
}
interface FrameworkRef {
    id: string;
    name: string;
    version: string | null;
}
interface InheritedMappingRow {
    requirementId: string;
    code: string;
    title: string;
    framework: FrameworkRef | null;
    control: ControlRef | null;
}

export function InheritedMappingsPanel({
    endpoint,
    tenantHref,
    entityLabel,
}: {
    /** Fully-qualified tenant API path, e.g. apiUrl('/assets/123/mappings'). */
    endpoint: string;
    tenantHref: (path: string) => string;
    /** 'asset' | 'risk' — used only in the explanatory copy. */
    entityLabel: string;
}) {
    const [rows, setRows] = useState<InheritedMappingRow[]>([]);
    const [loading, setLoading] = useState(true);
    const t = useTranslations('panels');
    const entityWord = entityLabel === 'risk' ? t('inherited.entityRisk') : entityLabel === 'asset' ? t('inherited.entityAsset') : entityLabel;

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true);
        (async () => {
            try {
                const res = await fetch(endpoint);
                const data = res.ok ? await res.json() : [];
                if (!cancelled) setRows(Array.isArray(data) ? data : []);
            } catch {
                if (!cancelled) setRows([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [endpoint]);

    const columns = createColumns<InheritedMappingRow>([
        {
            id: 'code',
            header: t('col.requirement'),
            accessorFn: (r) => r.code,
            cell: ({ row }) => (
                <span className="text-sm font-medium text-content-default">
                    {row.original.code}
                </span>
            ),
        },
        {
            accessorKey: 'title',
            header: t('col.title'),
            cell: ({ getValue }) => (
                <span className="text-sm text-content-default">{getValue<string>()}</span>
            ),
        },
        {
            id: 'framework',
            header: t('col.framework'),
            cell: ({ row }) =>
                row.original.framework ? (
                    <StatusBadge variant="info" size="sm">
                        {row.original.framework.name}
                        {row.original.framework.version
                            ? ` ${row.original.framework.version}`
                            : ''}
                    </StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'control',
            header: t('col.viaControl'),
            cell: ({ row }) =>
                row.original.control ? (
                    <TableTitleCell href={tenantHref(`/controls/${row.original.control.id}`)}>
                        {row.original.control.code ||
                            row.original.control.annexId ||
                            row.original.control.name}
                    </TableTitleCell>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
    ]);

    return (
        <div className="space-y-default">
            <InlineNotice variant="info">
                {t('inherited.mappingsNotice', { entity: entityWord })}
            </InlineNotice>
            <DataTable<InheritedMappingRow>
                data={rows}
                columns={columns}
                loading={loading}
                getRowId={(r) => `${r.requirementId}:${r.control?.id ?? 'none'}`}
                emptyState={
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('inherited.mappingsEmpty')}
                        description={t('inherited.mappingsEmptyDesc', { entity: entityWord })}
                    />
                }
            />
        </div>
    );
}
