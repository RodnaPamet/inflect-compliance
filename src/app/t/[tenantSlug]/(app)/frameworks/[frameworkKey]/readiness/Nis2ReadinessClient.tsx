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
import { useTenantContext } from '@/lib/tenant-context-provider';

// CC BY 4.0 attribution — carries everywhere derived NIS2 content renders.
const NIS2_ATTRIBUTION =
    'NIS2 gap-assessment questions © NISD2 contributors (Kardashev Catalyst UG / nisd2.eu), CC BY 4.0';
const NIS2_SOURCE_URL = 'https://github.com/NISD2/nis2-gap-assessment-schema';

// The closed vocabularies of the gap (`src/lib/schemas/nis2-gap-assessment.ts`,
// `Nis2Gap` in usecases/nis2-readiness.ts). Each is worded from
// `frameworks.readiness.<field>.<value>` (#4733: they were printed as stored).
type Criticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type TimeToFix = 'QUICK_WIN' | 'DAYS' | 'WEEKS' | 'MONTHS';
type GapAnswer = 'NA' | 'NO' | 'PARTIALLY' | 'YES';
type PriorityTier = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
type Gap = {
    questionId: string;
    domainId: number;
    criticality: Criticality;
    consequence: string;
    fineExposure: boolean;
    timeToFix: TimeToFix;
    legalBasis: string;
    answer: GapAnswer;
    priority: number;
    priorityTier: PriorityTier;
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

function critVariant(c: Criticality): 'error' | 'warning' | 'info' | 'neutral' {
    if (c === 'CRITICAL') return 'error';
    if (c === 'HIGH') return 'warning';
    if (c === 'MEDIUM') return 'info';
    return 'neutral';
}

export function Nis2ReadinessClient({ tenantSlug }: { tenantSlug: string }) {
    const locale = useLocale();
    const t = useTranslations('frameworks');
    // #4733 — the question bank is the upstream dataset's, in English and
    // German; the product ships English and Bulgarian. The questions and
    // domain names are shown in English, and a reader in another language is
    // told so once, rather than reading a page that silently mixes the two.
    const lang = 'en' as const;
    const questionsInEnglish = locale !== 'en';
    // `materializeNis2Gaps` asks `assertCanWrite`: a role the server refuses
    // is not offered the button (#4733), and is told why.
    const canWrite = useTenantContext().permissions.canWrite;
    const base = `/api/t/${tenantSlug}/onboarding/nis2-assessment`;

    const [data, setData] = useState<Payload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [materializing, setMaterializing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${base}/readiness`);
            if (res.ok) setData(await res.json());
            else setError(t('readiness.loadFailed'));
        } catch {
            // Never the browser's "Failed to fetch".
            setError(t('readiness.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [base, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load]);

    const eligibleCount = useMemo(
        () => (data?.readiness.gaps ?? []).filter((g) => g.criticality === 'HIGH' || g.criticality === 'CRITICAL').length,
        [data],
    );

    const handleMaterialize = useCallback(async () => {
        setMaterializing(true);
        setError(null);
        try {
            const res = await fetch(`${base}/materialize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minCriticality: 'HIGH', createTasks: true }),
            });
            if (!res.ok) {
                // A refusal is the role's, not a fault to retry (#4733).
                setError(res.status === 403 ? t('readiness.createRestricted') : t('readiness.createFailed'));
                return;
            }
            const r = await res.json();
            setNotice(t('readiness.created', { created: r.created, tasks: r.tasksCreated, reopened: r.reopened, closed: r.closed }));
        } catch {
            setError(t('readiness.createFailed'));
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
            { accessorKey: 'criticality', header: t('readiness.colCriticality'), cell: ({ row }) => <StatusBadge variant={critVariant(row.original.criticality)} size="sm">{t(`readiness.criticality.${row.original.criticality}`)}</StatusBadge> },
            { accessorKey: 'answer', header: t('readiness.colAnswer'), cell: ({ row }) => <span className="text-content-muted">{t(`readiness.answer.${row.original.answer}`)}</span> },
            { accessorKey: 'priority', header: t('readiness.colPriority'), cell: ({ row }) => <StatusBadge variant={row.original.priorityTier === 'URGENT' ? 'error' : row.original.priorityTier === 'HIGH' ? 'warning' : 'neutral'} size="sm">{t(`readiness.priorityTier.${row.original.priorityTier}`)}</StatusBadge> },
            { accessorKey: 'timeToFix', header: t('readiness.colEffort'), cell: ({ row }) => <span className="text-content-muted">{t(`readiness.timeToFix.${row.original.timeToFix}`)}</span> },
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
    if (error && !data) {
        return (
            <div className="space-y-default p-6">
                <InlineNotice variant="error" id="nis2-readiness-load-failed">{error}</InlineNotice>
                <Button variant="secondary" onClick={() => { void load(); }} id="nis2-readiness-retry">{t('readiness.retry')}</Button>
            </div>
        );
    }
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

            {questionsInEnglish && (
                <p className="text-xs text-content-subtle" id="nis2-readiness-english-note">{t('readiness.questionsInEnglish')}</p>
            )}

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
                    {canWrite && (
                        <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={materializing || eligibleCount === 0} id="nis2-create-findings-btn">
                            {materializing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                            {t('readiness.createFindings')}
                        </Button>
                    )}
                </div>
                {!canWrite && (
                    <p className="text-xs text-content-subtle" id="nis2-create-findings-restricted">{t('readiness.createRestricted')}</p>
                )}
                {canWrite && eligibleCount === 0 && (
                    <p className="text-xs text-content-subtle" id="nis2-create-findings-none">{t('readiness.createFindingsNone')}</p>
                )}
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
