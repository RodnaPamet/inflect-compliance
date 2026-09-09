'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { MetaStrip, type MetaItem } from '@/components/ui/meta-strip';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { OverviewTab } from './tabs/OverviewTab';
import { RiskAssessmentTab } from './tabs/RiskAssessmentTab';
import { PolicyCardTab } from './tabs/PolicyCardTab';
import { ToolsTab } from './tabs/ToolsTab';
import { CoverageTab } from './tabs/CoverageTab';
import { CircuitBreakerTab } from './tabs/CircuitBreakerTab';

export interface AgentSummary {
    id: string;
    name: string;
    status: string;
    autonomyLevel: number;
    dataAccessScope: string;
    reversibility: string;
    provenance: string;
    riskTier: string | null;
    aiActRiskTier: string | null;
}

const TAB_KEYS = ['overview', 'risk', 'policy', 'tools', 'coverage', 'breaker'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** SUSPENDED and RETIRED are the states an operator is looking FOR. */
function statusVariant(status: string): StatusBadgeVariant {
    if (status === 'ACTIVE') return 'success';
    if (status === 'SUSPENDED') return 'error';
    if (status === 'RETIRED') return 'neutral';
    return 'warning';
}

export function AgentDetailClient({
    tenantSlug,
    agent,
}: {
    tenantSlug: string;
    agent: AgentSummary;
}) {
    const t = useTranslations('admin');
    const [tab, setTab] = useState<TabKey>('overview');
    const [refreshToken, setRefreshToken] = useState(0);

    // Handed to tabs so a mutation in one (suspending the agent, pulling the
    // breaker) can make the others re-read without the shell knowing what
    // any of them holds.
    const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

    const meta: MetaItem[] = [
        { label: t('agentDetail.metaAutonomy'), value: `L${agent.autonomyLevel}` },
        { label: t('agentDetail.metaAccess'), value: agent.dataAccessScope },
        { label: t('agentDetail.metaReversibility'), value: agent.reversibility },
        { label: t('agentDetail.metaProvenance'), value: agent.provenance },
        {
            label: t('agentDetail.metaTier'),
            // An unscored agent says so. A dash would read as "no risk".
            value: agent.riskTier ?? t('agentDetail.unscored'),
        },
        {
            label: t('agentDetail.metaAiAct'),
            value: agent.aiActRiskTier ?? t('agentDetail.unclassified'),
        },
    ];

    const props = { tenantSlug, agentId: agent.id, refreshToken };

    return (
        <EntityDetailLayout<TabKey>
            // `smart` rather than a static href: it resolves from the in-tab
            // referrer, so arriving from the proposals queue goes BACK there
            // instead of to the register nobody came from. A cold load or deep
            // link falls back to the canonical parent, which is registered as
            // `/admin/agents` — the static link this replaced.
            back={{ smart: true }}
            breadcrumbs={[
                { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: t('crumb.admin'), href: `/t/${tenantSlug}/admin` },
                { label: t('crumb.agents'), href: `/t/${tenantSlug}/admin/agents` },
                { label: agent.name },
            ]}
            title={
                <span className="flex items-center gap-default">
                    {agent.name}
                    <StatusBadge variant={statusVariant(agent.status)}>{agent.status}</StatusBadge>
                </span>
            }
            meta={<MetaStrip items={meta} />}
            tabs={[
                { key: 'overview', label: t('agentDetail.tabOverview') },
                { key: 'risk', label: t('agentDetail.tabRisk') },
                { key: 'policy', label: t('agentDetail.tabPolicy') },
                { key: 'tools', label: t('agentDetail.tabTools') },
                { key: 'coverage', label: t('agentDetail.tabCoverage') },
                { key: 'breaker', label: t('agentDetail.tabBreaker') },
            ]}
            activeTab={tab}
            onTabChange={setTab}
        >
            {tab === 'overview' && <OverviewTab {...props} onChanged={refresh} />}
            {tab === 'risk' && <RiskAssessmentTab {...props} onChanged={refresh} />}
            {tab === 'policy' && <PolicyCardTab {...props} onChanged={refresh} />}
            {tab === 'tools' && <ToolsTab {...props} onChanged={refresh} />}
            {tab === 'coverage' && <CoverageTab {...props} />}
            {tab === 'breaker' && <CircuitBreakerTab {...props} onChanged={refresh} />}
        </EntityDetailLayout>
    );
}
