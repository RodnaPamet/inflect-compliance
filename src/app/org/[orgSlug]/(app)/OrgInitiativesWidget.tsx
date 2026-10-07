'use client';

/**
 * ORG_INITIATIVES widget — portfolio security-programme tracker.
 *
 * Concept ported from Cybether (MIT). Shows the top-N in-flight
 * initiatives as ProgressCard rows (title, status, owner, target, progress
 * bar, linked-work count + tenant span), with a board-level "N in flight,
 * M at risk" headline. At-risk rows (BLOCKED or past-due) get a warning
 * tone; stale rows (IN_PROGRESS, no update in 30 days) get a muted flag.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Rocket, AlertTriangle } from 'lucide-react';

import { StatusBadge } from '@/components/ui/status-badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { InitiativeWidgetData } from '@/app-layer/usecases/org-security-initiative';

const STATUS_VARIANT: Record<string, 'neutral' | 'info' | 'warning' | 'error' | 'success'> = {
    PLANNED: 'neutral',
    IN_PROGRESS: 'info',
    BLOCKED: 'error',
    COMPLETED: 'success',
    CANCELLED: 'neutral',
};
const STATUS_LABEL_KEY: Record<string, string> = {
    PLANNED: 'widgets.statusPlanned',
    IN_PROGRESS: 'widgets.statusInProgress',
    BLOCKED: 'widgets.statusBlocked',
    COMPLETED: 'widgets.statusCompleted',
    CANCELLED: 'widgets.statusCancelled',
};

export function OrgInitiativesWidget({ data, orgSlug }: { data: InitiativeWidgetData; orgSlug: string }) {
    const t = useTranslations('org');
    return (
        <div className="flex h-full flex-col gap-tight rounded-lg bg-bg-subtle p-4" data-testid="org-initiatives-widget">
            <div className="flex items-center justify-between gap-compact flex-wrap">
                <div className="flex items-center gap-compact">
                    <Rocket className="w-5 h-5 text-content-muted" aria-hidden="true" />
                    <div>
                        <p className="text-[11px] uppercase tracking-wide text-content-muted">{t('widgets.securityInitiatives')}</p>
                        <p className="text-sm font-medium">
                            {t('widgets.inFlight', { count: data.inFlight })}
                            {data.atRisk > 0 && (
                                <span className="text-content-warning"> · {t('widgets.atRiskCount', { count: data.atRisk })}</span>
                            )}
                        </p>
                    </div>
                </div>
                <Link href={`/org/${orgSlug}/initiatives`} className="text-xs text-content-info underline hover:text-content-default">
                    {t('widgets.viewAll')}
                </Link>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto space-y-tight">
                {data.rows.length === 0 && (
                    <p className="text-sm text-content-muted">{t('widgets.initiativesEmpty')}</p>
                )}
                {data.rows.map((r) => (
                    <Link
                        key={r.id}
                        href={`/org/${orgSlug}/initiatives/${r.id}`}
                        className={
                            'block rounded-lg border p-3 space-y-tight transition-colors ' +
                            (r.atRisk ? 'border-border-warning bg-bg-warning/30' : 'border-border-subtle hover:border-border-default')
                        }
                        data-testid={`org-initiative-row-${r.id}`}
                    >
                        <div className="flex items-center justify-between gap-tight flex-wrap">
                            <span className="text-sm font-medium flex items-center gap-tight">
                                {r.atRisk && <AlertTriangle className="w-3.5 h-3.5 text-content-warning" aria-hidden="true" />}
                                {r.title}
                            </span>
                            <StatusBadge variant={STATUS_VARIANT[r.status] ?? 'neutral'} size="sm">
                                {STATUS_LABEL_KEY[r.status] ? t(STATUS_LABEL_KEY[r.status]) : r.status}
                            </StatusBadge>
                        </div>
                        <ProgressBar
                            value={r.progress.percent}
                            aria-label={t('widgets.progressAria', { title: r.title })}
                            variant={r.atRisk ? 'warning' : undefined}
                        />
                        <div className="flex items-center gap-tight flex-wrap text-xs text-content-muted">
                            <span>{r.progress.percent}%{r.progress.manual ? ' ' + t('widgets.manual') : ''}</span>
                            <span>· {t('widgets.linkedCount', { count: r.linkCount })}{r.tenantSpan > 0 ? ' ' + t('widgets.acrossTenants', { count: r.tenantSpan }) : ''}</span>
                            {r.targetDate && <span>· {t('widgets.due', { date: formatDate(new Date(r.targetDate)) })}</span>}
                            {r.stale && (
                                <span className="italic" data-testid="org-initiative-stale">· {t('widgets.recentActivityEmpty')}</span>
                            )}
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
