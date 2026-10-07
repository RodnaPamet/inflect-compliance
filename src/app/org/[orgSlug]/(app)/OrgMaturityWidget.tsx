'use client';

/**
 * ORG_MATURITY widget — self-assessed security-maturity radar.
 *
 * Concept ported from Cybether (MIT). Renders the org's judgment-based CMM
 * level (1..5) across the 6 NIST CSF 2.0 functions as a radar (Epic 59
 * radar-chart primitive — never raw SVG), with an overall KPIStat. This is
 * the MATURITY axis ("how good are we, by judgment") — DISTINCT from
 * derived control coverage %, which only appears as an advisory hint.
 *
 * Maturity drifts: a rating older than 90 days renders a "may be stale" note.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Gauge } from 'lucide-react';

import { RadarChart, TimeSeriesChart, Bars, XAxis, YAxis, chartReady, chartEmpty } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/empty-state';
import { KPIStat } from '@/components/ui/metric';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { OrgMaturityDto, MaturityDomainRating } from '@/app-layer/usecases/org-maturity';

const LEVELS = ['INITIAL', 'REPEATABLE', 'DEFINED', 'MANAGED', 'OPTIMIZING'] as const;
const LEVEL_LABEL_KEY: Record<string, string> = {
    INITIAL: 'widgets.levelInitial',
    REPEATABLE: 'widgets.levelRepeatable',
    DEFINED: 'widgets.levelDefined',
    MANAGED: 'widgets.levelManaged',
    OPTIMIZING: 'widgets.levelOptimizing',
};
const DOMAIN_LABEL_KEY: Record<string, string> = {
    GOVERN: 'widgets.domainGovern',
    IDENTIFY: 'widgets.domainIdentify',
    PROTECT: 'widgets.domainProtect',
    DETECT: 'widgets.domainDetect',
    RESPOND: 'widgets.domainRespond',
    RECOVER: 'widgets.domainRecover',
};

const STALE_DAYS = 90;

function daysSince(iso: string | null): number | null {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export function OrgMaturityWidget({
    data,
    canSet,
    view,
    showCoverageHint,
    orgSlug,
}: {
    data: OrgMaturityDto;
    canSet: boolean;
    view: 'radar' | 'trend';
    showCoverageHint: boolean;
    orgSlug: string;
}) {
    const router = useRouter();
    const t = useTranslations('org');
    const [rateOpen, setRateOpen] = useState(false);
    const age = daysSince(data.lastRatedAt);
    const isStale = age !== null && age > STALE_DAYS;

    const radarAxes = data.domains.map((d) => ({
        key: d.domain,
        label: DOMAIN_LABEL_KEY[d.domain] ? t(DOMAIN_LABEL_KEY[d.domain]) : d.domain,
        value: d.levelNum,
    }));

    return (
        <div className="flex h-full flex-col gap-tight rounded-lg bg-bg-subtle p-4" data-testid="org-maturity-widget">
            <div className="flex items-start justify-between gap-compact flex-wrap">
                <div className="flex items-center gap-compact">
                    <Gauge className="w-5 h-5 text-content-muted" aria-hidden="true" />
                    <KPIStat
                        value={data.isDefault ? '—' : `${data.overall.toFixed(1)} / 5`}
                        label={t('widgets.securityMaturity')}
                        description={data.overallLabel && LEVEL_LABEL_KEY[data.overallLabel] ? t(LEVEL_LABEL_KEY[data.overallLabel]) : t('widgets.notYetRated')}
                        size="sm"
                    />
                </div>
                {canSet && (
                    <Button variant="secondary" size="sm" onClick={() => setRateOpen(true)}>
                        {t('widgets.rateMaturity')}
                    </Button>
                )}
            </div>

            {/* Guaranteed-height chart slot. NEVER `min-h-0` here — a
                collapsible flex child gives the chart's auto-sizer a
                0-height box and it renders blank. The explicit min-height
                (≥ the chart's own 240px floor) keeps the radar visible
                regardless of how the dashboard grid flexes. */}
            <div className="min-h-[260px] flex-1">
                {view === 'trend' ? (
                    <MaturityTrend orgSlug={orgSlug} />
                ) : (
                    <RadarChart
                        // Empty (not blank) until the org has real ratings —
                        // the default DTO carries placeholder domains, so gate
                        // on `isDefault` / an empty axis set.
                        state={
                            data.isDefault || radarAxes.length === 0
                                ? chartEmpty()
                                : chartReady(radarAxes)
                        }
                        seriesIndex={2}
                        maxValue={5}
                        testId="org-maturity-radar"
                        ariaLabel={t('widgets.maturityRadarAria')}
                        emptyFallback={
                            <EmptyState
                                size="sm"
                                title={t('widgets.ratingsEmptyTitle')}
                                description={t('widgets.ratingsEmptyDesc')}
                            />
                        }
                    />
                )}
            </div>

            {showCoverageHint && data.coverageHint && (
                <p className="text-xs text-content-muted">
                    {t('widgets.coverageAdvisory', {
                        percent: data.coverageHint.coveragePercent,
                        level: LEVEL_LABEL_KEY[data.coverageHint.suggestedLevel]
                            ? t(LEVEL_LABEL_KEY[data.coverageHint.suggestedLevel])
                            : data.coverageHint.suggestedLevel,
                    })}
                </p>
            )}

            {!data.isDefault && (
                <p className="text-xs text-content-muted">
                    {age === 0 ? t('widgets.lastRatedToday') : t('widgets.lastRatedDaysAgo', { count: age ?? 0 })}
                </p>
            )}
            {isStale && (
                <p className="text-xs text-content-warning" data-testid="org-maturity-stale">
                    {t('widgets.maturityStale', { count: age ?? 0 })}
                </p>
            )}

            {rateOpen && (
                <RateMaturitySheet
                    orgSlug={orgSlug}
                    domains={data.domains}
                    coverageHint={showCoverageHint ? data.coverageHint : null}
                    open={rateOpen}
                    onClose={() => setRateOpen(false)}
                    onSaved={() => router.refresh()}
                />
            )}
        </div>
    );
}

function MaturityTrend({ orgSlug }: { orgSlug: string }) {
    const t = useTranslations('org');
    const [points, setPoints] = useState<Array<{ date: Date; values: { overall: number } }> | null>(null);
    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/org/${orgSlug}/maturity/trend`);
            if (!res.ok) return;
            const data = await res.json();
            setPoints(
                (data.trend ?? []).map((p: { date: string; overall: number }) => ({
                    date: new Date(p.date),
                    values: { overall: p.overall },
                })),
            );
        } catch {
            /* best-effort */
        }
    }, [orgSlug]);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        load();
    }, [load]);

    if (!points || points.length < 2) {
        return <p className="text-xs text-content-muted">{t('widgets.notEnoughHistory')}</p>;
    }
    return (
        <TimeSeriesChart
            data={points}
            series={[{ id: 'overall', isActive: true, valueAccessor: (d: { values: { overall: number } }) => d.values.overall, colorClassName: 'text-brand-default' }]}
            type="bar"
        >
            <YAxis showGridLines />
            <Bars />
            <XAxis tickFormat={(d: Date) => formatDate(d)} />
        </TimeSeriesChart>
    );
}

function RateMaturitySheet({
    orgSlug,
    domains,
    coverageHint,
    open,
    onClose,
    onSaved,
}: {
    orgSlug: string;
    domains: MaturityDomainRating[];
    coverageHint: OrgMaturityDto['coverageHint'];
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations('org');
    const [savingDomain, setSavingDomain] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(
        async (domain: string, level: string) => {
            setSavingDomain(domain);
            try {
                const res = await fetch(`/api/org/${orgSlug}/maturity`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ domain, level }),
                });
                if (!res.ok) throw new Error(t('widgets.failedSaveRating'));
                onSaved();
            } catch (e) {
                setError(e instanceof Error ? e.message : t('widgets.failedSaveRating'));
            } finally {
                setSavingDomain(null);
            }
        },
        [orgSlug, onSaved, t],
    );

    return (
        <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
            <Sheet.Header title={t('widgets.rateSheetTitle')} />
            <Sheet.Body>
                {coverageHint && (
                    <p className="text-xs text-content-muted mb-4">
                        {t('widgets.coverageAdvisorySheet', {
                            percent: coverageHint.coveragePercent,
                            level: LEVEL_LABEL_KEY[coverageHint.suggestedLevel]
                                ? t(LEVEL_LABEL_KEY[coverageHint.suggestedLevel])
                                : coverageHint.suggestedLevel,
                        })}
                    </p>
                )}
                <div className="space-y-section">
                    {domains.map((d) => (
                        <div key={d.domain} className="space-y-tight" data-testid={`maturity-domain-${d.domain}`}>
                            <p className="text-sm font-medium">
                                {DOMAIN_LABEL_KEY[d.domain] ? t(DOMAIN_LABEL_KEY[d.domain]) : d.domain}
                                {savingDomain === d.domain && <span className="text-xs text-content-muted"> · {t('widgets.savingSuffix')}</span>}
                            </p>
                            <RadioGroup
                                value={d.level ?? ''}
                                onValueChange={(v) => save(d.domain, v)}
                                className="flex flex-wrap gap-compact"
                            >
                                {LEVELS.map((lvl) => (
                                    <label key={lvl} className="flex items-center gap-tight text-xs cursor-pointer">
                                        <RadioGroupItem value={lvl} />
                                        {t(LEVEL_LABEL_KEY[lvl])}
                                    </label>
                                ))}
                            </RadioGroup>
                        </div>
                    ))}
                    {error && <p className="text-sm text-content-error">{error}</p>}
                </div>
            </Sheet.Body>
        </Sheet>
    );
}
