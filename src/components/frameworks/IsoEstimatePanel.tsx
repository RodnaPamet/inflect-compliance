'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { KPIStat } from '@/components/ui/metric';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Heading, textLinkVariants } from '@/components/ui/typography';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { readinessBand, readinessVariant } from '@/lib/readiness/bands';
import { useTenantHref } from '@/lib/tenant-context-provider';

/**
 * "SOC 2 and NIS2 estimate" — on ISO 27001's Coverage tab, how far the
 * workspace's ISO 27001 controls go towards SOC 2 and NIS2, by the guidance
 * table that relates Annex A controls to SOC 2 criteria and NIS2 areas
 * (`usecases/mapping.ts`).
 *
 * It used to be a page of its own (`/mapping`), which nothing linked to and
 * which read as real coverage. It is now offered only here, and only for a
 * framework the workspace does not use yet: once SOC 2 or NIS2 is in use, its
 * own page shows its real coverage, and an estimate beside it would only
 * compete with it. With both in use the panel renders nothing.
 */

interface EstimateItem {
    code: string;
    title: string;
    coverage: number;
    implementedCount: number;
    controlCount: number;
    /** Related controls with coverage-qualifying evidence. */
    evidenceCount: number;
}

export interface IsoEstimatePayload {
    soc2: EstimateItem[];
    nis2: EstimateItem[];
    inUse: { soc2: boolean; nis2: boolean };
}

type EstimatedFramework = 'soc2' | 'nis2';

const BAND_TEXT_CLASS = {
    ready: 'text-content-success',
    nearly: 'text-content-warning',
    atRisk: 'text-content-error',
} as const;

export function IsoEstimatePanel() {
    const t = useTranslations('frameworks.detail.isoEstimate');
    const tenantHref = useTenantHref();
    const { data, error, isLoading, mutate } = useTenantSWR<IsoEstimatePayload>('/mapping');

    if (error) {
        return (
            <ErrorState
                title={t('errorTitle')}
                description={t('errorLoad')}
                onRetry={() => void mutate()}
                retryLabel={t('retry')}
            />
        );
    }
    if (isLoading || !data) return <SkeletonCard lines={3} />;

    const shown = (['soc2', 'nis2'] as const).filter((key) => !data.inUse[key]);
    if (shown.length === 0) return null;

    return (
        <Card density="compact" id="iso-estimate-panel" data-testid="iso-estimate-panel">
            <div className="space-y-default">
                <div className="space-y-tight">
                    <Heading level={3}>{t('heading')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('description')}{' '}
                        <Link href={tenantHref('/frameworks')} className={textLinkVariants({ tone: 'link' })}>
                            {t('frameworksLink')}
                        </Link>
                    </p>
                </div>

                <Accordion type="multiple" className="space-y-tight">
                    {shown.map((key) => (
                        <EstimateSection key={key} framework={key} items={data[key]} />
                    ))}
                </Accordion>
            </div>
        </Card>
    );
}

function EstimateSection({ framework, items }: { framework: EstimatedFramework; items: EstimateItem[] }) {
    const t = useTranslations('frameworks.detail.isoEstimate');
    const related = items.filter((item) => item.controlCount > 0);
    // The average is over the criteria that have a related control: a
    // criterion the guidance relates to none of yours has no estimate, and
    // counting it as 0% would read as "not implemented".
    const average = related.length > 0
        ? Math.round(related.reduce((sum, item) => sum + item.coverage, 0) / related.length)
        : null;
    const name = t(`name.${framework}`);

    return (
        <section className="space-y-compact" data-testid={`iso-estimate-${framework}`}>
            <p className="text-sm font-semibold text-content-emphasis">{name}</p>
            <div className="grid grid-cols-1 gap-compact sm:grid-cols-2">
                <KPIStat
                    value={t('relatedOf', { related: related.length, total: items.length })}
                    label={t('relatedLabel')}
                />
                <KPIStat
                    value={average === null ? '—' : `${average}%`}
                    label={t('averageLabel')}
                />
            </div>
            <AccordionItem value={framework}>
                <AccordionTrigger>{t('showCriteria', { count: items.length, name })}</AccordionTrigger>
                <AccordionContent>
                    <ul className="space-y-compact" data-testid={`iso-estimate-${framework}-list`}>
                        {items.map((item) => (
                            <EstimateRow key={item.code} item={item} />
                        ))}
                    </ul>
                </AccordionContent>
            </AccordionItem>
        </section>
    );
}

function EstimateRow({ item }: { item: EstimateItem }) {
    const t = useTranslations('frameworks.detail.isoEstimate');
    // "No related control" is not 0% implemented (#4737).
    const related = item.controlCount > 0;
    return (
        <li className="space-y-tight border-t border-border-subtle pt-3" data-testid={`iso-estimate-item-${item.code}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-compact">
                <span className="flex flex-wrap items-baseline gap-compact">
                    <code className="font-mono text-xs text-content-subtle">{item.code}</code>
                    <span className="text-sm text-content-default">{item.title}</span>
                </span>
                {related ? (
                    <span className={`text-sm font-bold ${BAND_TEXT_CLASS[readinessBand(item.coverage)]}`}>
                        {item.coverage}%
                    </span>
                ) : (
                    <span className="text-xs text-content-subtle">{t('relatedNone')}</span>
                )}
            </div>
            {related && (
                <div className="flex flex-wrap items-center gap-compact">
                    <div className="flex-1">
                        <ProgressBar
                            value={item.coverage}
                            size="sm"
                            variant={readinessVariant(item.coverage) as 'success' | 'warning' | 'error'}
                            aria-label={t('coverageAria', { title: item.title })}
                        />
                    </div>
                    <span className="text-xs text-content-subtle">
                        {t('controls', { implemented: item.implementedCount, total: item.controlCount })}
                    </span>
                    <span className="text-xs text-content-subtle">
                        {t('withEvidence', { count: item.evidenceCount, total: item.controlCount })}
                    </span>
                </div>
            )}
        </li>
    );
}
