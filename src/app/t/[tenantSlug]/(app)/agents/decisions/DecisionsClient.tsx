'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { cardVariants } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { cn } from '@inflect/ui/lib/cn';
import { formatDateTime } from '@inflect/ui/lib/format-date';

import { AgentsViewsMenu } from '../AgentsViewsMenu';

export interface DecisionRow {
    id: string;
    feature: string;
    provider: string;
    model: string | null;
    inputDigest: string;
    outputSummary: string | null;
    guardVerdict: string | null;
    humanOutcome: string;
    tokensIn: number | null;
    tokensOut: number | null;
    latencyMs: number | null;
    createdAt: string;
    /** The run the row came from, for a run's rows. Optional for a caller that predates it. */
    runId?: string | null;
    agentId?: string | null;
}

/** The page's narrowing, echoed from the URL (#4896). */
export interface DecisionFilters {
    outcome: 'PENDING' | 'REVIEWED' | 'AUTONOMOUS' | null;
    kind: string | null;
    agentId: string | null;
}

const KINDS = ['assistant', 'run', 'tool', 'proposal', 'automatic', 'risk', 'matching'] as const;

/**
 * What KIND of call a row records, from its feature (#4896). A run's feature
 * carries its workflow key after the prefix; an unknown feature has no kind.
 */
function kindOf(feature: string): (typeof KINDS)[number] | null {
    if (feature.startsWith('agentic-run:')) return 'run';
    switch (feature) {
        case 'assistant':
            return 'assistant';
        case 'agentic-tool:external':
            return 'tool';
        case 'agent-proposal':
            return 'proposal';
        case 'external-write-automatic':
            return 'automatic';
        case 'risk-suggestions':
            return 'risk';
        case 'legacy-identity-match':
            return 'matching';
        default:
            return null;
    }
}

/**
 * The guard's verdict, from the first word of what was stored: a proposal's
 * row stores `CLEAN provenance=… rules=…`, and the legacy matcher stores its
 * verdicts in lower case.
 */
const GUARD_VERDICTS = new Set(['CLEAN', 'FLAGGED', 'QUARANTINED', 'MALICIOUS']);
function guardKey(verdict: string): string {
    const word = verdict.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    return GUARD_VERDICTS.has(word) ? word : 'OTHER';
}

/** A tool call's stored summary, in words; anything else is shown as stored. */
const TOOL_SUMMARY_KEY: Readonly<Record<string, string>> = {
    'external done': 'decisions.toolSummary.done',
    'external failed': 'decisions.toolSummary.failed',
};

/**
 * The Art 14 answer is the one with a traffic light.
 *
 * `humanOutcome` is the only column here whose value a reviewer acts on —
 * PENDING means nobody has looked yet, and that is the state an assessor asks
 * about. The guard verdict beside it is inline text for the same reason the
 * run timeline's is: one badge per row, so the badge still means something.
 *
 * ── THE FIVE VALUES, SPELLED THE WAY THE DATABASE SPELLS THEM ───────────────
 *
 * `AiHumanOutcome` is `PENDING | ACCEPTED | EDITED | REJECTED | AUTONOMOUS`,
 * and this map carried `MODIFIED` instead of `EDITED` — a value the column
 * cannot hold, and the one value it CAN hold that was missing.
 * `approveAgentProposal` passes its `'ACCEPTED' | 'EDITED'` status straight
 * through, so an edited approval has always been writable; it rendered with the
 * neutral fallback variant and a `t()` key that resolves to nothing, i.e. as
 * the dotted key path. Nothing caught it because the lookup is a template
 * literal, which `i18n-keys-resolve` states outright it cannot follow — "those
 * keys are the ones a rendered test has to cover instead", which is now what
 * covers them.
 *
 * ── WHY `AUTONOMOUS` TAKES THE FOURTH TONE AND NOT ONE OF THE THREE ─────────
 *
 * `AUTONOMOUS` is the external-write ladder's `AUTOMATIC` rung (#2861): the
 * write went out and no human was in the loop. It is NOT a review verdict, so
 * it cannot borrow one of the verdict tones — `success` would claim a review
 * passed, `error` would claim one failed, and `warning` is EDITED's, which means
 * a person DID look and changed something. Conflating "a human edited it" with
 * "no human saw it" is the same class of mistake as the MODIFIED spelling above.
 *
 * `neutral` is unavailable for a different reason: it is the `??` fallback an
 * UNKNOWN value gets, so using it would make "the map knows this value" and
 * "the map has never heard of this value" render identically — and the rendered
 * test's tone assertions would lose their only way to tell the two apart.
 *
 * `info` is the remaining tone and the honest one: a fact about the row's
 * provenance rather than a judgement on it. The LABEL carries the weight.
 */
const OUTCOME_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral' | 'info'> = {
    ACCEPTED: 'success',
    EDITED: 'warning',
    REJECTED: 'error',
    PENDING: 'neutral',
    AUTONOMOUS: 'info',
};

export function DecisionsClient({
    tenantSlug,
    decisions,
    digest,
    capped = null,
    agentNames = {},
    connectionNames = {},
    workflowNames = {},
    filters = { outcome: null, kind: null, agentId: null },
    canReviewProposals,
    canCompose,
    canInvestigate,
    oversightReads,
    canSetOrphanPass = false,
}: {
    tenantSlug: string;
    decisions: readonly DecisionRow[];
    digest: string | null;
    /** The bound, when more rows match than are shown (#4896). */
    capped?: number | null;
    agentNames?: Readonly<Record<string, string>>;
    connectionNames?: Readonly<Record<string, string>>;
    workflowNames?: Readonly<Record<string, string>>;
    filters?: DecisionFilters;
    /** `admin.view` — the proposals and runs pages' own gate. */
    canReviewProposals: boolean;
    /** `admin.view` — the compose entry's gate (#3710); defaults to `canReviewProposals`. */
    canCompose?: boolean;
    /** `admin.agent_registry` — the register key. */
    canInvestigate: boolean;
    /** Which assurance surfaces the viewer may read (`agent-oversight-settings.ts`). */
    oversightReads?: Readonly<{ decisions: boolean; receipts: boolean; quarantine: boolean }>;
    /** `admin.tenant_lifecycle` — the views menu offers Owner departures (#4903). */
    canSetOrphanPass?: boolean;
}) {
    const t = useTranslations('agents');
    const router = useRouter();
    const base = `/t/${tenantSlug}/agents/decisions`;

    /** The URL with one narrowing changed and the others kept. */
    const hrefWith = (change: Partial<{ outcome: string | null; kind: string | null; agent: string | null; digest: string | null }>) => {
        const next = {
            outcome: filters.outcome,
            kind: filters.kind,
            agent: filters.agentId,
            digest,
            ...change,
        };
        const qs = new URLSearchParams(
            Object.entries(next).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
        ).toString();
        return qs ? `${base}?${qs}` : base;
    };
    const narrowed = Boolean(digest || filters.outcome || filters.kind || filters.agentId);

    const featureLabel = (feature: string): string => {
        const kind = kindOf(feature);
        if (kind === 'run') {
            const key = feature.slice('agentic-run:'.length);
            return t('decisions.feature.run', { workflow: workflowNames[key] ?? key });
        }
        return kind ? t(`decisions.feature.${kind}`) : feature;
    };

    const providerLabel = (d: DecisionRow): string => {
        if (d.provider.startsWith('mcp:')) {
            const name = connectionNames[d.provider.slice('mcp:'.length)];
            return name ? t('decisions.toolServer', { name }) : t('decisions.toolServerUnknown');
        }
        return d.model ? `${d.provider}/${d.model}` : d.provider;
    };

    const kindOptions: ComboboxOption[] = [
        { value: '', label: t('decisions.kindAll') },
        ...KINDS.map((k) => ({ value: k, label: t(`decisions.kindFilter.${k}`) })),
    ];

    return (
        <div className="space-y-section">
            <PageHeader
                // A SUBPAGE gets a back affordance, like every sibling under
                // `/agents`. This page never had one: it was missing from
                // `page-segregation`'s lists, so the RQ4-1 completeness scan
                // classified it through the `/agents/[agentId]` wildcard and
                // the RQ4-10 sweep — which only walks listed SUBPAGES — never
                // saw it to ask.
                back={{ smart: true }}
                title={t('decisions.title')}
                description={t('decisions.description')}
                actions={
                    <AgentsViewsMenu
                        tenantSlug={tenantSlug}
                        current="decisions"
                        canReviewProposals={canReviewProposals}
                        canCompose={canCompose}
                        canInvestigate={canInvestigate}
                        oversightReads={oversightReads}
                        canSetOrphanPass={canSetOrphanPass}
                    />
                }
            />

            {/* The narrowing (#4896): what a person decided, what kind of call,
                and one agent. Links, so a narrowed view is a URL to share. */}
            <div className="flex flex-wrap items-center gap-default" data-testid="decisions-filters">
                <ToggleGroup
                    ariaLabel={t('decisions.outcomeFilterAria')}
                    options={[
                        { value: 'ALL', label: t('decisions.outcomeAll'), href: hrefWith({ outcome: null }) },
                        { value: 'PENDING', label: t('decisions.outcomeFilter.PENDING'), href: hrefWith({ outcome: 'PENDING' }) },
                        { value: 'REVIEWED', label: t('decisions.outcomeFilter.REVIEWED'), href: hrefWith({ outcome: 'REVIEWED' }) },
                        { value: 'AUTONOMOUS', label: t('decisions.outcomeFilter.AUTONOMOUS'), href: hrefWith({ outcome: 'AUTONOMOUS' }) },
                    ]}
                    selected={filters.outcome ?? 'ALL'}
                />
                <div className="w-full max-w-xs">
                    <Combobox
                        hideSearch
                        id="decisions-kind-filter"
                        options={kindOptions}
                        selected={kindOptions.find((o) => o.value === (filters.kind ?? '')) ?? null}
                        setSelected={(o) => o && router.push(hrefWith({ kind: o.value || null }))}
                        matchTriggerWidth
                        caret
                    />
                </div>
                {filters.agentId && (
                    <span className="text-sm text-content-muted" data-testid="decisions-agent-filter">
                        {t('decisions.filteredByAgent', { agent: agentNames[filters.agentId] ?? filters.agentId })}{' '}
                        <Link href={hrefWith({ agent: null })} className="text-content-info hover:underline">
                            {t('decisions.clearAgent')}
                        </Link>
                    </span>
                )}
                {narrowed && (
                    <Link href={base} className="text-sm text-content-info hover:underline" data-testid="decisions-show-all">
                        {t('decisions.showAll')}
                    </Link>
                )}
            </div>

            {/* A NARROWED view says so. Without this line a digest that matches
                nothing renders identically to a tenant that has never run a
                model — two very different facts. */}
            {digest && (
                <p className="text-sm text-content-muted">
                    {t('decisions.filteredByDigest', { digest: digest.slice(0, 12) })}
                </p>
            )}

            {capped && (
                <InlineNotice variant="info" data-testid="decisions-capped">
                    {t('decisions.capped', { count: capped })}
                </InlineNotice>
            )}

            {decisions.length === 0 ? (
                <EmptyState
                    title={
                        digest
                            ? t('decisions.emptyFilteredTitle')
                            : narrowed
                              ? t('decisions.emptyNarrowedTitle')
                              : t('decisions.emptyTitle')
                    }
                    description={
                        digest
                            ? t('decisions.emptyFilteredDesc')
                            : narrowed
                              ? t('decisions.emptyNarrowedDesc')
                              : t('decisions.emptyDesc')
                    }
                />
            ) : (
                <ol className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-subtle')}>
                    {decisions.map((d) => {
                        const kind = kindOf(d.feature);
                        // A run's rows (and its tool calls) carry the run id
                        // as their session key; that is the place they are
                        // reviewed, and the reviewer's name is on it.
                        const runId = (kind === 'run' || kind === 'tool') && d.runId ? d.runId : null;
                        const toolSummary = kind === 'tool' && d.outputSummary ? TOOL_SUMMARY_KEY[d.outputSummary] : undefined;
                        return (
                        <li key={d.id} className="space-y-tight p-4" data-testid={`decision-${d.id}`}>
                            <div className="flex flex-wrap items-center gap-tight">
                                <StatusBadge variant={OUTCOME_VARIANT[d.humanOutcome] ?? 'neutral'}>
                                    {t(`decisions.outcome.${d.humanOutcome}`)}
                                </StatusBadge>
                                <span className="text-sm font-medium text-content-emphasis">
                                    {featureLabel(d.feature)}
                                </span>
                                <span className="text-xs text-content-muted">{providerLabel(d)}</span>
                                {d.guardVerdict && (
                                    <span className="text-xs text-content-subtle">
                                        {t(`decisions.guard.${guardKey(d.guardVerdict)}`)}
                                    </span>
                                )}
                                <span className="ml-auto text-xs text-content-subtle">
                                    {formatDateTime(d.createdAt)}
                                </span>
                            </div>

                            {/* The bounded, sanitised summary — never raw model
                                output. The encryption manifest carves this column
                                out on exactly that contract, so rendering it here
                                is the use it was written for. */}
                            {d.outputSummary && (
                                <p className="text-sm text-content-muted">
                                    {toolSummary ? t(toolSummary) : d.outputSummary}
                                </p>
                            )}

                            {/* Where the row came from, and where it is reviewed
                                (#4896): the run, the proposal queue, the agent. */}
                            <div className="flex flex-wrap gap-default text-xs">
                                {runId && (
                                    <Link
                                        href={`/t/${tenantSlug}/agents/runs/${runId}`}
                                        className="text-content-info hover:underline"
                                        data-testid={`decision-run-${d.id}`}
                                    >
                                        {d.humanOutcome === 'PENDING' ? t('decisions.reviewRun') : t('decisions.openRun')}
                                    </Link>
                                )}
                                {kind === 'proposal' && (
                                    <Link
                                        href={`/t/${tenantSlug}/agents/proposals`}
                                        className="text-content-info hover:underline"
                                        data-testid={`decision-proposals-${d.id}`}
                                    >
                                        {t('decisions.openProposals')}
                                    </Link>
                                )}
                                {d.agentId && (
                                    <>
                                        <Link
                                            href={`/t/${tenantSlug}/agents/${d.agentId}`}
                                            className="text-content-info hover:underline"
                                            data-testid={`decision-agent-${d.id}`}
                                        >
                                            {agentNames[d.agentId] ?? t('decisions.agentUnknown')}
                                        </Link>
                                        {filters.agentId !== d.agentId && (
                                            <Link href={hrefWith({ agent: d.agentId })} className="text-content-info hover:underline">
                                                {t('decisions.onlyThisAgent')}
                                            </Link>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="flex flex-wrap gap-default text-xs text-content-subtle">
                                {/* Spend, shown as the two halves rather than a
                                    total: an answer that cost 200 in and 20 out is
                                    a different shape of call from 20 in and 200
                                    out, and the sum hides which. */}
                                {d.tokensIn != null && (
                                    <span className="tabular-nums">
                                        {t('decisions.tokensIn', { count: d.tokensIn })}
                                    </span>
                                )}
                                {d.tokensOut != null && (
                                    <span className="tabular-nums">
                                        {t('decisions.tokensOut', { count: d.tokensOut })}
                                    </span>
                                )}
                                {d.latencyMs != null && (
                                    <span className="tabular-nums">
                                        {t('decisions.latency', { ms: d.latencyMs })}
                                    </span>
                                )}
                                {/* The join key, truncated. It is what links this
                                    row to the proposal guarded over the same
                                    content — and what a step will link on once the
                                    tool-boundary guard emits one. */}
                                {digest === d.inputDigest ? (
                                    <code className="text-content-muted">{d.inputDigest.slice(0, 12)}</code>
                                ) : (
                                    <Link
                                        href={hrefWith({ digest: d.inputDigest })}
                                        className="font-mono text-content-info hover:underline"
                                        data-testid={`decision-digest-${d.id}`}
                                    >
                                        {d.inputDigest.slice(0, 12)}
                                    </Link>
                                )}
                            </div>
                        </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}
