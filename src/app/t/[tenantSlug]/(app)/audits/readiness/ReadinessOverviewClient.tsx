'use client';

/**
 * readiness-reconcile — the single readiness overview on the audit hub.
 *
 * Three DIFFERENT axes were computed by three scorers and surfaced in three
 * places (two of them both labelled "NIS2 readiness"). This overview presents
 * them together, each unambiguously labelled with a one-line explanation of
 * what it measures, so they read as complementary rather than contradictory:
 *
 *   • Control coverage    — audit-readiness/scoring per cycle (mapping /
 *                           implementation / evidence).
 *   • Self-assessment     — nis2-readiness maturity (answers to the gap
 *     maturity              questionnaire).
 *   • Test readiness      — test-readiness (test-plan / run coverage of
 *                           mapped controls), previously only on /tests/dashboard.
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge } from '@/components/ui/status-badge';
import { InfoTooltip } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@/lib/cn';
import { readinessTone, readinessVariant } from '@/lib/readiness/bands';

interface Cycle { id: string; name: string; frameworkKey: string; status: string }
interface TestReadiness { frameworkKey: string; frameworkName: string; testPlanCoverage: number; testRunCoverage: number; passRate: number }

// This page's return is what reintroduced four copies of the 80/50
// thresholds — in TWO vocabularies, one line apart. Both now come from the
// single definition in `@/lib/readiness/bands`; `readinessTone` speaks the
// KPI scale, `readinessVariant` the badge scale.

export function ReadinessOverviewClient({ tenantSlug }: { tenantSlug: string }) {
    const tx = useTranslations('audits');
    const apiUrl = useCallback((p: string) => `/api/t/${tenantSlug}${p}`, [tenantSlug]);
    const [cycles, setCycles] = useState<Cycle[]>([]);
    const [tests, setTests] = useState<TestReadiness[]>([]);
    const [maturity, setMaturity] = useState<number | null>(null);

    useEffect(() => {
        Promise.all([
            fetch(apiUrl('/audits/cycles')).then((r) => (r.ok ? r.json() : [])),
            fetch(apiUrl('/tests/readiness')).then((r) => (r.ok ? r.json() : [])),
            // Fail-soft — no NIS2 assessment yet → no maturity card.
            fetch(apiUrl('/audits/nis2-gap')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]).then(([c, t, n]) => {
            setCycles(Array.isArray(c) ? c : []);
            setTests(Array.isArray(t) ? t : []);
            setMaturity(typeof n?.latest?.score?.overall === 'number' ? n.latest.score.overall : null);
        });
    }, [apiUrl]);

    return (
        <div className="space-y-section">
            <PageHeader
                breadcrumbs={[
                    { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: tx('title'), href: `/t/${tenantSlug}/audits` },
                    { label: tx('overview.crumb') },
                ]}
                title={tx('overview.title')}
                description={tx('overview.description')}
            />

            {/* Axis 1 — control coverage (per cycle). */}
            <section className={cn(cardVariants(), 'space-y-default')}>
                <div className="flex items-center gap-tight">
                    <Heading level={2}>{tx('overview.coverageTitle')}</Heading>
                    <InfoTooltip content={tx('overview.coverageHelp')} />
                </div>
                {cycles.length === 0 ? (
                    <p className="text-sm text-content-muted">{tx('overview.coverageEmpty')}</p>
                ) : (
                    <div className="space-y-tight">
                        {cycles.map((c) => (
                            <Link key={c.id} href={`/t/${tenantSlug}/audits/cycles/${c.id}/readiness`}
                                className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between hover:bg-bg-muted/50 transition block')}>
                                <span className="text-sm font-medium">{c.name} <span className="text-content-subtle">· {c.frameworkKey}</span></span>
                                <span className="text-xs text-content-muted">{tx('overview.viewCoverage')} →</span>
                            </Link>
                        ))}
                    </div>
                )}
            </section>

            {/* Axis 2 — NIS2 self-assessment maturity. */}
            {maturity !== null && (
                <section className={cn(cardVariants(), 'space-y-default')}>
                    <div className="flex items-center gap-tight">
                        <Heading level={2}>{tx('overview.maturityTitle')}</Heading>
                        <InfoTooltip content={tx('overview.maturityHelp')} />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="rounded-lg bg-bg-default/50 px-4 py-3">
                            <KPIStat value={`${Math.round(maturity)}%`} label={tx('overview.maturityLabel')} tone={readinessTone(maturity)} />
                        </div>
                        <Link href={`/t/${tenantSlug}/audits/nis2-gap`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                            {tx('overview.openGapAssessment')}
                        </Link>
                    </div>
                </section>
            )}

            {/* Axis 3 — test readiness (brought onto the hub from /tests/dashboard). */}
            <section className={cn(cardVariants(), 'space-y-default')}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-tight">
                        <Heading level={2}>{tx('overview.testTitle')}</Heading>
                        <InfoTooltip content={tx('overview.testHelp')} />
                    </div>
                    <Link href={`/t/${tenantSlug}/tests/dashboard`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                        {tx('overview.openTestDashboard')}
                    </Link>
                </div>
                {tests.length === 0 ? (
                    <p className="text-sm text-content-muted">{tx('overview.testEmpty')}</p>
                ) : (
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3">
                        {tests.map((t) => (
                            <div key={t.frameworkKey} className="rounded-lg border border-border-subtle p-3 space-y-tight">
                                <p className="text-sm font-medium text-content-emphasis">{t.frameworkName}</p>
                                <div className="flex flex-wrap gap-tight">
                                    <StatusBadge variant={readinessVariant(t.testPlanCoverage)}>
                                        {tx('overview.planCoverage', { pct: Math.round(t.testPlanCoverage) })}
                                    </StatusBadge>
                                    <StatusBadge variant={readinessVariant(t.testRunCoverage)}>
                                        {tx('overview.runCoverage', { pct: Math.round(t.testRunCoverage) })}
                                    </StatusBadge>
                                    <StatusBadge tone="subtle" variant={readinessVariant(t.passRate)}>
                                        {tx('overview.passRate', { pct: Math.round(t.passRate) })}
                                    </StatusBadge>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
