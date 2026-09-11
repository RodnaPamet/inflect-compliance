'use client';

/**
 * The agent register.
 *
 * One row per autonomous agent the tenant runs, showing the four properties
 * that decide how much authority it may hold. Two things about the columns are
 * deliberate and easy to get wrong:
 *
 *   • "Authority tier" and "AI Act" are DIFFERENT taxonomies and sit in
 *     separate columns. One is the agent's operational authority, the other is
 *     the Regulation's classification of the AI system it belongs to. A LOW
 *     agent inside a HIGH AI system is an ordinary combination, and merging the
 *     two columns would make that look like a contradiction.
 *
 *   • An unscored tier renders as "Unscored", never as a dash and never as a
 *     low tier. NULL means nobody has assessed this agent, and the whole
 *     register exists because that is the state you most want to see.
 *
 * ── WHAT CHANGED WHEN THIS BECAME A STANDARD LIST PAGE (AGENTIC UI 1/4) ─────
 *
 * `/agents`, a sidebar destination beside `/policies` and `/vendors`, and the
 * conventions of that shape apply rather than the conventions of an admin leaf:
 *
 *   • NO `back` affordance. A MAIN page has no parent within the tenant, and
 *     `page-segregation.ts` forbids one here.
 *   • The rows and the four KPI numbers both come from the SERVER, filtered by
 *     the same predicate builder. NOTHING on this page filters an array
 *     (#2432).
 *   • `selectionEnabled: false`. There are no batch actions on the register, so
 *     the select column was a control that did nothing AND it stole the single
 *     click — the row's own action silently needed a DOUBLE click (#2434).
 *   • The primary action is `icon={<Plus />}` + the bare noun, in the toolbar
 *     leading slot where every other list page's create button lives.
 *   • Secondary navigation folds into ONE labelled "Views ▾" menu (#2436); the
 *     gears stay outside it and one rung smaller, per the rule recorded at the
 *     ControlsClient call site.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { Robot } from '@/components/ui/icons/nucleo';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { useFilterCardVisibility, type CardDefinition } from '@/components/ui/filter';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { InfoTooltip } from '@/components/ui/tooltip';
import type { AgentKpiCounts } from '@/app-layer/repositories/RegisteredAgentRepository';
import { AgentsViewsMenu } from './AgentsViewsMenu';
import { buildAgentFilters, AGENT_FILTER_KEYS } from './filter-defs';
import { NewAgentModal, type OwnerOption, type VendorOption } from './NewAgentModal';

export interface AgentRow {
    id: string;
    name: string;
    status: string;
    autonomyLevel: number;
    dataAccessScope: string;
    reversibility: string;
    provenance: string;
    riskTier: string | null;
    isLegacyPlaceholder: boolean;
    /**
     * The accountable human. `RegisteredAgent.ownerUserId` is NOT NULL behind a
     * real FK, so a register row always HAS one; `name` is the nullable half
     * and `email` is what the column falls back to when nobody set a display
     * name. Both are read — see the Agent column's cell.
     */
    owner: { id: string; name: string | null; email: string | null } | null;
    aiSystem: { id: string; riskTier: string; classificationClauseId: string | null } | null;
    _count: { apiKeys: number };
}

interface Props {
    initialRows: AgentRow[];
    tenantSlug: string;
    owners: OwnerOption[];
    vendors: VendorOption[];
    /** Server aggregates — see `RegisteredAgentRepository.kpiCounts`. */
    kpiCounts: AgentKpiCounts;
    /** The three-state governance banner's inputs. */
    governance: { enforcing: boolean; unboundCredentials: number };
    /**
     * The three assurance signals (#2451) — is any of this being CHECKED?
     * `null` when the reader may see the register but not the audit trail; the
     * panel is then absent rather than zeroed, because a zero would answer a
     * question nobody was allowed to ask.
     */
    assurance: AgenticAssurance | null;
    /** Badge count for the Proposals menu entry; `null` when unreadable. */
    proposalsAwaitingReview: number | null;
    canWrite: boolean;
    /** `admin.view` — the key the proposals and runs pages gate on. */
    canReviewProposals: boolean;
}

/** Where an agent sits in its lifecycle. Only ACTIVE reaches the agent surface. */
const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    ACTIVE: 'success',
    SUSPENDED: 'warning',
    RETIRED: 'neutral',
};

/** Operational authority. UNSCORED is rendered separately — it is not a tier. */
const TIER_VARIANT: Record<string, StatusBadgeVariant> = {
    LOW: 'neutral',
    MODERATE: 'info',
    HIGH: 'warning',
    CRITICAL: 'error',
};

/** The Regulation's classification of the AI system the agent belongs to. */
const AI_ACT_VARIANT: Record<string, StatusBadgeVariant> = {
    PROHIBITED: 'error',
    HIGH: 'error',
    LIMITED: 'warning',
    MINIMAL: 'neutral',
};

const AUTONOMY_MAX = 6;

/**
 * The four KPI ids, and the ONLY four.
 *
 * A union rather than `string`, so the card-config record below cannot silently
 * acquire a fifth entry whose filter nobody wrote — and so a rename is a
 * compile error in both the card and its click.
 */
type AgentKpiId = 'total' | 'active' | 'unscored' | 'egress';

export function AgentsClient(props: Props) {
    const t = useTranslations('agents');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildAgentFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...AGENT_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <AgentsInner {...props} />
        </FilterProvider>
    );
}

function AgentsInner({
    initialRows,
    tenantSlug,
    owners,
    vendors,
    kpiCounts,
    governance,
    assurance,
    proposalsAwaitingReview,
    canWrite,
    canReviewProposals,
}: Props) {
    const router = useRouter();
    const t = useTranslations('agents');
    // `admin.agentDetail.*` stayed in the admin namespace when the register's
    // own copy moved to `agents.register.*` (#2426) — the detail page's ~90
    // keys are a separate move. This page reaches across for exactly ONE of
    // them; see the Agent column's cell for why that sharing is deliberate.
    const tAdmin = useTranslations('admin');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () =>
            buildAgentFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const { state, hasActive, set, clearAll } = useFilters();
    const [showNew, setShowNew] = useState(false);
    const tenantHref = useCallback((path: string) => `/t/${tenantSlug}${path}`, [tenantSlug]);

    // The rows arrive FILTERED. Nothing here narrows them — see the module
    // header and `AgentListFilters`.
    const rows = initialRows;

    // ── KPI strip ───────────────────────────────────────────────────────────
    //
    // Every card registered under this key is `kind: 'kpi'`, deliberately: the
    // visibility hook's stale-data migration only fires when ALL persisted ids
    // are dead, so a mixed registration would leave anyone who ever touched the
    // gear with the new cards hidden.
    const kpiCards: CardDefinition[] = useMemo(
        () => [
            { id: 'total', label: t('register.kpi.total'), kind: 'kpi' },
            { id: 'active', label: t('register.kpi.active'), kind: 'kpi' },
            { id: 'unscored', label: t('register.kpi.unscored'), kind: 'kpi' },
            { id: 'egress', label: t('register.kpi.egress'), kind: 'kpi' },
        ],
        [t],
    );
    const { visibleCards: visibleKpiCards, dropdown: filtersDropdown } =
        useFilterCardVisibility({
            storageKey: 'inflect:filter-vis:agents',
            cards: kpiCards,
        });

    /**
     * The card CLICKS, one per server count, in the same order and with the
     * same term swapped.
     *
     * `set` REPLACES the key's value, which is the move
     * `RegisteredAgentRepository.kpiCounts` counts for. `total` calls
     * `clearAll()` because its number is the unfiltered tenant.
     */
    const applyKpi = useCallback(
        (id: AgentKpiId) => {
            switch (id) {
                case 'total':
                    clearAll();
                    return;
                case 'active':
                    set('status', 'ACTIVE');
                    return;
                case 'unscored':
                    set('riskTier', 'UNSCORED');
                    return;
                case 'egress':
                    set('dataAccessScope', 'EXTERNAL_EGRESS');
                    return;
            }
        },
        [set, clearAll],
    );

    /** Whether a card's own filter is the one currently applied. */
    const kpiSelected = useCallback(
        (id: AgentKpiId): boolean => {
            const one = (key: string, value: string) => {
                const got = (state[key] ?? []) as string[];
                return got.length === 1 && got[0] === value;
            };
            switch (id) {
                case 'total':
                    return !hasActive;
                case 'active':
                    return one('status', 'ACTIVE');
                case 'unscored':
                    return one('riskTier', 'UNSCORED');
                case 'egress':
                    return one('dataAccessScope', 'EXTERNAL_EGRESS');
            }
        },
        [state, hasActive],
    );

    const columns = useMemo(
        () =>
            createColumns<AgentRow>([
                {
                    id: 'name',
                    header: t('register.colAgent'),
                    accessorFn: (r) => r.name,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`agent-row-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">
                                {row.original.name}
                            </div>
                            {/* Name, then EMAIL, then "Name not recorded" —
                                never "Unassigned". `ownerUserId` is NOT NULL
                                behind a real FK (the schema calls it "the
                                accountable human", and the two-person rule
                                downstream compares it); only `User.name` is
                                nullable. So the fallback is reachable ONLY for
                                an owner who is on record with no display name,
                                and the register — the surface whose whole job
                                is to answer "who is accountable for this
                                agent" — was answering "nobody" about somebody
                                the database is holding. The email rung comes
                                first because an address is something a reader
                                can act on.

                                The last rung reaches across to the DETAIL
                                page's own key rather than minting a second
                                string for the register, and that is
                                deliberate: the two surfaces answer one
                                question about one agent, and #2380 was them
                                answering it differently. One key is the only
                                arrangement in which they cannot drift apart
                                again. It is read through `tAdmin` because
                                `admin.agentDetail.*` did not move with the
                                register's own copy (#2426).
                                `register.noOwner` — "Unassigned" — is what
                                this rendered before, and nothing should render
                                it again. */}
                            <div className="truncate text-xs text-content-subtle">
                                {row.original.isLegacyPlaceholder
                                    ? t('register.legacyPlaceholder')
                                    : (row.original.owner?.name ??
                                       row.original.owner?.email ??
                                       tAdmin('agentDetail.overview.ownerEmpty'))}
                            </div>
                        </div>
                    ),
                },
                {
                    id: 'status',
                    header: t('register.colStatus'),
                    accessorFn: (r) => r.status,
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>
                            {t(`register.filterEnums.status.${row.original.status}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'autonomy',
                    header: t('register.colAutonomy'),
                    accessorFn: (r) => r.autonomyLevel,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {t('register.autonomyOf', {
                                level: row.original.autonomyLevel,
                                max: AUTONOMY_MAX,
                            })}
                        </span>
                    ),
                },
                {
                    id: 'dataAccessScope',
                    header: t('register.colAccess'),
                    accessorFn: (r) => r.dataAccessScope,
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {t(`register.filterEnums.accessScope.${row.original.dataAccessScope}`)}
                        </span>
                    ),
                },
                {
                    id: 'reversibility',
                    header: t('register.colReversibility'),
                    accessorFn: (r) => r.reversibility,
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {t(`register.reversibility.${row.original.reversibility}`)}
                        </span>
                    ),
                },
                {
                    id: 'riskTier',
                    header: t('register.colTier'),
                    accessorFn: (r) => r.riskTier ?? '',
                    cell: ({ row }) =>
                        row.original.riskTier ? (
                            <StatusBadge variant={TIER_VARIANT[row.original.riskTier] ?? 'neutral'}>
                                {row.original.riskTier}
                            </StatusBadge>
                        ) : (
                            // Not a dash. NULL means nobody has assessed this
                            // agent, and every consumer reads that as deny.
                            <span className="inline-flex items-center gap-tight text-content-subtle">
                                {t('register.unscored')}
                                <InfoTooltip content={t('register.unscoredHint')} />
                            </span>
                        ),
                },
                {
                    id: 'aiAct',
                    header: t('register.colAiAct'),
                    accessorFn: (r) => r.aiSystem?.riskTier ?? '',
                    cell: ({ row }) =>
                        row.original.aiSystem ? (
                            <span className="inline-flex items-center gap-tight">
                                <StatusBadge
                                    variant={AI_ACT_VARIANT[row.original.aiSystem.riskTier] ?? 'neutral'}
                                >
                                    {row.original.aiSystem.riskTier}
                                </StatusBadge>
                                <span className="tabular-nums text-xs text-content-subtle">
                                    {row.original.aiSystem.classificationClauseId ?? ''}
                                </span>
                            </span>
                        ) : null,
                },
                {
                    id: 'keys',
                    header: t('register.colKeys'),
                    accessorFn: (r) => r._count.apiKeys,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {row.original._count.apiKeys}
                        </span>
                    ),
                },
            ]),
        [t, tAdmin],
    );

    // Stable table-model identities — a fresh identity here rebuilds the table
    // model mid-click and kills row interaction (#1678).
    const getAgentRowId = useCallback((r: AgentRow) => r.id, []);

    // The register's only route to the detail page. Without it that page is
    // reachable by typing the URL and by nothing else, so every per-agent
    // surface it hosts (the policy card, the tool pins, the ASI coverage, the
    // circuit breaker, the kill switch) stays as unreachable as it was before
    // the page existed. `onRowClick` is also what makes DataTable mount its
    // trailing chevron column, so the row ADVERTISES that it opens — and with
    // `selectionEnabled: false` below, ONE click is what opens it.
    const handleAgentRowClick = useCallback(
        (row: { original: AgentRow }) =>
            router.push(`/t/${tenantSlug}/agents/${row.original.id}`),
        [router, tenantSlug],
    );

    return (
        <>
            <EntityListPage<AgentRow>
                header={{
                    // No `back`. `/agents` is a MAIN page — see the module
                    // header.
                    breadcrumbs: [
                        { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('register.breadcrumb') },
                    ],
                    title: (
                        <>
                            <Robot className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                            {t('register.title')}
                        </>
                    ),
                    description: t('register.listDescription'),
                }}
                banner={
                    <div className="space-y-compact">
                        <GovernanceBanner governance={governance} />
                        {assurance && <AssurancePanel assurance={assurance} />}
                    </div>
                }
                kpis={
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                        {visibleKpiCards.map((card) => {
                            const id = card.id as AgentKpiId;
                            const cfg: Record<
                                AgentKpiId,
                                { value: number; tone?: 'default' | 'attention' | 'critical' }
                            > = {
                                total: { value: kpiCounts.total },
                                active: { value: kpiCounts.active },
                                // An unscored agent must not be running, so the
                                // card is loud when it is non-zero and quiet
                                // when it is not. It is never "success" — zero
                                // unscored agents is the ordinary state, not an
                                // achievement.
                                unscored: {
                                    value: kpiCounts.unscored,
                                    tone: kpiCounts.unscored > 0 ? 'critical' : 'default',
                                },
                                egress: {
                                    value: kpiCounts.egress,
                                    tone: kpiCounts.egress > 0 ? 'attention' : 'default',
                                },
                            };
                            const c = cfg[id];
                            if (!c) return null;
                            return (
                                <KpiFilterCard
                                    key={card.id}
                                    // `id` lands on the VALUE span (E2E
                                    // selectors read the number); the
                                    // `data-testid` is the CARD wrapper, which
                                    // is what a rendered test has to scope to
                                    // in order to read a label and its number
                                    // together.
                                    id={`agents-kpi-${card.id}`}
                                    data-testid={`agents-kpi-card-${card.id}`}
                                    label={card.label}
                                    value={c.value}
                                    tone={c.tone}
                                    onClick={() => applyKpi(id)}
                                    selected={kpiSelected(id)}
                                />
                            );
                        })}
                    </div>
                }
                filters={{
                    defs: filterDefs,
                    // Search lives INSIDE the filter dropdown — the toolbar's
                    // own contract. There is no separate search bar on any list
                    // page (`r14-no-page-searchbars`).
                    searchId: 'agents-search',
                    searchPlaceholder: t('register.searchPlaceholder'),
                    toolbarLeading: canWrite ? (
                        <Button
                            variant="primary"
                            icon={<Plus />}
                            id="new-agent-btn"
                            onClick={() => setShowNew(true)}
                        >
                            {t('register.addAgent')}
                        </Button>
                    ) : undefined,
                    // The secondary navigation folds into ONE labelled
                    // "Views ▾" menu; the gears stay OUTSIDE it and one rung
                    // smaller — they are table chrome, not views.
                    toolbarActions: (
                        <>
                            <AgentsViewsMenu
                                current="register"
                                tenantSlug={tenantSlug}
                                canReviewProposals={canReviewProposals}
                                // `canWrite` IS `admin.agent_registry` — the
                                // same key the three assurance surfaces gate
                                // themselves on. Named for what it gates here.
                                canInvestigate={canWrite}
                                proposalsAwaitingReview={proposalsAwaitingReview}
                            />
                            {filtersDropdown}
                        </>
                    ),
                }}
                table={{
                    'data-testid': 'agents-table',
                    data: rows,
                    columns,
                    getRowId: getAgentRowId,
                    onRowClick: handleAgentRowClick,
                    // No batch actions exist on the register, so the select
                    // column was a checkbox that did nothing AND it took the
                    // single click away from the row's real action (#2434).
                    selectionEnabled: false,
                    resourceName: (plural) =>
                        plural
                            ? t('register.resourcePlural')
                            : t('register.resourceSingular'),
                    emptyState: (
                        <EmptyState
                            icon={Robot}
                            title={
                                hasActive
                                    ? t('register.emptyMatchingTitle')
                                    : t('register.emptyTitle')
                            }
                            description={
                                hasActive
                                    ? t('register.emptyMatchingDesc')
                                    : t('register.emptyDesc')
                            }
                        />
                    ),
                }}
            />
            {showNew && (
                <NewAgentModal
                    tenantSlug={tenantSlug}
                    owners={owners}
                    vendors={vendors}
                    onClose={() => setShowNew(false)}
                    onCreated={() => {
                        setShowNew(false);
                        router.refresh();
                    }}
                />
            )}
        </>
    );
}

/**
 * THE GOVERNANCE STATUS BANNER — three states, one sentence each (#2431).
 *
 * The register's central claim is printed in its own description: "an agent must
 * be ACTIVE here before a credential bound to it may use the agent surface".
 * That claim is CONDITIONAL on `TenantSecuritySettings.requireRegisteredAgent`,
 * and a page that shows the rows without saying so is a page whose headline
 * sentence may be false for the tenant reading it.
 *
 *   NOT ENFORCING      → warning. Every row here is a record and nothing more:
 *                        suspending an agent records the state and stops
 *                        nothing. This is the loudest of the three because it
 *                        is the one where the operator's mental model is wrong.
 *   ENFORCING, N UNBOUND → warning, with N. The gate is on and N live MCP
 *                        credentials name no agent, so each is refused at
 *                        `/api/mcp` with `no_agent_binding`. It presents as an
 *                        integration that stopped working for no visible
 *                        reason, and the fix is on this page.
 *   ENFORCING          → info. On, nothing unbound, nothing to do.
 *
 * All three RENDER. An "everything is fine" state that renders nothing leaves
 * the reader unable to tell "enforcing" from "this page does not say".
 */
/** The three assurance signals, as the register renders them. */
export interface AgenticAssurance {
    riskCoverage: { scored: number; total: number };
    sampleAudit: { answered: number; dissented: number; disagreementRate: number | null };
    controlTests: Array<{ checkId: string; title: string; result: string | null; lastRunAt: string | Date | null }>;
}

/**
 * IS ANY OF THIS BEING CHECKED?
 *
 * The banner above says whether the boundary is switched on. This says whether
 * anybody is verifying that it works — the question an assessor asks and the one
 * the register could not previously answer at all.
 *
 * A check that has NEVER RUN renders as "never run", never as absent. Omission
 * reads as a pass, and "no result" and "passed" are the two things an assurance
 * surface must never conflate.
 */
export function AssurancePanel({ assurance }: { assurance: AgenticAssurance }) {
    const t = useTranslations('agents');
    const { riskCoverage: rc, sampleAudit: sa, controlTests } = assurance;
    const unscored = rc.total - rc.scored;

    return (
        <div className="space-y-tight text-sm" data-testid="agents-assurance">
            <p className="text-xs uppercase tracking-wide text-content-subtle">
                {t('register.assurance.heading')}
            </p>

            <p data-testid="agents-assurance-coverage">
                {rc.total === 0
                    ? t('register.assurance.coverageEmpty')
                    : unscored === 0
                      ? t('register.assurance.coverageComplete', { total: rc.total })
                      : t('register.assurance.coveragePartial', { scored: rc.scored, total: rc.total, unscored })}
            </p>

            <p data-testid="agents-assurance-sample">
                {sa.disagreementRate === null
                    ? t('register.assurance.sampleNone')
                    : t('register.assurance.sampleRate', {
                          percent: Math.round(sa.disagreementRate * 100),
                          dissented: sa.dissented,
                          answered: sa.answered,
                      })}
            </p>

            <ul className="space-y-tight" data-testid="agents-assurance-checks">
                {controlTests.map((c) => (
                    <li key={c.checkId}>
                        <span className="text-content-default">{c.title}</span>{' '}
                        {c.result === null ? (
                            <span className="text-content-warning">
                                {t('register.assurance.checkNeverRun')}
                            </span>
                        ) : (
                            <span
                                className={
                                    c.result === 'PASS' ? 'text-content-success' : 'text-content-error'
                                }
                            >
                                {c.result}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function GovernanceBanner({
    governance,
}: {
    governance: { enforcing: boolean; unboundCredentials: number };
}) {
    const t = useTranslations('agents');
    if (!governance.enforcing) {
        return (
            <InlineNotice variant="warning" data-testid="agents-governance-banner">
                {t('register.governance.notEnforcing')}
            </InlineNotice>
        );
    }
    if (governance.unboundCredentials > 0) {
        return (
            <InlineNotice variant="warning" data-testid="agents-governance-banner">
                {t('register.governance.enforcingUnbound', {
                    count: governance.unboundCredentials,
                })}
            </InlineNotice>
        );
    }
    return (
        <InlineNotice variant="info" data-testid="agents-governance-banner">
            {t('register.governance.enforcing')}
        </InlineNotice>
    );
}
