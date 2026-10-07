'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { DataTable, createColumns } from '@/components/ui/table';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { TimeSeriesChart, Bars, XAxis, YAxis } from '@/components/ui/charts';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { formatDate } from '@inflect/ui/lib/format-date';

// CC BY 4.0 attribution — carries everywhere derived NIS2 content renders.
const NIS2_ATTRIBUTION =
    'NIS2 gap-assessment questions © NISD2 contributors (Kardashev Catalyst UG / nisd2.eu), CC BY 4.0';
const NIS2_SOURCE_URL = 'https://github.com/NISD2/nis2-gap-assessment-schema';

type Gap = {
    questionId: string;
    domainId: number;
    criticality: string;
    consequence: string;
    fineExposure: boolean;
    timeToFix: string;
    legalBasis: string;
    answer: string;
    priority: number;
    priorityTier: string;
    plainText: { en: string; de: string };
};
type DomainScore = { domainId: number; code: string; name: { en: string; de: string }; score: number; answered: number; total: number };
type Snapshot = { score: number; gapCount: number; computedAt: string };
type Payload = {
    readiness: {
        score: { overall: number; byDomain: DomainScore[] };
        gaps: Gap[];
        fineExposureGaps: number;
        answeredTotal: number;
        questionTotal: number;
    };
    snapshots: Snapshot[];
    focusAreas: Array<{ domainId: number; code: string; name: { en: string; de: string }; score: number }>;
};

function critVariant(c: string): 'error' | 'warning' | 'info' | 'neutral' {
    if (c === 'CRITICAL') return 'error';
    if (c === 'HIGH') return 'warning';
    if (c === 'MEDIUM') return 'info';
    return 'neutral';
}

export function Nis2ReadinessClient({ tenantSlug }: { tenantSlug: string }) {
    const locale = useLocale();
    const t = useTranslations('frameworks');
    const lang = locale === 'de' ? 'de' : 'en';
    const base = `/api/t/${tenantSlug}/onboarding/nis2-assessment`;

    const [data, setData] = useState<Payload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [materializing, setMaterializing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${base}/readiness`);
            if (!res.ok) throw new Error(t('readiness.loadFailed'));
            setData(await res.json());
        } catch (e) {
            setError(e instanceof Error ? e.message : t('readiness.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [base, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        load();
    }, [load]);

    const eligibleCount = useMemo(
        () => (data?.readiness.gaps ?? []).filter((g) => g.criticality === 'HIGH' || g.criticality === 'CRITICAL').length,
        [data],
    );

    const handleMaterialize = useCallback(async () => {
        setMaterializing(true);
        try {
            const res = await fetch(`${base}/materialize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minCriticality: 'HIGH', createTasks: true }),
            });
            if (!res.ok) throw new Error(t('readiness.createFailed'));
            const r = await res.json();
            setNotice(t('readiness.created', { created: r.created, tasks: r.tasksCreated, reopened: r.reopened, closed: r.closed }));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('readiness.createFailed'));
        } finally {
            setMaterializing(false);
        }
    }, [base, t]);

    const domainColumns = useMemo(
        () => createColumns<DomainScore>([
            { accessorKey: 'code', header: t('readiness.colDomain'), cell: ({ row }) => <span className="font-medium">{row.original.code}</span> },
            { accessorKey: 'name', header: t('readiness.colName'), cell: ({ row }) => <span>{row.original.name?.[lang]}</span> },
            { accessorKey: 'score', header: t('readiness.colScore'), cell: ({ row }) => <span className="tabular-nums">{row.original.score}</span> },
            { id: 'answered', header: t('readiness.colAnswered'), cell: ({ row }) => <span className="tabular-nums text-content-muted">{row.original.answered}/{row.original.total}</span> },
        ]),
        [lang, t],
    );

    const gapColumns = useMemo(
        () => createColumns<Gap>([
            { accessorKey: 'plainText', header: t('readiness.colGap'), cell: ({ row }) => <span>{row.original.plainText?.[lang]}</span> },
            { accessorKey: 'criticality', header: t('readiness.colCriticality'), cell: ({ row }) => <StatusBadge variant={critVariant(row.original.criticality)} size="sm">{row.original.criticality}</StatusBadge> },
            { accessorKey: 'answer', header: t('readiness.colAnswer'), cell: ({ row }) => <span className="text-content-muted">{row.original.answer}</span> },
            { accessorKey: 'priority', header: t('readiness.colPriority'), cell: ({ row }) => <StatusBadge variant={row.original.priorityTier === 'URGENT' ? 'error' : row.original.priorityTier === 'HIGH' ? 'warning' : 'neutral'} size="sm">{row.original.priorityTier}</StatusBadge> },
            { accessorKey: 'timeToFix', header: t('readiness.colEffort'), cell: ({ row }) => <span className="text-content-muted">{row.original.timeToFix}</span> },
            { accessorKey: 'legalBasis', header: t('readiness.colLegalBasis'), cell: ({ row }) => <span className="text-xs text-content-muted">{row.original.legalBasis}</span> },
        ]),
        [lang, t],
    );

    const trend = useMemo(
        () => (data?.snapshots ?? []).map((s) => ({ date: new Date(s.computedAt), values: { value: s.score } })),
        [data],
    );

    if (loading) {
        return <div className="flex items-center gap-tight p-6 text-content-muted text-sm"><Loader2 className="w-4 h-4 animate-spin" /> {t('readiness.loading')}</div>;
    }
    if (error && !data) return <p className="p-6 text-sm text-content-error">{error}</p>;
    if (!data) return null;

    const sortedDomains = [...data.readiness.score.byDomain].sort((a, b) => a.score - b.score);

    return (
        <div className="space-y-section p-4" data-testid="nis2-readiness">
            <div className="space-y-tight">
                <BackAffordance />
                <Heading level={1}>{t('readiness.heading')}</Heading>
            </div>

            {/* Disclaimer — NOT a legal compliance determination. */}
            <InlineNotice variant="info">
                {t.rich('readiness.disclaimer', { strong: (c) => <strong>{c}</strong> })}
            </InlineNotice>

            {notice && <InlineNotice variant="success">{notice}</InlineNotice>}
            {error && <p className="text-sm text-content-error">{error}</p>}

            {/* Headline KPIs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-default">
                <KPIStat value={`${data.readiness.score.overall}`} label={t('readiness.scoreLabel')} description={t('readiness.scoreDesc')} />
                <KPIStat value={`${data.readiness.fineExposureGaps}`} label={t('readiness.fineExposureLabel')} tone={data.readiness.fineExposureGaps > 0 ? 'critical' : 'default'} description={t('readiness.fineExposureDesc')} />
                <KPIStat value={`${data.readiness.gaps.length}`} label={t('readiness.openGapsLabel')} description={t('readiness.answeredDesc', { answered: data.readiness.answeredTotal, total: data.readiness.questionTotal })} />
            </div>

            {/* Readiness over time (reuses the chart platform) */}
            {trend.length >= 2 && (
                <div className="space-y-tight">
                    <Heading level={3}>{t('readiness.overTime')}</Heading>
                    <div className="h-48">
                        <TimeSeriesChart
                            data={trend}
                            series={[{ id: 'score', isActive: true, valueAccessor: (d: { values: { value: number } }) => d.values.value, colorClassName: 'text-brand-default' }]}
                            type="bar"
                        >
                            <YAxis showGridLines />
                            <Bars />
                            <XAxis tickFormat={(d: Date) => formatDate(d)} />
                        </TimeSeriesChart>
                    </div>
                </div>
            )}

            {/* Domain breakdown (lowest first) + focus areas */}
            <div className="space-y-tight">
                <Heading level={3}>{t('readiness.domainBreakdown')}</Heading>
                {data.focusAreas.length > 0 && (
                    <p className="text-sm text-content-muted">
                        {t('readiness.focusHint', { domains: data.focusAreas.map((f) => f.code).join(', ') })}
                    </p>
                )}
                <DataTable data={sortedDomains} columns={domainColumns} getRowId={(r) => String(r.domainId)} />
            </div>

            {/* Prioritized gap list */}
            <div className="space-y-tight">
                <div className="flex items-center justify-between gap-compact flex-wrap">
                    <Heading level={3}>{t('readiness.prioritizedGaps')}</Heading>
                    <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={materializing || eligibleCount === 0}>
                        {materializing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        {t('readiness.createFindings')}
                    </Button>
                </div>
                <DataTable data={data.readiness.gaps} columns={gapColumns} getRowId={(r) => r.questionId} />
            </div>

            {/* CC BY 4.0 attribution */}
            <p className="text-xs text-content-subtle">
                {NIS2_ATTRIBUTION}{' '}
                <a href={NIS2_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-content-muted">{t('readiness.source')}</a>
            </p>

            <ConfirmDialog
                showModal={confirmOpen}
                setShowModal={(open) => {
                    if (typeof open === 'function') {
                        if (!open(confirmOpen)) setConfirmOpen(false);
                    } else setConfirmOpen(open);
                }}
                title={t('readiness.confirmTitle')}
                description={t('readiness.confirmDesc', { count: eligibleCount })}
                confirmLabel={t('readiness.createFindings')}
                onConfirm={async () => {
                    setConfirmOpen(false);
                    await handleMaterialize();
                    await load();
                }}
            />
        </div>
    );
}
