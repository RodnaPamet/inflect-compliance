'use client';

/**
 * One probe run's detail (step 8b): its targets and every outcome, read on the
 * server by `getProbeRunDetail` for the run named by `?run=`.
 *
 * What the agent said, and the full endpoint, arrive only for a holder of the
 * register key (owner decision, 2026-11-25). For anybody else they are null
 * and `excerptsShown` is false, and the panel says they were WITHHELD — never
 * that there was nothing. An excerpt is the agent's own text: it is rendered as
 * text in a `<pre>`, never as markdown or HTML.
 */
import { useTranslations } from 'next-intl';

import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { probeRunState, type ProbeRunDetailView } from '@/lib/agentic/probe-run-read-model';

const VERDICT_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    ACTED: 'error',
    DISCLOSED: 'error',
    RESISTED: 'success',
    INCONCLUSIVE: 'neutral',
};

/** One badge colour per run state, shared with the tab. */
export const RUN_STATE_VARIANT: Readonly<Record<ReturnType<typeof probeRunState>, StatusBadgeVariant>> = {
    FINDINGS: 'error',
    NOTHING_REACHED: 'error',
    STOPPED: 'warning',
    NOT_CONCLUDED: 'warning',
    RESISTED: 'success',
    PARTLY_INCONCLUSIVE: 'warning',
};

export function ProbeRunSheet({ detail, onClose }: { detail: ProbeRunDetailView; onClose: () => void }) {
    const t = useTranslations('agents');
    const { run } = detail;
    const state = probeRunState(run);
    const outcomesOf = (targetId: string) => detail.outcomes.filter((o) => o.targetId === targetId);

    return (
        <Sheet
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
            title={t('reports.probes.detail.title')}
        >
            <Sheet.Header
                title={t('reports.probes.detail.title')}
                description={t('reports.probes.detail.subtitle', {
                    prober: run.proberName ?? run.proberAgentId,
                    started: formatDateTime(run.startedAt),
                })}
            />
            <Sheet.Body>
                <div className="space-y-default" data-testid="probe-run-detail">
                    <div className="flex flex-wrap items-center gap-compact">
                        <StatusBadge variant={RUN_STATE_VARIANT[state]} data-testid="probe-run-detail-state">
                            {t(`reports.probes.state.${state}`)}
                        </StatusBadge>
                        <span className="text-xs text-content-muted">
                            {t('reports.probes.detail.engagement', { engagement: run.engagementId })}
                        </span>
                    </div>
                    {run.stopReason !== null && (
                        <InlineNotice variant="warning" data-testid="probe-run-detail-stopped">
                            {t('reports.probes.detail.stopped', { reason: t(`reports.probes.stopReason.${run.stopReason}`) })}
                        </InlineNotice>
                    )}
                    {!detail.excerptsShown && (
                        <InlineNotice variant="info" icon={null} data-testid="probe-run-detail-withheld">
                            {t('reports.probes.detail.withheld')}
                        </InlineNotice>
                    )}
                    {detail.outcomesTruncated && (
                        <InlineNotice variant="warning" icon={null} data-testid="probe-run-detail-truncated">
                            {t('reports.probes.detail.outcomesTruncated', { count: detail.outcomes.length })}
                        </InlineNotice>
                    )}
                    {detail.targets.map((target) => (
                        <section
                            key={target.targetId}
                            className="space-y-compact border-t border-border-subtle pt-default"
                            data-testid={`probe-target-${target.targetId}`}
                        >
                            <Heading level={3}>
                                <span className="font-mono break-all">{target.endpoint ?? target.origin}</span>
                            </Heading>
                            <p className="text-xs text-content-muted">
                                {t(`reports.probes.kind.${target.kind}`)} · {t(`reports.probes.targetReason.${target.reason}`)}
                            </p>
                            {outcomesOf(target.targetId).length === 0 ? (
                                <p className="text-sm text-content-muted">{t('reports.probes.detail.noOutcomes')}</p>
                            ) : (
                                <ul className="space-y-compact">
                                    {outcomesOf(target.targetId).map((o) => (
                                        <li key={o.outcomeId} className="space-y-tight" data-testid={`probe-outcome-${o.outcomeId}`}>
                                            <div className="flex flex-wrap items-center gap-compact">
                                                <StatusBadge variant={VERDICT_VARIANT[o.verdict] ?? 'neutral'} size="sm">
                                                    {t(`reports.probes.verdict.${o.verdict}`)}
                                                </StatusBadge>
                                                <span className="font-mono text-xs break-all">{o.probeId}</span>
                                                {o.tool && (
                                                    <span className="text-xs text-content-muted">
                                                        {t('reports.probes.detail.tool', { tool: o.tool })}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-content-muted">{t(`reports.probes.reason.${o.verdictReason}`)}</p>
                                            {o.excerpt !== null && (
                                                <pre
                                                    className="whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-subtle p-compact text-xs"
                                                    data-testid={`probe-outcome-excerpt-${o.outcomeId}`}
                                                >
                                                    {o.excerpt}
                                                </pre>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    ))}
                </div>
            </Sheet.Body>
        </Sheet>
    );
}
