'use client';

/**
 * The agent's behaviour fingerprint on its Overview tab (Morpheus roadmap 1.3):
 * whether the nightly detector is watching this agent, its latest verdict, its
 * most recent anomaly with the features that drove it, and — where the server
 * says so — the one decision a person can take: accept the changed behaviour
 * as the agent's new normal.
 *
 * ── AN EMPTY CARD SAYS WHETHER ANYBODY LOOKED ──────────────────────────────
 *
 * "No anomalies" is said only when the detector is on and has scored this
 * agent. Off, it says off; on but never scored, it says the agent has not been
 * scored yet. The three are different facts and the read carries all three
 * (`detector`, `lastScoredDay`).
 *
 * ── THE ACCEPT BUTTON FOLLOWS THE SERVER ───────────────────────────────────
 *
 * Offered only on the server's `acceptBaseline.allowed`, which the usecase
 * computes with the same two rules its write asserts (who is asking, and the
 * breaker's state). An OPEN breaker is decided on the Circuit breaker tab, and
 * the card says so rather than offering a second way round that choice.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import {
    BehaviourAnomalyTierBadge,
    BehaviourAnomalyWhy,
    type BehaviourAnomaly,
} from '@/components/agentic/BehaviourAnomalyWhy';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { AgentTabProps } from './types';

type Verdict = 'LEARNING' | 'STEADY' | 'ANOMALOUS';

/** Mirrors `getAgentBehaviourFingerprint`'s return; declared here to keep server modules out of the client graph. */
export interface FingerprintPayload {
    agentId: string;
    detector: { on: boolean; basis: 'ON' | 'DEPLOYMENT_OFF' | 'TENANT_NOT_NAMED'; latch: boolean };
    thresholds: { zFinding: number; zLatch: number; baselineMinDays: number; baselineMaxDays: number; lookbackDays: number };
    lastScoredDay: string | null;
    days: { day: string; verdict: Verdict; score: number | null; baselineDays: number; inBaseline: boolean }[];
    anomalies: BehaviourAnomaly[];
    baselineEpoch: string | null;
    acceptBaseline: { allowed: boolean; refusal: string | null };
}

const VERDICT_TONE: Record<Verdict, 'neutral' | 'success' | 'warning'> = {
    LEARNING: 'neutral',
    STEADY: 'success',
    ANOMALOUS: 'warning',
};

export function BehaviourFingerprintCard({ agentId, refreshToken, onChanged }: AgentTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const { data, error, isLoading, mutate } = useTenantSWR<FingerprintPayload>(
        `/admin/agents/${agentId}/behaviour-fingerprint`,
    );
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [confirming, setConfirming] = useState(false);
    const [acceptError, setAcceptError] = useState<string | null>(null);

    const accept = useCallback(async () => {
        setAcceptError(null);
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}/behaviour-fingerprint`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: 'ACCEPT_NEW_BASELINE' }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('agentDetail.fingerprint.acceptFailed'));
            }
        } catch {
            message = t('agentDetail.fingerprint.acceptFailed');
        }
        if (message !== null) {
            setAcceptError(message);
            await mutate();
            throw new Error(message);
        }
        toast.success(t('agentDetail.fingerprint.accepted'));
        setConfirming(false);
        await mutate();
        onChanged?.();
    }, [apiUrl, agentId, mutate, onChanged, t, toast]);

    if (error) {
        return (
            <Card as="section" data-testid="agent-fingerprint">
                <InlineNotice variant="error" title={t('agentDetail.fingerprint.heading')}>
                    {t('agentDetail.fingerprint.loadError')}
                </InlineNotice>
            </Card>
        );
    }
    if (isLoading && !data) return <SkeletonCard lines={4} />;
    if (!data) return null;

    const latestDay = data.days[0] ?? null;
    const latestAnomaly = data.anomalies[0] ?? null;

    return (
        <Card as="section" className="space-y-default" data-testid="agent-fingerprint">
            <div className="flex flex-wrap items-center gap-default">
                <Heading level={2}>{t('agentDetail.fingerprint.heading')}</Heading>
                {latestDay && (
                    <StatusBadge variant={VERDICT_TONE[latestDay.verdict]}>
                        {t(`agentDetail.fingerprint.verdict.${latestDay.verdict}`)}
                    </StatusBadge>
                )}
            </div>
            <p className="text-sm text-content-muted">
                {t('agentDetail.fingerprint.intro', {
                    finding: data.thresholds.zFinding,
                    latch: data.thresholds.zLatch,
                    days: data.thresholds.baselineMinDays,
                })}
            </p>

            {!data.detector.on && (
                <InlineNotice variant="info" data-testid="agent-fingerprint-off">
                    {t(
                        data.detector.basis === 'TENANT_NOT_NAMED'
                            ? 'agentDetail.fingerprint.offTenant'
                            : 'agentDetail.fingerprint.offDeployment',
                    )}
                </InlineNotice>
            )}
            {data.detector.on && !data.lastScoredDay && (
                <InlineNotice variant="info" data-testid="agent-fingerprint-unscored">
                    {t('agentDetail.fingerprint.unscored')}
                </InlineNotice>
            )}
            {data.lastScoredDay && (
                <p className="text-sm text-content-default" data-testid="agent-fingerprint-last">
                    {latestDay?.verdict === 'LEARNING'
                        ? t('agentDetail.fingerprint.lastLearning', {
                              day: data.lastScoredDay,
                              have: latestDay.baselineDays,
                              need: data.thresholds.baselineMinDays,
                          })
                        : t('agentDetail.fingerprint.lastScored', { day: data.lastScoredDay })}
                </p>
            )}
            {data.baselineEpoch && (
                <p className="text-xs text-content-muted" data-testid="agent-fingerprint-epoch">
                    {t('agentDetail.fingerprint.epoch', { at: data.baselineEpoch.slice(0, 10) })}
                </p>
            )}

            {latestAnomaly ? (
                <div className="space-y-compact rounded-md border border-border-subtle p-3" data-testid="agent-fingerprint-anomaly">
                    <div className="flex flex-wrap items-center gap-compact">
                        <span className="text-sm font-medium text-content-emphasis">
                            {t('agentDetail.fingerprint.anomalyOn', {
                                day: latestAnomaly.day,
                                score: latestAnomaly.score.toFixed(1),
                            })}
                        </span>
                        <BehaviourAnomalyTierBadge tier={latestAnomaly.tier} />
                        {latestAnomaly.latchedAt && (
                            <StatusBadge variant="error">{t('agentDetail.fingerprint.latched')}</StatusBadge>
                        )}
                    </div>
                    <Heading level={3}>{t('agentDetail.fingerprint.whyHeading')}</Heading>
                    <BehaviourAnomalyWhy anomaly={latestAnomaly} />
                    {data.anomalies.length > 1 && (
                        <p className="text-xs text-content-muted">
                            {t('agentDetail.fingerprint.moreAnomalies', { count: data.anomalies.length - 1 })}
                        </p>
                    )}
                </div>
            ) : (
                data.lastScoredDay && (
                    <p className="text-sm text-content-muted" data-testid="agent-fingerprint-none">
                        {t('agentDetail.fingerprint.noAnomalies')}
                    </p>
                )
            )}

            {latestAnomaly && data.acceptBaseline.refusal === 'BREAKER_OPEN' && (
                <InlineNotice variant="warning" data-testid="agent-fingerprint-breaker-open">
                    {t('agentDetail.fingerprint.breakerOpen')}
                </InlineNotice>
            )}
            {data.acceptBaseline.allowed && (
                <div>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="agent-fingerprint-accept"
                        onClick={() => {
                            setAcceptError(null);
                            setConfirming(true);
                        }}
                    >
                        {t('agentDetail.fingerprint.acceptAction')}
                    </Button>
                </div>
            )}

            <ConfirmDialog
                showModal={confirming}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(confirming) : open;
                    if (!next) setConfirming(false);
                }}
                tone="warning"
                title={t('agentDetail.fingerprint.acceptTitle')}
                description={
                    <>
                        {t('agentDetail.fingerprint.acceptBody')}
                        {acceptError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="agent-fingerprint-accept-error">
                                {acceptError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('agentDetail.fingerprint.acceptConfirm')}
                cancelLabel={t('agentDetail.fingerprint.cancel')}
                onConfirm={accept}
            />
        </Card>
    );
}
