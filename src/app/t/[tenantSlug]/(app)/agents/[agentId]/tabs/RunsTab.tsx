'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { formatDateTime } from '@inflect/ui/lib/format-date';

import type { AgentTabProps } from './types';

/**
 * WHAT THIS AGENT ACTUALLY DID — its runs, newest first (#3472).
 *
 * ── WHY THE REGISTER NEEDED THIS ────────────────────────────────────────────
 *
 * The register admitted the agent; the ledger recorded what it then did; and
 * the two were unreachable from each other. `/agents/runs` lists every run in
 * the tenant and `/agents/[agentId]` described an agent's authority, so the
 * question "what has THIS agent been doing" could only be answered by reading
 * a tenant-wide list and filtering by eye. Point 08 calls that out: the
 * register should reach the work it authorised.
 *
 * ── THE LIST IS THIS AGENT'S, AND IT SAYS SO BY BEING EMPTY ─────────────────
 *
 * `WorkflowRun.agentId` is NULL for a human-started run, so this list cannot
 * show one. That is deliberate rather than a limitation: a panel on an agent's
 * page that mixed in runs a person started would be answering a different
 * question, and on a governance surface attributing a person's run to an agent
 * is the error that matters.
 *
 * So an agent with no runs renders the empty state rather than the tenant's
 * other runs, and the empty state says WHICH question came back empty.
 *
 * ── READ-ONLY, AND NO `onChanged` ───────────────────────────────────────────
 *
 * Nothing here writes. Resuming or aborting a run happens on the run itself,
 * where the full context is — a button here would act on a row whose steps the
 * operator has not seen.
 */

/** Row shape, as `listWorkflowRuns` returns it. */
interface RunRow {
    id: string;
    workflowKey: string;
    status: string;
    driver: string;
    stepCount: number;
    costTokens: number;
    startedAt: string;
    completedAt: string | null;
    summary: string | null;
    errorMessage: string | null;
    _count?: { proposals: number };
}

/**
 * The badge tone per status.
 *
 * `AWAITING_APPROVAL` is ATTENTION and not success: a run waiting on a person
 * is work the tenant owes, and the reason the run list grew a pending-proposal
 * count in the first place. `PAUSED` is neutral — a deploy paused it and it
 * resumes — where `FAILED` and `ABORTED` are not interchangeable: one is a
 * fault and the other is something stopping the run on purpose.
 */
const TONE: Record<string, StatusBadgeVariant> = {
    COMPLETED: 'success',
    RUNNING: 'info',
    AWAITING_APPROVAL: 'warning',
    PAUSED: 'neutral',
    FAILED: 'error',
    ABORTED: 'error',
};

export function RunsTab({ agentId, refreshToken }: AgentTabProps) {
    // ADMIN, not AGENTS. Every `agentDetail.*` key lives under the `admin`
    // namespace — `CoverageTab` and the shell's own tab labels both read it
    // that way — and the one time a tab's string was filed under
    // `agents.agentDetail` it rendered MISSING_MESSAGE and took main red
    // (#3499). The widened `i18n-keys-resolve` caught this very draft doing
    // the same thing, which is exactly what it was widened for.
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const { data, error, isLoading, mutate } = useTenantSWR<RunRow[]>(
        CACHE_KEYS.agentRuns.forAgent(agentId),
    );
    useEffect(() => { void mutate(); }, [refreshToken, mutate]);

    if (isLoading) return <SkeletonCard />;
    if (error) {
        return (
            <ErrorState
                title={t('agentDetail.runs.loadFailed')}
                onRetry={() => { void mutate(); }}
            />
        );
    }
    if (!data) return <SkeletonCard />;

    if (data.length === 0) {
        return (
            <Card className="p-default">
                <InlineEmptyState
                    title={t('agentDetail.runs.emptyTitle')}
                    description={t('agentDetail.runs.emptyDescription')}
                />
            </Card>
        );
    }

    return (
        <Card className="space-y-compact p-default" data-testid="agent-runs-tab">
            <Heading level={3}>{t('agentDetail.runs.heading')}</Heading>
            <p className="text-sm text-content-muted">
                {t('agentDetail.runs.scope', { count: data.length })}
            </p>
            <ul className="divide-y divide-border-subtle" data-testid="agent-runs-list">
                {data.map((run) => (
                    <li key={run.id} className="flex items-center gap-default py-tight">
                        <StatusBadge variant={TONE[run.status] ?? 'neutral'} icon={null}>
                            {run.status}
                        </StatusBadge>
                        <div className="min-w-0 flex-1">
                            {/* The LINK is the point of the panel: every row
                                reaches the step ledger for that run. */}
                            <Link
                                href={tenantHref(`/agents/runs/${run.id}`)}
                                className="font-medium hover:underline"
                                data-testid={`agent-run-link-${run.id}`}
                            >
                                {run.workflowKey}
                            </Link>
                            <p className="text-xs text-content-muted">
                                {formatDateTime(run.startedAt)}
                                {' · '}
                                {t('agentDetail.runs.steps', { count: run.stepCount })}
                                {/* Tokens only when there are some. A run that
                                    spent nothing and a run whose usage went
                                    unreported both store 0, so a "0 tokens"
                                    chip would state a fact the row cannot
                                    support. */}
                                {run.costTokens > 0
                                    ? ` · ${t('agentDetail.runs.tokens', { count: run.costTokens })}`
                                    : ''}
                            </p>
                        </div>
                        {/* PENDING PROPOSALS, because AWAITING_APPROVAL does not
                            mean there is something to approve: a human
                            checkpoint pauses a run whether or not it queued
                            anything. The count is what tells them apart. */}
                        {(run._count?.proposals ?? 0) > 0 && (
                            <StatusBadge variant="warning" icon={null}>
                                {t('agentDetail.runs.pendingProposals', {
                                    count: run._count?.proposals ?? 0,
                                })}
                            </StatusBadge>
                        )}
                    </li>
                ))}
            </ul>
        </Card>
    );
}
