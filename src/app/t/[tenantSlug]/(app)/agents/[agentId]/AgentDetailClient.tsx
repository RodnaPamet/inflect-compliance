'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { MetaStrip, type MetaItem } from '@/components/ui/meta-strip';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { ServicePrincipalLinkCard } from './tabs/ServicePrincipalLinkCard';
import { OwnershipTransferCard } from './tabs/OwnershipTransferCard';
import { OverviewTab } from './tabs/OverviewTab';
import { RiskAssessmentTab } from './tabs/RiskAssessmentTab';
import { PolicyCardTab } from './tabs/PolicyCardTab';
import { ToolsTab } from './tabs/ToolsTab';
import { CoverageTab } from './tabs/CoverageTab';
import { SkillsTab } from './tabs/SkillsTab';
import { BehaviourTab } from './tabs/BehaviourTab';
import { RunsTab } from './tabs/RunsTab';
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
    /** Whether the tenant enforces registration — the stop comparison needs it. */
    registrationEnforced: boolean;
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
    /**
     * `admin.agent_registry` — the key the risk, skills, coverage and breaker
     * tabs and the tool-manifest pins READ under (#3710). The page itself needs
     * only the inventory read, so a reader holding the view key alone opens the
     * page and finds those tabs disabled.
     */
    canReadRegistry: boolean;
    /** `admin.agent_registry` AND the role-tier write — status moves and amendment. */
    canManageRegistry: boolean;
    /** `admin.agent_policy_card` — gates the policy-card GET, not only its writes. */
    canEditPolicyCard: boolean;
    /** `admin.agent_tool_exposure` — gates the tools GET, not only its writes. */
    canGrantTools: boolean;
    /** `admin.agent_kill_switch` — engage and lift, independently grantable. */
    canKill: boolean;
    /** `admin.agent_registry` AND the role-tier admin check the usecase asserts. */
    canCloseBreaker: boolean;
    /**
     * `admin.agent_skill_review` (#3680) — authoring and review of the
     * WORKSPACE's own skills on the Skills tab. The repository corpus is
     * read-only regardless. Optional so a caller that predates it renders the
     * tab read-only.
     */
    canReviewSkills?: boolean;
    /** `admin.agent_skill_author` (#3778) — authoring the workspace's own skills. */
    canAuthorSkills?: boolean;
    /**
     * `admin.agent_ownership` AND the role-tier read — the routes' key and
     * the floor `assertCanTransferAgentOwnership` asserts (#3807). Optional so
     * a caller that predates it renders no transfer card.
     */
    canTransferOwnership?: boolean;
    /**
     * `admin.view` OR `admin.agent_registry_view` (`mayReadAgentActivity`) —
     * the gate `GET /agent-runs` takes, which the Runs tab reads. Narrower than
     * the page's own inventory read for exactly one principal: a custom role
     * holding the register key with neither of these. That reader finds the tab
     * disabled rather than opened and refused. Optional, and only `false`
     * disables it, so a caller that predates it renders the tab as before.
     */
    canReadRuns?: boolean;
}

// `skills` is the SEVENTH key and `runs` the EIGHTH. The integration plan said
// eight before either existed, because it counted the tool-manifest pins as
// their own tab; they render inside Tools (#3470, finding F11). So the count
// matching is a coincidence and this comment is here to stop the next reader
// concluding the plan's list was satisfied.
//
// `runs` is LAST-BUT-ONE deliberately: it sits after the tabs that describe
// what the agent MAY do and before the breaker, because it is the record of
// what it DID — the order a reviewer reads the page in (#3472).
//
// `behaviour` (Step 1b, #4144) sits after `skills`: what the agent should DO,
// written in terms of the tools and skills the two tabs before it govern. It is
// in the list only while AGENT_PROFILES is on (`profilesEnabled`).
const TAB_KEYS = [
    'overview', 'risk', 'policy', 'tools', 'skills', 'behaviour', 'coverage', 'runs', 'breaker',
] as const;
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
    viewerUserId,
    profilesEnabled = false,
}: {
    tenantSlug: string;
    agent: AgentSummary;
    perms: AgentDetailPermissions;
    owners: OwnerChoice[];
    vendors: VendorChoice[];
    /** The signed-in person; the transfer card says which side of an open transfer they are on. */
    viewerUserId?: string;
    /**
     * `AGENT_PROFILES`, read on the server (Step 1b, #4144). With it off there
     * is no Behaviour tab at all, as the profile routes answer 404.
     */
    profilesEnabled?: boolean;
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
            // A provisional UNCLASSIFIED entry reads as no classification.
            value:
                agent.aiActRiskTier && agent.aiActRiskTier !== 'UNCLASSIFIED'
                    ? agent.aiActRiskTier
                    : t('agentDetail.unclassified'),
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
                        registrationEnforced={agent.registrationEnforced}
                    />
                </>
            }
            tabs={[
                { key: 'overview', label: t('agentDetail.tabOverview') },
                // Disabled without the register key (#3710), like the policy
                // card without its own: the tab's GET is gated on that key, so a
                // view-key reader would open it and be refused on the read.
                { key: 'risk', label: t('agentDetail.tabRisk'), disabled: !perms.canReadRegistry },
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
                // grants section internally instead. Disabled only when the
                // reader holds NEITHER key (#3710): a view-key reader can read
                // neither the pins nor the grants.
                {
                    key: 'tools',
                    label: t('agentDetail.tabTools'),
                    disabled: !perms.canReadRegistry && !perms.canGrantTools,
                },
                { key: 'skills', label: t('agentDetail.tabSkills'), disabled: !perms.canReadRegistry },
                // The profile read and every act take the register key, so a
                // view-key reader finds the tab disabled, like Skills.
                ...(profilesEnabled
                    ? [{ key: 'behaviour' as const, label: t('agentDetail.tabBehaviour'), disabled: !perms.canReadRegistry }]
                    : []),
                { key: 'coverage', label: t('agentDetail.tabCoverage'), disabled: !perms.canReadRegistry },
                // The runs read is `/agent-runs`, which the view key reads
                // (#3710) — this agent's runs are part of what an auditor reads
                // about it. Disabled only for a reader the route refuses: one
                // holding the register key and neither `admin.view` nor the
                // view key (`canReadRuns`).
                { key: 'runs', label: t('agentDetail.tabRuns'), disabled: perms.canReadRuns === false },
                { key: 'breaker', label: t('agentDetail.tabBreaker'), disabled: !perms.canReadRegistry },
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
                <>
                    <OverviewTab
                        {...props}
                        onChanged={refresh}
                        canManageRegistry={perms.canManageRegistry}
                    />
                    {/* The register key, which the link route takes for its
                        read and its confirm alike (#3807). */}
                    {perms.canReadRegistry && <ServicePrincipalLinkCard {...props} />}
                    {perms.canTransferOwnership && viewerUserId && (
                        <OwnershipTransferCard
                            {...props}
                            onChanged={refresh}
                            viewerUserId={viewerUserId}
                            owners={owners}
                            retired={agent.status === 'RETIRED'}
                        />
                    )}
                </>
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
            {tab === 'skills' && <SkillsTab
                    {...props}
                    canReviewSkills={perms.canReviewSkills === true}
                    canAuthorSkills={perms.canAuthorSkills === true}
                />}
            {tab === 'behaviour' && profilesEnabled && (
                <BehaviourTab
                    {...props}
                    retired={agent.status === 'RETIRED'}
                    // A started Test run is shown where the agent's runs are,
                    // re-read so it is listed (Step 2c).
                    onOpenRuns={() => {
                        refresh();
                        setTab('runs');
                    }}
                />
            )}
            {tab === 'coverage' && <CoverageTab {...props} />}
            {/* Read-only, and no `onChanged`: resuming or aborting a run
                happens on the run itself, where the steps are. */}
            {tab === 'runs' && <RunsTab {...props} />}
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
