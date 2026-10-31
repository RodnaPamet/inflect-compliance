'use client';

/**
 * Control-health summary — the composite-verdict roll-up for the controls
 * dashboard. Reads the batched `/controls/health-verdicts` endpoint
 * (`counts` by verdict) and renders one labelled tile per verdict, reusing
 * the same verdict labels + StatusBadge variant map as the detail card and
 * the list Health column so the vocabulary reads as one system.
 *
 * A client island (the dashboard shell is otherwise fetch-on-mount) — it
 * self-fetches via `useTenantSWR` and shows a skeleton while loading, never
 * a permanent blank.
 */
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { SkeletonCard } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Button } from '@/components/ui/button';
import {
    CONTROL_HEALTH_VERDICT_VARIANT,
    CONTROL_HEALTH_VERDICTS,
    type ControlHealthVerdict,
} from '@/lib/controls/control-health';

interface HealthVerdictSummary {
    counts: Record<ControlHealthVerdict, number>;
    /** Set when the tenant exceeds the health-scan cap — some badges are missing. */
    truncated?: boolean;
    scanned?: number;
    cap?: number;
}

export function ControlHealthSummary() {
    const t = useTranslations('controls');
    const tenantHref = useTenantHref();
    const { data, isLoading, error, mutate } = useTenantSWR<HealthVerdictSummary>(
        '/controls/health-verdicts',
    );

    return (
        <Card>
            <div className="mb-4 flex items-center gap-1.5">
                <Heading level={3}>{t('dashboard.controlHealthTitle')}</Heading>
                {/* The hint states the verdict rule, held to it by
                    tests/unit/control-health-hint-matches-rule. Declared
                    effectiveness informs valuation/ROI, never health. */}
                <InfoTooltip content={t('dashboard.controlHealthMeasuredOnly')} />
            </div>
            {/* The verdict scan is capped; say so rather than silently dropping
                badges for the controls past it. */}
            {data?.truncated && (
                <InlineNotice variant="warning" className="mb-4">
                    {t('dashboard.controlHealthTruncated', { scanned: data.scanned ?? 0, cap: data.cap ?? 0 })}
                </InlineNotice>
            )}
            {isLoading && !data ? (
                <SkeletonCard lines={2} />
            ) : error && !data ? (
                // #4793 — a failed read rendered every tile at 0, which reads
                // as "no control is healthy". Say it could not be read.
                <div className="space-y-default" id="control-health-error">
                    <InlineNotice variant="error">{t('dashboard.controlHealthLoadFailed')}</InlineNotice>
                    <Button variant="secondary" size="sm" onClick={() => void mutate()}>
                        {t('dashboard.retry')}
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-default md:grid-cols-5" id="control-health-summary">
                    {CONTROL_HEALTH_VERDICTS.map((verdict) => {
                        const count = data?.counts[verdict] ?? 0;
                        const tileBody = (
                            <>
                                <span className="text-xl font-semibold tabular-nums text-content-emphasis">
                                    {count}
                                </span>
                                <StatusBadge size="sm" variant={CONTROL_HEALTH_VERDICT_VARIANT[verdict]}>
                                    {t(`health.verdict.${verdict}` as Parameters<typeof t>[0])}
                                </StatusBadge>
                            </>
                        );
                        const tileClass = 'flex flex-col items-start gap-1.5 rounded-lg border border-border-subtle p-3';
                        // Non-zero tiles deep-link to the register filtered to that
                        // verdict (mirrors the consistency-check deep-link). Zero
                        // tiles stay non-interactive — nothing to drill into.
                        return count > 0 ? (
                            <Link
                                key={verdict}
                                href={tenantHref(`/controls?health=${verdict}`)}
                                className={`${tileClass} transition-colors hover:border-border-emphasis hover:bg-bg-muted`}
                                data-verdict-tile={verdict}
                                aria-label={t('dashboard.controlHealthTileAria', { count, verdict: t(`health.verdict.${verdict}` as Parameters<typeof t>[0]) })}
                            >
                                {tileBody}
                            </Link>
                        ) : (
                            <div key={verdict} className={tileClass} data-verdict-tile={verdict}>
                                {tileBody}
                            </div>
                        );
                    })}
                </div>
            )}
        </Card>
    );
}
