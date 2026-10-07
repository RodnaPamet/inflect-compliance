'use client';

/**
 * Process-canvas cross-link to Business Continuity. The BIA lives in the
 * Internal Audit area, NOT the canvas — this is the link out. Resolves the
 * selected node (processMapId, nodeKey → DB id) and shows "View BIA" links
 * for any analyses on the node plus an "Add BIA" affordance that deep-links
 * to the register with the process node prefilled. Context-free (uses the
 * tenantSlug prop + plain useSWR) so it renders anywhere the canvas does.
 */
import Link from 'next/link';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { apiGet } from '@/lib/api-client';
import { LifeRing } from '@inflect/ui/components/ui/icons/nucleo/life-ring';

interface NodeBia {
    processNodeId: string | null;
    rows: { id: string; name: string; criticality: string; mtpdHours: number | null }[];
}

export function NodeBiaAffordance({
    tenantSlug,
    mapId,
    nodeKey,
}: {
    tenantSlug: string;
    mapId: string;
    nodeKey: string;
}) {
    const t = useTranslations('panels.bia');
    const url = `/api/t/${tenantSlug}/business-continuity?processMapId=${encodeURIComponent(mapId)}&nodeKey=${encodeURIComponent(nodeKey)}`;
    const { data } = useSWR<NodeBia>(url, (u: string) => apiGet<NodeBia>(u));
    const rows = data?.rows ?? [];
    const addHref = `/t/${tenantSlug}/audits/business-continuity${data?.processNodeId ? `?newProcessNodeId=${data.processNodeId}` : ''}`;

    return (
        <div className="space-y-tight border-t border-border-subtle pt-3" data-testid="node-bia-affordance">
            <div className="flex items-center gap-tight">
                <LifeRing className="h-3.5 w-3.5 text-content-subtle" aria-hidden="true" />
                <span className="text-xs font-medium uppercase tracking-wide text-content-subtle">{t('businessContinuity')}</span>
            </div>
            {rows.length > 0 ? (
                <ul className="space-y-tight">
                    {rows.map((b) => (
                        <li key={b.id} className="text-xs text-content-muted">
                            <Link href={`/t/${tenantSlug}/audits/business-continuity/${b.id}`} className="text-content-link hover:underline">
                                {b.name}
                            </Link>
                            {b.mtpdHours != null && <span className="text-content-subtle"> · {t('mtpd', { hours: b.mtpdHours })}</span>}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-content-subtle">{t('biaProcessEmpty')}</p>
            )}
            <Link href={addHref} className="inline-block text-xs text-content-link hover:underline">
                {rows.length > 0 ? t('addAnotherBia') : t('addBia')}
            </Link>
        </div>
    );
}
