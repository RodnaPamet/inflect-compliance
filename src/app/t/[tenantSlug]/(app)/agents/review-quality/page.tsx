import { PageHeader } from '@/components/layout/PageHeader';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { getTenantCtx } from '@/app-layer/context';
import { computeAgentReviewQuality } from '@/app-layer/usecases/agent-review-quality';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/**
 * REVIEW QUALITY — the surface for "do these approvals mean anything?".
 *
 * A sibling of `/agents` (which agents may act) and `/agents/proposals` (what
 * they proposed). This page is about the HUMANS: how fast they decide, how
 * often they say no, and whether a run of approvals was one act rather than
 * many.
 *
 * ── REACHABILITY AND THE GATE, BOTH NEW (#2428) ─────────────────────────────
 *
 * This page shipped with ZERO inbound links — no nav entry, no hub card, no row
 * action — no permission gate of its own, and no behavioural test. That is the
 * exact combination that shipped the unreachable agent detail page, and it was
 * here twice over. Both halves are fixed: it is the "Review quality" entry in
 * the agents ViewsMenu, and the gate below is its own rather than an ancestor
 * layout's.
 *
 * `admin.agent_registry` — the same key the endpoint behind the same data has
 * always carried, so the page and its data agree.
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
    const t = await getTranslations('admin');
    const tAgents = await getTranslations('agents');

    if (!ctx.appPermissions.admin.agent_registry) {
        return (
            <ForbiddenPage
                title={tAgents('reviewQuality.accessTitle')}
                message={tAgents('reviewQuality.accessMessage')}
            />
        );
    }

    // AFTER the gate: computing the report writes an alert row when an
    // outstanding pattern is found, so a refused caller must not reach it.
    const report = await computeAgentReviewQuality(ctx);

    const pct = (rate: number) => Math.round(rate * 100);
    const secs = (n: number) => Math.round(n * 10) / 10;

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: tAgents('register.breadcrumb'), href: tenantHref('/agents') },
                    { label: t('crumb.reviewQuality') },
                ]}
                title={t('reviewQuality.title')}
                description={t('reviewQuality.pageDesc')}
                actions={
                    <AgentsViewsMenu
                        current="review-quality"
                        tenantSlug={tenantSlug}
                        canReviewProposals={ctx.appPermissions.admin.view}
                        canInvestigate
                    />
                }
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
                <Heading level={3} as="h2">
                    {t('reviewQuality.unobservableTitle')}
                </Heading>
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
                        <Heading level={3} as="h2">
                            {t('reviewQuality.signalsTitle')}
                        </Heading>
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
                        <Heading level={3} as="h2">
                            {t('reviewQuality.reviewersTitle')}
                        </Heading>
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
                        <Heading level={3} as="h2">
                            {t('reviewQuality.agentsTitle')}
                        </Heading>
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
