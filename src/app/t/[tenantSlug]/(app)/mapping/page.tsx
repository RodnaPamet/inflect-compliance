'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { InlineNotice } from '@/components/ui/inline-notice';
import { readinessBand, readinessVariant } from '@/lib/readiness/bands';
import Link from 'next/link';

const BAND_TEXT_CLASS = {
    ready: 'text-content-success',
    nearly: 'text-content-warning',
    atRisk: 'text-content-error',
} as const;

// getFrameworkMappings (mapping.ts) — soc2/nis2 requirement rows augmented
// with computed coverage. (Element fields documented for the typed `data`
// access; the per-row map callback keeps its untyped param for now — a
// separate ratchet category.)
interface MappingItem {
    code: string;
    title: string;
    description: string;
    coverage: number;
    implementedCount: number;
    controlCount: number;
    /** Related controls with coverage-qualifying evidence. */
    evidenceCount: number;
}
interface FrameworkMappings {
    soc2: MappingItem[];
    nis2: MappingItem[];
}

export default function MappingPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('mapping');
    const [data, setData] = useState<FrameworkMappings | null>(null);
    const [failed, setFailed] = useState(false);
    const [tab, setTab] = useState<'soc2' | 'nis2'>('soc2');

    // The `.catch` is load-bearing, not decoration. Without it a network
    // rejection left `data` null for ever and the component below renders the
    // loading pulse on a null — so the page showed an animated skeleton with
    // no error, indefinitely. `r.ok` is checked for the same reason: a 500
    // that returns HTML makes `r.json()` throw down the same path.
    useEffect(() => {
        let live = true;
        fetch(apiUrl('/mapping'))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            // The reset rides the SUCCESS path rather than the effect body: a
            // synchronous `setFailed(false)` here is what
            // `react-hooks/set-state-in-effect` warns about, and it is only
            // needed so a later successful read clears a previous failure.
            .then((d) => { if (live) { setData(d as FrameworkMappings); setFailed(false); } })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [apiUrl]);

    if (failed) return <div className="text-content-muted p-8">{t('loadError')}</div>;
    if (!data) return <div className="animate-pulse text-content-muted p-8">{t('loading')}</div>;

    const items = tab === 'soc2' ? data.soc2 : data.nis2;

    return (
        <div className="space-y-section animate-fadeIn">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('title') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-content-muted text-sm">{t('subtitle')}</p>
            </div>

            {/* #4737 — the figures come from the guidance table that relates
                ISO 27001 Annex A controls to SOC 2 criteria and NIS2 areas,
                not from the workspace's own SOC 2 or NIS2 mappings. Said once,
                where the figures start. */}
            <InlineNotice variant="info" id="mapping-estimate-notice">
                {t('estimateNote')}{' '}
                <Link href={tenantHref('/frameworks')} className="font-medium underline">{t('frameworksLink')}</Link>
            </InlineNotice>

            {/* Epic 60 — ToggleGroup replaces raw btn-primary/btn-secondary
                toggle, giving us radiogroup ARIA + keyboard arrow nav. */}
            <ToggleGroup
                ariaLabel={t('frameworkToggle')}
                options={[
                    { value: 'soc2', label: t('soc2') },
                    { value: 'nis2', label: t('nis2') },
                ]}
                selected={tab}
                selectAction={(v) => setTab(v as 'soc2' | 'nis2')}
            />

            <div className="space-y-compact">
                {items.map((item) => {
                    // #4737 — "no related control" is not 0% implemented: a
                    // criterion the guidance relates to no control of yours
                    // says so, rather than a red 0% over "0/0 controls".
                    const related = item.controlCount > 0;
                    return (
                    <Card key={item.code} data-testid={`mapping-item-${item.code}`}>
                        <div className="flex items-center justify-between mb-2">
                            <div>
                                <span className="text-xs font-mono text-[var(--brand-default)] mr-2">{item.code}</span>
                                <span className="font-medium text-sm">{item.title}</span>
                            </div>
                            {related ? (
                                <span className={`text-sm font-bold ${BAND_TEXT_CLASS[readinessBand(item.coverage)]}`}>
                                    {item.coverage}%
                                </span>
                            ) : (
                                <span className="text-xs text-content-subtle">{t('relatedNone')}</span>
                            )}
                        </div>
                        <p className="text-xs text-content-muted mb-3">{item.description}</p>
                        {related && (
                            <div className="flex items-center gap-compact">
                                <div className="flex-1">
                                    {/* Epic 59 ProgressBar primitive, in the readiness bands. */}
                                    <ProgressBar
                                        value={item.coverage}
                                        size="sm"
                                        variant={readinessVariant(item.coverage) as 'success' | 'warning' | 'error'}
                                        aria-label={t('coverageAria', { title: item.title })}
                                    />
                                </div>
                                <span className="text-xs text-content-subtle">{t('controls', { implemented: item.implementedCount, total: item.controlCount })}</span>
                                <span className="text-xs text-content-subtle">{t('withEvidence', { count: item.evidenceCount, total: item.controlCount })}</span>
                            </div>
                        )}
                    </Card>
                    );
                })}
            </div>
        </div>
    );
}
