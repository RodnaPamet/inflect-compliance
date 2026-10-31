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
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@inflect/ui/lib/cn';
import { readinessTone, readinessVariant } from '@/lib/readiness/bands';

interface Cycle { id: string; name: string; frameworkKey: string; frameworkName?: string | null; status: string }
/** `/audits/readiness/overview` — the cycles joined with each one's score (#4729). */
interface CoverageOverview { cycles: Cycle[]; scoresByCycleId: Record<string, { score: number }> }
/** What a section shows: still loading, read, or failed to read. */
type Section<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed' };
interface TestReadiness { frameworkKey: string; frameworkName: string; testPlanCoverage: number; testRunCoverage: number; passRate: number }

// This page's return is what reintroduced four copies of the 80/50
// thresholds — in TWO vocabularies, one line apart. Both now come from the
// single definition in `@/lib/readiness/bands`; `readinessTone` speaks the
// KPI scale, `readinessVariant` the badge scale.

export function ReadinessOverviewClient({ tenantSlug }: { tenantSlug: string }) {
    const tx = useTranslations('audits');
    const apiUrl = useCallback((p: string) => `/api/t/${tenantSlug}${p}`, [tenantSlug]);
    // Each section reads on its own and says when its read failed. A failed or
    // refused read used to fall through to the empty state ("No audit cycles
    // yet."), and with no loading state that sentence showed on every visit
    // until the data arrived (#4729).
    const [coverage, setCoverage] = useState<Section<CoverageOverview>>({ state: 'loading' });
    const [tests, setTests] = useState<Section<TestReadiness[]>>({ state: 'loading' });
    const [maturity, setMaturity] = useState<Section<number | null>>({ state: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let live = true;
        const read = async <T,>(path: string, shape: (body: unknown) => T): Promise<Section<T>> => {
            try {
                const res = await fetch(apiUrl(path));
                if (!res.ok) return { state: 'failed' };
                return { state: 'ready', data: shape(await res.json()) };
            } catch {
                return { state: 'failed' };
            }
        };
        void read('/audits/readiness/overview', (b) => {
            const body = b as Partial<CoverageOverview> | null;
            return { cycles: Array.isArray(body?.cycles) ? body.cycles : [], scoresByCycleId: body?.scoresByCycleId ?? {} };
        }).then((s) => { if (live) setCoverage(s); });
        void read('/tests/readiness', (b) => (Array.isArray(b) ? (b as TestReadiness[]) : [])).then((s) => { if (live) setTests(s); });
        // No NIS2 assessment yet is a 200 with no latest run: no card. A
        // failed read is a failure, not an absence.
        void read('/audits/nis2-gap', (b) => {
            const overall = (b as { latest?: { score?: { overall?: unknown } } } | null)?.latest?.score?.overall;
            return typeof overall === 'number' ? overall : null;
        }).then((s) => { if (live) setMaturity(s); });
        return () => { live = false; };
    }, [apiUrl, attempt]);

    const retry = () => {
        setCoverage({ state: 'loading' });
        setTests({ state: 'loading' });
        setMaturity({ state: 'loading' });
        setAttempt((n) => n + 1);
    };

    const failedNotice = (id: string) => (
        <div className="flex items-center justify-between gap-compact" role="alert" id={id}>
            <p className="text-sm text-content-error">{tx('overview.loadFailed')}</p>
            <Button variant="secondary" size="sm" onClick={retry}>{tx('overview.retry')}</Button>
        </div>
    );
    const loadingNotice = <p className="text-sm text-content-muted">{tx('overview.loading')}</p>;

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
                {coverage.state === 'loading' ? loadingNotice
                    : coverage.state === 'failed' ? failedNotice('overview-coverage-failed')
                    : coverage.data.cycles.length === 0 ? (
                    <EmptyState size="sm" variant="no-records" title={tx('overview.coverageEmpty')} />
                ) : (
                    <div className="space-y-tight">
                        {coverage.data.cycles.map((c) => {
                            const score = coverage.data.scoresByCycleId[c.id]?.score;
                            return (
                                <Link key={c.id} href={`/t/${tenantSlug}/audits/cycles/${c.id}/readiness`}
                                    className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between gap-compact hover:bg-bg-muted/50 transition block')}
                                    data-testid="overview-coverage-row">
                                    <span className="text-sm font-medium">{c.name} <span className="text-content-subtle">· {c.frameworkName ?? c.frameworkKey}</span></span>
                                    <span className="flex items-center gap-tight">
                                        {typeof score === 'number' ? (
                                            <StatusBadge variant={readinessVariant(score)}>{tx('overview.coverageScore', { pct: Math.round(score) })}</StatusBadge>
                                        ) : (
                                            <span className="text-xs text-content-subtle">{tx('cycles.noScore')}</span>
                                        )}
                                        <span className="text-xs text-content-muted">{tx('overview.viewCoverage')} →</span>
                                    </span>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Axis 2 — NIS2 self-assessment maturity. */}
            {maturity.state === 'failed' && (
                <section className={cn(cardVariants(), 'space-y-default')}>
                    <Heading level={2}>{tx('overview.maturityTitle')}</Heading>
                    {failedNotice('overview-maturity-failed')}
                </section>
            )}
            {maturity.state === 'ready' && maturity.data !== null && (
                <section className={cn(cardVariants(), 'space-y-default')}>
                    <div className="flex items-center gap-tight">
                        <Heading level={2}>{tx('overview.maturityTitle')}</Heading>
                        <InfoTooltip content={tx('overview.maturityHelp')} />
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="rounded-lg bg-bg-default/50 px-4 py-3">
                            <KPIStat value={`${Math.round(maturity.data)}%`} label={tx('overview.maturityLabel')} tone={readinessTone(maturity.data)} />
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
                {tests.state === 'loading' ? loadingNotice
                    : tests.state === 'failed' ? failedNotice('overview-tests-failed')
                    : tests.data.length === 0 ? (
                    <EmptyState size="sm" variant="no-records" title={tx('overview.testEmpty')} />
                ) : (
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3">
                        {tests.data.map((t) => (
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
