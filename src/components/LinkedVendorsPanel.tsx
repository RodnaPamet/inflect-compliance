'use client';

/**
 * Reverse "Linked vendors" panel — shows which vendors are linked to a
 * given entity (Risk / Control / Asset / Task-as-Issue). The link itself
 * lives on the vendor side; this is a read-only projection of the reverse
 * edge, mounted as a section inside an existing detail-page tab.
 *
 * Backend contract:
 *   GET /vendors/linked?entityType={RISK|CONTROL|ASSET|ISSUE}&entityId={id}
 *     → 200 Array<{ vendorId, vendorName, relation }>
 *   relation ∈ USES | STORES_DATA_FOR | PROVIDES_SERVICE_TO | MITIGATES | RELATED
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { SkeletonCard } from '@/components/ui/skeleton';
import type { StatusBadgeVariant } from '@/components/ui/status-badge';

type LinkedVendorEntityType = 'RISK' | 'CONTROL' | 'ASSET' | 'ISSUE';

interface LinkedVendorRow {
    vendorId: string;
    vendorName: string;
    relation: string;
}

// Relation → badge tone. The reverse edge is informational; MITIGATES is
// the only "good news" tone (a vendor actively reducing this risk).
const RELATION_VARIANT: Record<string, StatusBadgeVariant> = {
    USES: 'info',
    STORES_DATA_FOR: 'warning',
    PROVIDES_SERVICE_TO: 'info',
    MITIGATES: 'success',
    RELATED: 'neutral',
};

function relationLabel(relation: string): string {
    return relation
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export function LinkedVendorsPanel({
    entityType,
    entityId,
}: {
    entityType: LinkedVendorEntityType;
    entityId: string;
}) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('vendors');

    const [rows, setRows] = useState<LinkedVendorRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true);
        setFailed(false);
        (async () => {
            try {
                const res = await fetch(
                    apiUrl(
                        `/vendors/linked?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`,
                    ),
                );
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
    }, [apiUrl, entityType, entityId]);

    return (
        <div className="space-y-default">
            <Heading level={3}>{t('linkedVendors.title')}</Heading>
            {loading ? (
                <SkeletonCard lines={2} />
            ) : failed ? (
                <InlineNotice variant="error">{t('linkedVendors.loadError')}</InlineNotice>
            ) : rows.length === 0 ? (
                <EmptyState
                    size="sm"
                    variant="no-records"
                    title={t('linkedVendors.empty')}
                />
            ) : (
                <ul className="divide-y divide-border-subtle rounded-md border border-border-default">
                    {rows.map((row) => (
                        <li
                            key={`${row.vendorId}:${row.relation}`}
                            className="flex items-center justify-between gap-compact px-4 py-2.5"
                        >
                            <Link
                                href={tenantHref(`/vendors/${row.vendorId}`)}
                                className="text-sm font-medium text-content-link hover:underline"
                            >
                                {row.vendorName}
                            </Link>
                            <StatusBadge
                                variant={RELATION_VARIANT[row.relation] ?? 'neutral'}
                                size="sm"
                            >
                                {relationLabel(row.relation)}
                            </StatusBadge>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export default LinkedVendorsPanel;
