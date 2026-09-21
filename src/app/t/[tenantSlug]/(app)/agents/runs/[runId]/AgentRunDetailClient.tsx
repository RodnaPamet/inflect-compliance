'use client';

import { useTranslations } from 'next-intl';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { StatusBadge } from '@/components/ui/status-badge';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EmptyState } from '@/components/ui/empty-state';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';

export interface RunStepRow {
    id: string;
    seq: number;
    kind: string;
    status: string;
    /** The tool that ran, or — on a failed step, which records none — the one the definition declared. */
    tool: string | null;
    /** From the definition; `WorkflowStep` has no label column. */
    label: string | null;
    at: string;
    actorUserId: string | null;
    inputJson: string | null;
    outputJson: string | null;
}

export interface RunHeader {
    id: string;
    workflowKey: string;
    workflowName: string;
    status: string;
    driver: 'STATIC' | 'FLUE';
    stepCount: number;
    costTokens: number;
    startedAt: string;
    completedAt: string | null;
    summary: string | null;
    errorMessage: string | null;
}

const STATUS_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'error' | 'neutral'> = {
    RUNNING: 'info',
    AWAITING_APPROVAL: 'warning',
    PAUSED: 'warning',
    COMPLETED: 'success',
    ABORTED: 'neutral',
    FAILED: 'error',
};

/**
 * Per-STEP status. A different axis from the run's, and deliberately its own
 * map: a step is PENDING while the run is AWAITING_APPROVAL, and collapsing the
 * two would make the checkpoint that is waiting look like the run that is.
 */
const STEP_STATUS_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'error' | 'neutral'> = {
    PENDING: 'warning',
    RUNNING: 'info',
    DONE: 'success',
    FAILED: 'error',
    SKIPPED: 'neutral',
};

const DRIVER_VARIANT: Record<string, 'info' | 'neutral'> = {
    STATIC: 'neutral',
    FLUE: 'info',
};

/** A step's payload, shown as TEXT and never interpreted. */
function Payload({ label, json }: { label: string; json: string | null }) {
    if (!json) return null;
    return (
        <details className="text-xs">
            <summary className="cursor-pointer text-content-subtle">{label}</summary>
            {/*
                `json` is agent-authored tenant content, decrypted on read by the
                Epic B extension. It goes through `{}` so React escapes it, into
                a <pre> so it keeps its shape, and is NEVER parsed or injected —
                the quarantine surface settled this for the same class of
                content. `break-words` because a single long line of JSON would
                otherwise make the whole page scroll sideways.
            */}
            <pre className="mt-tight overflow-x-auto whitespace-pre-wrap break-words text-content-muted">
                {json}
            </pre>
        </details>
    );
}

/**
 * The run's step ledger, in order.
 *
 * An ordered LIST, not a table: the rows are heterogeneous — a checkpoint has
 * an actor and no tool, a synthesis has output and neither — and a table would
 * spend four columns being empty to keep them aligned. It also keeps the whole
 * table platform (`DataTable`, filter toolbar, column dropdown, list-page
 * shell) out of a surface that needs none of it.
 */
export function AgentRunDetailClient({
    tenantSlug,
    run,
    steps,
}: {
    tenantSlug: string;
    run: RunHeader;
    steps: RunStepRow[];
}) {
    const t = useTranslations('agents');
    const tenantHref = useTenantHref();

    return (
        <EntityDetailLayout
            breadcrumbs={[
                { href: tenantHref('/agents'), label: t('runs.detail.crumbAgents') },
                { href: tenantHref('/agents/runs'), label: t('runs.crumb') },
                { label: run.workflowName },
            ]}
            // The smart back affordance, not a static href: the canonical
            // parent (/agents/runs) is the cold-load fallback, and a reader who
            // arrived from a proposal should go back there instead.
            back={{ smart: true }}
            title={run.workflowName}
            // `<MetaStrip>` rather than a hand-rolled row of badges —
            // `detail-page-metastrip-adoption` requires it of every detail page
            // passing `meta`, and the editorial cap it documents (at most five
            // items, never two rows) is why this carries four and leaves the
            // summary to the body.
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('runs.detail.metaStatus'),
                            value: run.status,
                            variant: STATUS_VARIANT[run.status] ?? 'neutral',
                        },
                        {
                            kind: 'status',
                            label: t('runs.detail.metaDriver'),
                            value: t(`runs.driver.${run.driver}`),
                            variant: DRIVER_VARIANT[run.driver] ?? 'neutral',
                        },
                        {
                            kind: 'metric',
                            label: t('runs.detail.metaSteps'),
                            value: run.stepCount,
                        },
                        {
                            // The RUN's total. There is no per-step token
                            // column — `costTokens` is accumulated across the
                            // whole run — so the honest place for the number is
                            // the header, not a per-step chip that would have to
                            // invent it by division.
                            kind: 'metric',
                            label: t('runs.detail.metaTokens'),
                            value: run.costTokens,
                        },
                        {
                            label: t('runs.detail.metaStarted'),
                            value: formatDateTime(run.startedAt),
                        },
                    ]}
                />
            }
        >
            <div className="space-y-section">
                {run.errorMessage && (
                    <p className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')}>
                        {run.errorMessage}
                    </p>
                )}
                {run.summary && (
                    <p className={cn(cardVariants({ density: 'comfortable' }), 'text-sm text-content-default')}>
                        {run.summary}
                    </p>
                )}

                {steps.length === 0 ? (
                    <EmptyState
                        title={t('runs.detail.emptyTitle')}
                        description={t('runs.detail.emptyDesc')}
                    />
                ) : (
                    <ol id="run-step-timeline" className="space-y-default">
                        {steps.map((s) => (
                            <li
                                key={s.id}
                                id={`step-${s.seq}`}
                                className={cn(cardVariants({ density: 'comfortable' }), 'space-y-tight')}
                            >
                                <div className="flex flex-wrap items-center gap-tight">
                                    <span className="text-xs tabular-nums text-content-subtle">
                                        {t('runs.detail.seq', { seq: s.seq + 1 })}
                                    </span>
                                    <StatusBadge variant={STEP_STATUS_VARIANT[s.status] ?? 'neutral'}>
                                        {s.status}
                                    </StatusBadge>
                                    <span className="text-sm font-medium text-content-emphasis">
                                        {t(`runs.detail.kind.${s.kind}`)}
                                    </span>
                                    {/* The tool, when this kind has one. Rendered
                                        from the column where the step recorded it
                                        and from the definition where a failure
                                        did not. */}
                                    {s.tool && (
                                        <code className="text-xs text-content-muted">{s.tool}</code>
                                    )}
                                    {s.label && (
                                        <span className="text-xs text-content-subtle">{s.label}</span>
                                    )}
                                    <span className="ml-auto text-xs text-content-subtle">
                                        {formatDateTime(s.at)}
                                    </span>
                                </div>
                                <Payload label={t('runs.detail.inputLabel')} json={s.inputJson} />
                                <Payload label={t('runs.detail.outputLabel')} json={s.outputJson} />
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        </EntityDetailLayout>
    );
}
