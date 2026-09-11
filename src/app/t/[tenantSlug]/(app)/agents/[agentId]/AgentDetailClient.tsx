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
import { AgentKillSwitchAction, AgentKillSwitchBanner } from './AgentKillSwitchAction';
import { AgentAmendModal } from './AgentAmendModal';
import { Button } from '@/components/ui/button';

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
    /**
     * The amendable fields the header strip does not render (#2447). Present so
     * the amend form opens on the agent's REAL values: a form that starts blank
     * silently proposes clearing every field it does not show.
     */
    description: string | null;
    modelRef: string | null;
    ownerUserId: string;
    vendorId: string | null;
}

/** A member who may own an agent — ACTIVE-only, as the usecase requires. */
export interface OwnerChoice {
    id: string;
    label: string;
}

/** A supplier this agent may be attributed to. */
export interface VendorChoice {
    id: string;
    name: string;
}

/**
 * Resolved on the server, because the shell decides which tabs are reachable
 * before any tab mounts. See `page.tsx` for why `canCloseBreaker` is the one
 * flag that is a conjunction.
 */
export interface AgentDetailPermissions {
    /** `admin.agent_registry` — status moves, risk assessment, coverage, breaker reads. */
    canManageRegistry: boolean;
    /** `admin.agent_policy_card` — gates the policy-card GET, not only its writes. */
    canEditPolicyCard: boolean;
    /** `admin.agent_tool_exposure` — gates the tools GET, not only its writes. */
    canGrantTools: boolean;
    /** `admin.agent_kill_switch` — engage and lift, independently grantable. */
    canKill: boolean;
    /** `admin.agent_registry` AND the role-tier admin check the usecase asserts. */
    canCloseBreaker: boolean;
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
    perms,
    owners,
    vendors,
}: {
    tenantSlug: string;
    agent: AgentSummary;
    perms: AgentDetailPermissions;
    owners: OwnerChoice[];
    vendors: VendorChoice[];
}) {
    const t = useTranslations('admin');
    // The register's copy lives in the top-level `agents` namespace now that
    // the subtree is no longer under `/admin` (#2426); `admin.agentDetail.*`
    // — this page's own ~90 keys — deliberately stayed put, so the page reads
    // both. See the note on the breadcrumb trail below.
    const tAgents = useTranslations('agents');
    const [tab, setTab] = useState<TabKey>('overview');
    const [refreshToken, setRefreshToken] = useState(0);
    const [amending, setAmending] = useState(false);

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
            // `/agents` — the static link this replaced.
            back={{ smart: true }}
            // AGENTIC UI 1/4 (#2422): the register is a top-level sidebar
            // destination now, so the ADMIN rung is gone from this trail. It
            // was never a structural parent of an agent — it was where the
            // page happened to live.
            breadcrumbs={[
                { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: tAgents('register.breadcrumb'), href: `/t/${tenantSlug}/agents` },
                { label: agent.name },
            ]}
            title={
                <span className="flex items-center gap-default">
                    {agent.name}
                    <StatusBadge variant={statusVariant(agent.status)}>{agent.status}</StatusBadge>
                </span>
            }
            meta={<MetaStrip items={meta} />}
            actions={
                <>
                    {/* AMEND (#2447). Beside the kill switch because they are
                        the two things an operator reaches for about an agent
                        rather than about one of its tabs — and because autonomy
                        lives in here, which is the dial somebody turns DOWN in
                        the same minute they consider stopping it. */}
                    {perms.canManageRegistry && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setAmending(true)}
                            data-testid="agent-amend-action"
                            text={t('agentDetail.amend.action')}
                        />
                    )}
                    <AgentKillSwitchAction
                        agentId={agent.id}
                        canKill={perms.canKill}
                        refreshToken={refreshToken}
                        tenantSlug={tenantSlug}
                    />
                </>
            }
            tabs={[
                { key: 'overview', label: t('agentDetail.tabOverview') },
                { key: 'risk', label: t('agentDetail.tabRisk') },
                // Disabled, not hidden. The two narrow keys gate the GET as
                // well as the write, so a holder of the register key alone
                // opens either tab and is refused on the read. A greyed tab
                // says the surface exists and is not yours; a missing one says
                // the product does not have it.
                {
                    key: 'policy',
                    label: t('agentDetail.tabPolicy'),
                    disabled: !perms.canEditPolicyCard,
                },
                // NOT disabled on `canGrantTools`, unlike the policy card.
                // This tab hosts TWO independently-gated resources: the
                // per-agent grants (admin.agent_tool_exposure) and the
                // tenant-wide manifest pins, which have no rule of their own
                // and fall to the admin.agent_registry catch-all the page has
                // already required. Disabling the tab on the narrower key hid
                // the supply-chain pins — the ASI04 tool-poisoning surface —
                // from an operator entitled to read them. The tab gates the
                // grants section internally instead.
                { key: 'tools', label: t('agentDetail.tabTools') },
                { key: 'coverage', label: t('agentDetail.tabCoverage') },
                { key: 'breaker', label: t('agentDetail.tabBreaker') },
            ]}
            activeTab={tab}
            onTabChange={setTab}
        >
            {/* Outside the tab switch: a kill in force stops this agent on
                every surface, so it is not the property of whichever tab
                happens to be open. The layout has no slot above the panel, so
                this is the highest place it can go. */}
            <AgentKillSwitchBanner
                agentId={agent.id}
                canKill={perms.canKill}
                refreshToken={refreshToken}
            />
            {tab === 'overview' && (
                <OverviewTab
                    {...props}
                    onChanged={refresh}
                    canManageRegistry={perms.canManageRegistry}
                />
            )}
            {tab === 'risk' && (
                <RiskAssessmentTab
                    {...props}
                    onChanged={refresh}
                    canManageRegistry={perms.canManageRegistry}
                />
            )}
            {tab === 'policy' && (
                <PolicyCardTab
                    {...props}
                    onChanged={refresh}
                    canEditPolicyCard={perms.canEditPolicyCard}
                />
            )}
            {tab === 'tools' && (
                <ToolsTab {...props} onChanged={refresh} canGrantTools={perms.canGrantTools} />
            )}
            {tab === 'coverage' && <CoverageTab {...props} />}
            {tab === 'breaker' && (
                <CircuitBreakerTab
                    {...props}
                    onChanged={refresh}
                    canCloseBreaker={perms.canCloseBreaker}
                />
            )}
            {amending && (
                <AgentAmendModal
                    agent={agent}
                    owners={owners}
                    vendors={vendors}
                    onClose={() => setAmending(false)}
                    // The whole shell re-reads rather than this header alone:
                    // an amend can change autonomy and provenance, which the
                    // risk and coverage tabs both derive from.
                    onAmended={refresh}
                />
            )}
        </EntityDetailLayout>
    );
}
