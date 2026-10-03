'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format-date';

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
}

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
    canReviewProposals,
    canInvestigate,
}: {
    tenantSlug: string;
    decisions: readonly DecisionRow[];
    digest: string | null;
    /** `admin.view` — the proposals and runs pages' own gate. */
    canReviewProposals: boolean;
    /** `admin.agent_registry` — this page's own gate, and its siblings'. */
    canInvestigate: boolean;
}) {
    const t = useTranslations('agents');

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
                        canInvestigate={canInvestigate}
                    />
                }
            />

            {/* A NARROWED view says so. Without this line a digest that matches
                nothing renders identically to a tenant that has never run a
                model — two very different facts. */}
            {digest && (
                <p className="text-sm text-content-muted">
                    {t('decisions.filteredByDigest', { digest: digest.slice(0, 12) })}
                </p>
            )}

            {decisions.length === 0 ? (
                <EmptyState
                    title={digest ? t('decisions.emptyFilteredTitle') : t('decisions.emptyTitle')}
                    description={
                        digest ? t('decisions.emptyFilteredDesc') : t('decisions.emptyDesc')
                    }
                />
            ) : (
                <ol className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-subtle')}>
                    {decisions.map((d) => (
                        <li key={d.id} className="space-y-tight p-4">
                            <div className="flex flex-wrap items-center gap-tight">
                                <StatusBadge variant={OUTCOME_VARIANT[d.humanOutcome] ?? 'neutral'}>
                                    {t(`decisions.outcome.${d.humanOutcome}`)}
                                </StatusBadge>
                                <span className="text-sm font-medium text-content-emphasis">
                                    {d.feature}
                                </span>
                                <code className="text-xs text-content-muted">
                                    {d.model ? `${d.provider}/${d.model}` : d.provider}
                                </code>
                                {d.guardVerdict && (
                                    <span className="text-xs text-content-subtle">
                                        {t('decisions.guardLabel', { verdict: d.guardVerdict })}
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
                                <p className="text-sm text-content-muted">{d.outputSummary}</p>
                            )}

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
                                <code className="text-content-muted">
                                    {d.inputDigest.slice(0, 12)}
                                </code>
                            </div>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
