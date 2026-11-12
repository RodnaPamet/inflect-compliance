'use client';

/**
 * The behaviour view of `/agents/reports` (Morpheus roadmap 1.3): every
 * behaviour-fingerprint anomaly in the workspace over the stated window,
 * newest first, each with the features that drove it and a link to the agent.
 *
 * Read-only. The one decision about an anomaly — accepting a changed behaviour
 * as the agent's new normal — is taken on the agent's own Overview tab, where
 * the breaker's state is in view; a second place to take it would be a second
 * place to take it without looking.
 *
 * An empty list is worded from the detector's state, never from the length
 * alone: off, never scored and scored-with-nothing are three different facts.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import {
    BehaviourAnomalyTierBadge,
    BehaviourAnomalyWhy,
    type BehaviourAnomaly,
} from '@/components/agentic/BehaviourAnomalyWhy';
import { useTenantHref } from '@/lib/tenant-context-provider';

/** Mirrors `listAgentBehaviourAnomalies`; declared here to keep server modules out of the client graph. */
export interface BehaviourReportView {
    detector: { on: boolean; basis: 'ON' | 'DEPLOYMENT_OFF' | 'TENANT_NOT_NAMED'; latch: boolean };
    thresholds: { zFinding: number; zLatch: number; baselineMinDays: number };
    windowDays: number;
    since: string;
    lastScoredDay: string | null;
    truncated: boolean;
    anomalies: (BehaviourAnomaly & { agentName: string | null })[];
}

export function BehaviourTab({ view }: { view: BehaviourReportView }) {
    const t = useTranslations('agents');
    const ta = useTranslations('admin');
    const tenantHref = useTenantHref();

    return (
        <div className="space-y-section" data-testid="reports-behaviour">
            <Card as="section" className="space-y-default">
                <Heading level={2}>{t('reports.behaviourHeading')}</Heading>
                <p className="text-sm text-content-muted">
                    {t('reports.behaviourScope', {
                        days: view.windowDays,
                        since: view.since,
                        finding: view.thresholds.zFinding,
                        latch: view.thresholds.zLatch,
                    })}
                </p>
                {!view.detector.on && (
                    <InlineNotice variant="info" data-testid="reports-behaviour-off">
                        {ta(
                            view.detector.basis === 'TENANT_NOT_NAMED'
                                ? 'agentDetail.fingerprint.offTenant'
                                : 'agentDetail.fingerprint.offDeployment',
                        )}
                    </InlineNotice>
                )}
                {view.detector.on && !view.lastScoredDay && (
                    <InlineNotice variant="info" data-testid="reports-behaviour-unscored">
                        {t('reports.behaviourUnscored')}
                    </InlineNotice>
                )}
                {view.truncated && (
                    <InlineNotice variant="warning" data-testid="reports-behaviour-truncated">
                        {t('reports.behaviourTruncated', { count: view.anomalies.length })}
                    </InlineNotice>
                )}
                {view.anomalies.length === 0 && view.lastScoredDay && (
                    <p className="text-sm text-content-muted" data-testid="reports-behaviour-none">
                        {t('reports.behaviourNone', { day: view.lastScoredDay })}
                    </p>
                )}
            </Card>

            {view.anomalies.length > 0 && (
                <ul className="space-y-default" data-testid="reports-behaviour-list">
                    {view.anomalies.map((a) => (
                        <li key={a.id}>
                            <Card as="article" density="compact" className="space-y-compact" data-testid={`reports-behaviour-${a.id}`}>
                                <div className="flex flex-wrap items-center gap-compact">
                                    <Link
                                        href={tenantHref(`/agents/${a.agentId}`)}
                                        className="text-sm font-medium text-content-emphasis underline-offset-2 hover:underline"
                                    >
                                        {a.agentName ?? a.agentId}
                                    </Link>
                                    <span className="text-sm text-content-muted">
                                        {ta('agentDetail.fingerprint.anomalyOn', { day: a.day, score: a.score.toFixed(1) })}
                                    </span>
                                    <BehaviourAnomalyTierBadge tier={a.tier} />
                                </div>
                                <BehaviourAnomalyWhy anomaly={a} />
                            </Card>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
