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
 * ── THE FOUR VALUES, SPELLED THE WAY THE DATABASE SPELLS THEM ───────────────
 *
 * `AiHumanOutcome` is `PENDING | ACCEPTED | EDITED | REJECTED`, and this map
 * carried `MODIFIED` instead of `EDITED` — a value the column cannot hold, and
 * the one value it CAN hold that was missing. `approveAgentProposal` passes its
 * `'ACCEPTED' | 'EDITED'` status straight through, so an edited approval has
 * always been writable; it rendered with the neutral fallback variant and a
 * `t()` key that resolves to nothing, i.e. as the dotted key path. Nothing
 * caught it because the lookup is a template literal, which
 * `i18n-keys-resolve` states outright it cannot follow — "those keys are the
 * ones a rendered test has to cover instead", which is now what covers them.
 */
const OUTCOME_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
    ACCEPTED: 'success',
    EDITED: 'warning',
    REJECTED: 'error',
    PENDING: 'neutral',
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
