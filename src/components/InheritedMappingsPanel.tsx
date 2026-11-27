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
import { ContentText } from '@/components/ContentText';

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
    /** 'asset' | 'risk' | 'policy' — used only in the explanatory copy. */
    entityLabel: string;
}) {
    const [rows, setRows] = useState<InheritedMappingRow[]>([]);
    const [loading, setLoading] = useState(true);
    // A failed or refused load is not "nothing inherited": a reviewer would
    // read the empty state as a coverage gap (#5309).
    const [failed, setFailed] = useState(false);
    const t = useTranslations('panels');
    const entityWord = entityLabel === 'risk' ? t('inherited.entityRisk') : entityLabel === 'asset' ? t('inherited.entityAsset') : entityLabel === 'policy' ? t('inherited.entityPolicy') : entityLabel;

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true);
        setFailed(false);
        void (async () => {
            try {
                const res = await fetch(endpoint);
                if (!res.ok) throw new Error(String(res.status));
                const data = await res.json();
                if (!cancelled) setRows(Array.isArray(data) ? data : []);
            } catch {
                if (!cancelled) {
                    setRows([]);
                    setFailed(true);
                }
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
                <span className="text-sm text-content-default"><ContentText text={getValue<string>()} /></span>
            ),
        },
        {
            id: 'framework',
            header: t('col.framework'),
            cell: ({ row }) =>
                row.original.framework ? (
                    <StatusBadge variant="info" size="sm">
                        <ContentText text={row.original.framework.name} />
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
                            <ContentText text={row.original.control.name} />}
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
            {failed ? (
                <InlineNotice variant="error">{t('inherited.mappingsLoadError')}</InlineNotice>
            ) : (
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
            )}
        </div>
    );
}
