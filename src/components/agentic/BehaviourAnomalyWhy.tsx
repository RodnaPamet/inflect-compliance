'use client';

/**
 * The "why" of one behaviour-fingerprint anomaly (Morpheus roadmap 1.3): each
 * feature that drove the verdict, its count that day, the agent's own baseline
 * mean and σ, and the z it scored. Shared by the agent's Overview card and the
 * `/agents/reports` behaviour view, so the two cannot word the same anomaly
 * differently.
 *
 * Counts and feature names only — the fingerprint never reads content, and
 * this renders nothing it did not store. Everything is React text.
 */
import { useTranslations } from 'next-intl';

import { StatusBadge } from '@/components/ui/status-badge';

/** Mirrors the server's `FingerprintDriverView`; declared here so no server module enters the client graph. */
export interface BehaviourDriver {
    feature: string;
    observed: number;
    mean: number;
    sd: number;
    z: number;
}

export interface BehaviourAnomaly {
    id: string;
    agentId: string;
    day: string;
    score: number;
    tier: 'FINDING' | 'LATCH';
    drivers: BehaviourDriver[];
    findingId: string | null;
    latchedAt: string | null;
    createdAt: string;
}

/** The features the server knows, in its order. A label for one it adds later falls back to its code. */
const FEATURE_KEYS = [
    'readCalls',
    'proposeCalls',
    'orchestrateCalls',
    'activeHours',
    'proposals',
    'guardFlags',
    'modelCalls',
    'tokens',
] as const;

export function useBehaviourFeatureLabel(): (feature: string) => string {
    const t = useTranslations('admin');
    return (feature: string) =>
        (FEATURE_KEYS as readonly string[]).includes(feature)
            ? t(`agentDetail.fingerprint.feature.${feature as (typeof FEATURE_KEYS)[number]}`)
            : feature;
}

function fmt(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function BehaviourAnomalyTierBadge({ tier }: { tier: 'FINDING' | 'LATCH' }) {
    const t = useTranslations('admin');
    return (
        <StatusBadge variant={tier === 'LATCH' ? 'error' : 'warning'}>
            {t(`agentDetail.fingerprint.tier.${tier}`)}
        </StatusBadge>
    );
}

export function BehaviourAnomalyWhy({ anomaly }: { anomaly: BehaviourAnomaly }) {
    const t = useTranslations('admin');
    const label = useBehaviourFeatureLabel();
    if (anomaly.drivers.length === 0) {
        return (
            <p className="text-sm text-content-muted" data-testid="behaviour-why-empty">
                {t('agentDetail.fingerprint.whyUnreadable')}
            </p>
        );
    }
    return (
        <ul className="space-y-tight" data-testid="behaviour-why" aria-label={t('agentDetail.fingerprint.whyAria')}>
            {anomaly.drivers.map((d) => (
                <li key={d.feature} className="text-sm text-content-default" data-testid={`behaviour-why-${d.feature}`}>
                    <span className="font-medium text-content-emphasis">{label(d.feature)}</span>{' '}
                    {t('agentDetail.fingerprint.whyLine', {
                        observed: fmt(d.observed),
                        mean: fmt(d.mean),
                        sd: fmt(d.sd),
                        z: fmt(d.z),
                    })}
                </li>
            ))}
        </ul>
    );
}
