'use client';

/**
 * Governance graph page (Visual Rule Editor VR-10).
 *
 * The cross-map, system-of-record view of the tenant's automation topology:
 * every automation map as a node (sized by rule volume, ringed by execution
 * health) and the sub-flow-call relationships between them. This focused v1
 * renders the meta-graph as a health-ringed card grid + a relationships list;
 * the full xyflow meta-canvas (draggable nodes, embedded previews) is the
 * remaining UI enhancement — the builder + API already return xyflow-ready
 * `{ nodes, edges }`.
 */
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';

type Health = 'green' | 'amber' | 'red' | 'unknown';

interface GovernanceNode {
    id: string;
    name: string;
    canvasMode: string;
    ruleCount: number;
    size: number;
    successRate: number | null;
    health: Health;
}
interface GovernanceEdge {
    id: string;
    source: string;
    target: string;
    kind: 'subflow-call' | 'shared-rule';
}

const HEALTH_RING: Record<Health, string> = {
    green: 'ring-content-success',
    amber: 'ring-content-warning',
    red: 'ring-content-error',
    unknown: 'ring-border-subtle',
};

export default function GovernanceGraphPage() {
    const t = useTranslations('processes');
    const { data, isLoading } = useTenantSWR<{
        nodes: GovernanceNode[];
        edges: GovernanceEdge[];
    }>(CACHE_KEYS.processes.governanceGraph());

    const tenantHref = useTenantHref();
    const nodes = data?.nodes ?? [];
    const edges = data?.edges ?? [];
    const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;

    return (
        <div className="space-y-section p-default" data-testid="governance-graph-page">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('governance.crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('governance.crumbProcesses'), href: tenantHref('/processes') },
                    { label: t('governance.crumbGraph') },
                ]}
            />
            <div>
                <Heading level={1}>{t('governance.topologyHeading')}</Heading>
                <p className="text-sm text-content-muted">
                    {t('governance.topologyDescription')}
                </p>
            </div>

            {isLoading && <p className="text-sm text-content-subtle">{t('governance.building')}</p>}

            {!isLoading && nodes.length === 0 && (
                <p className="text-sm text-content-subtle">
                    {t('governance.empty')}
                </p>
            )}

            <div className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3">
                {nodes.map((n) => (
                    <div
                        key={n.id}
                        data-governance-node={n.id}
                        data-health={n.health}
                        className={`rounded-lg border border-border-subtle bg-bg-subtle/40 p-default ring-2 ${HEALTH_RING[n.health]}`}
                    >
                        <div className="flex items-center justify-between">
                            <span className="font-medium text-content-emphasis">{n.name}</span>
                            {/* The governance graph only sources AUTOMATION maps
                                (getGovernanceGraph filters canvasMode: 'AUTOMATION'),
                                so every node is an automation map. */}
                            <StatusBadge variant="info">
                                {t('governance.canvasMode.AUTOMATION')}
                            </StatusBadge>
                        </div>
                        <div className="mt-2 flex items-center gap-default text-xs text-content-muted tabular-nums">
                            <span>{t('governance.rulesCount', { count: n.ruleCount })}</span>
                            <span>
                                {n.successRate === null
                                    ? t('governance.noRuns')
                                    : t('governance.successPct', { pct: Math.round(n.successRate * 100) })}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            {edges.length > 0 && (
                <div className="space-y-default">
                    <Heading level={3}>{t('governance.subflowCalls')}</Heading>
                    <ul className="space-y-tight text-sm text-content-muted" data-testid="governance-edges">
                        {edges.map((e) => (
                            <li key={e.id} data-governance-edge={e.id}>
                                {nameOf(e.source)} → {nameOf(e.target)}{' '}
                                <span className="text-content-subtle">({e.kind})</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
