import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { getTenantCtx } from '@/app-layer/context';
import { computeAgentReviewQuality } from '@/app-layer/usecases/agent-review-quality';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/**
 * REVIEW QUALITY — the surface for "do these approvals mean anything?".
 *
 * A sibling of `/admin/agents` (which agents may act) and `/agent-proposals`
 * (what they proposed). This page is about the HUMANS: how fast they decide,
 * how often they say no, and whether a run of approvals was one act rather than
 * many. Admin-gated by the parent `/admin` layout, and the endpoint behind the
 * same data is gated `admin.agent_registry`.
 *
 * ── Three renderings that are deliberately NOT the obvious ones ──
 *
 * A REFUSED estimate is PRINTED, not hidden. A reviewer with four decisions
 * shows "Rate and median not reported: 4 of 10 decisions needed" where the
 * percentage would be. Omitting the row would make a reviewer nobody can
 * measure look like a reviewer with nothing to answer for, and dropping the
 * denominator would let 3/3 render as 100%.
 *
 * The FASTEST decision is printed for everybody, at any sample size, because it
 * is an observation rather than an estimate — see the module header in
 * `@/lib/agentic/automation-bias`.
 *
 * There is NO p90 and NO mean anywhere on this page. Both would be real
 * numbers, both would move, and neither would mean anything: the gap this page
 * measures is propose-to-decide, which is queue latency PLUS review time, so
 * only its lower tail bounds how long anybody actually looked. The note under
 * the header says so on the page rather than only in the code.
 *
 * The alert is written by the usecase when a pattern is outstanding, and
 * deduplicated on a digest — so opening this page twice does not write two rows
 * into a log that is never erased.
 */
export default async function AgentReviewQualityPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;

    const ctx = await getTenantCtx({ tenantSlug });
    const report = await computeAgentReviewQuality(ctx);
    const t = await getTranslations('admin');

    const pct = (rate: number) => Math.round(rate * 100);
    const secs = (n: number) => Math.round(n * 10) / 10;

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('crumb.agents'), href: tenantHref('/admin/agents') },
                    { label: t('crumb.reviewQuality') },
                ]}
                title={t('reviewQuality.title')}
                description={t('reviewQuality.pageDesc')}
            />

            <p className="text-sm text-content-muted">
                {t('reviewQuality.windowLabel', { days: report.windowDays })} ·{' '}
                {t('reviewQuality.decided')} {report.decided} · {t('reviewQuality.approved')}{' '}
                {report.approved} · {t('reviewQuality.rejected')} {report.rejected}
            </p>
            <p className="text-xs text-content-subtle">{t('reviewQuality.upperTailNote')}</p>

            {report.truncated && (
                <InlineNotice variant="warning">
                    {t('reviewQuality.truncated', { max: report.decided })}
                </InlineNotice>
            )}

            <section className="space-y-default">
                <h2 className="text-sm font-medium text-content-emphasis">
                    {t('reviewQuality.unobservableTitle')}
                </h2>
                {/* Rendered ABOVE the numbers, and unconditionally — including on
                    an empty tenant. A blind spot mentioned only in a footnote is
                    a blind spot a reader assumes is not there. */}
                <ul className="space-y-tight">
                    {report.unobservable.map((code) => (
                        <li key={code} className="text-sm text-content-muted">
                            {t(`reviewQuality.unobservable.${code}`)}
                        </li>
                    ))}
                </ul>
            </section>

            {report.decided === 0 ? (
                <p className="text-sm text-content-muted">{t('reviewQuality.empty')}</p>
            ) : (
                <>
                    <section className="space-y-default">
                        <h2 className="text-sm font-medium text-content-emphasis">
                            {t('reviewQuality.signalsTitle')}
                        </h2>
                        {report.signals.length === 0 ? (
                            <p className="text-sm text-content-muted">
                                {t('reviewQuality.signalsNone')}
                            </p>
                        ) : (
                            <ul className="space-y-default">
                                {report.signals.map((s) => (
                                    <li
                                        key={`${s.code}:${s.subjectId ?? '-'}`}
                                        className="flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4"
                                    >
                                        <span className="flex items-center gap-compact">
                                            <StatusBadge variant="warning">
                                                {t(`reviewQuality.signal.${s.code}`)}
                                            </StatusBadge>
                                            <span className="text-sm text-content-muted">
                                                {t('reviewQuality.signalSubject', {
                                                    subject: s.subjectId ?? '—',
                                                })}
                                            </span>
                                        </span>
                                        <span className="text-sm text-content-muted">
                                            {t('reviewQuality.signalMeasure', {
                                                observed: secs(s.observed),
                                                threshold: s.threshold,
                                                sample: s.sampleSize,
                                            })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    <section className="space-y-default">
                        <h2 className="text-sm font-medium text-content-emphasis">
                            {t('reviewQuality.reviewersTitle')}
                        </h2>
                        <ul className="space-y-default">
                            {report.reviewers.map((r) => (
                                <li
                                    key={r.reviewerUserId}
                                    className="flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4"
                                >
                                    <span className="font-medium text-content-emphasis">
                                        {r.reviewerUserId}
                                    </span>
                                    <span className="text-sm text-content-muted">
                                        {r.estimates.reported
                                            ? t('reviewQuality.estimateReported', {
                                                  rate: pct(r.estimates.approvalRate),
                                                  decided: r.decided,
                                                  median: secs(r.estimates.medianSeconds),
                                                  p10: secs(r.estimates.p10Seconds),
                                              })
                                            : t('reviewQuality.estimateRefused', {
                                                  observed: r.estimates.observed,
                                                  required: r.estimates.required,
                                              })}
                                    </span>
                                    <span className="text-sm text-content-muted">
                                        {r.fastestSeconds === null
                                            ? ''
                                            : t('reviewQuality.fastest', {
                                                  seconds: secs(r.fastestSeconds),
                                              })}
                                        {r.bursts.length > 0
                                            ? ` · ${t('reviewQuality.burstCount', { count: r.bursts.length })}`
                                            : ''}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>

                    <section className="space-y-default">
                        <h2 className="text-sm font-medium text-content-emphasis">
                            {t('reviewQuality.agentsTitle')}
                        </h2>
                        <ul className="space-y-default">
                            {report.agents.map((a) => (
                                <li
                                    key={a.agentId ?? 'unattributed'}
                                    className="flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4"
                                >
                                    <span className="font-medium text-content-emphasis">
                                        {a.agentId ?? '—'}
                                    </span>
                                    <span className="text-sm text-content-muted">
                                        {a.estimates.reported
                                            ? t('reviewQuality.estimateReported', {
                                                  rate: pct(a.estimates.approvalRate),
                                                  decided: a.decided,
                                                  median: secs(a.estimates.medianSeconds),
                                                  p10: secs(a.estimates.p10Seconds),
                                              })
                                            : t('reviewQuality.estimateRefused', {
                                                  observed: a.estimates.observed,
                                                  required: a.estimates.required,
                                              })}
                                    </span>
                                    <span className="text-sm text-content-muted">
                                        {Object.entries(a.rungCounts)
                                            .map(([rung, count]) =>
                                                t('reviewQuality.rungLabel', { rung, count }),
                                            )
                                            .join(' · ')}
                                    </span>
                                    {a.secondApproverDeclared > 0 && (
                                        <span className="text-sm text-content-muted">
                                            {t('reviewQuality.secondApprover', {
                                                count: a.secondApproverDeclared,
                                            })}
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                </>
            )}
        </div>
    );
}
