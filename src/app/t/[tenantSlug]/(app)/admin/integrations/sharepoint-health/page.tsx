'use client';

/*
 * SP-5 — SharePoint sync-health dashboard.
 *
 * #4873 — it has to tell healthy from never tested from switched off from
 * failed to load, and its figures have to lead to the files they count:
 *   • a connection reads OK only when its last test passed; never tested and
 *     disabled say so;
 *   • a failed read is an error, not four zeros and "no activity yet";
 *   • with no connection the page says SharePoint is not connected;
 *   • each run is named in words, and Stale and Failed are explained and
 *     listed by document.
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTranslations } from 'next-intl';
import { InlineNotice } from '@/components/ui/inline-notice';
import { apiErrorMessage } from '@/lib/api-error';
/**
 * The health route's answer (`getSharePointHealth`). Declared here rather than
 * imported, so this client page's import graph never reaches the server module.
 */
interface Connection {
    id: string;
    name: string;
    isEnabled: boolean;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
}
interface Health {
    connections: Connection[];
    executions: Array<{ id: string; automationKey: string; status: string; triggeredBy: string; executedAt: string; durationMs: number | null }>;
    evidenceCoverage: { synced: number; stale: number; failed: number; total: number };
    problems: Array<{
        mappingId: string;
        status: 'STALE' | 'FAILED';
        evidenceId: string | null;
        evidenceTitle: string | null;
        errorMessage: string | null;
        lastSyncedAt: string | null;
    }>;
    problemsTotal: number;
    policyLinks: number;
}

const RUN_STATUSES = ['PASSED', 'FAILED', 'ERROR', 'RUNNING', 'PENDING', 'NOT_APPLICABLE', 'PARTIAL'] as const;
const TRIGGERS = ['manual', 'scheduled', 'schedule', 'webhook', 'user'] as const;
const RUN_KINDS = ['audit_pack_export'] as const;

function known<T extends string>(list: readonly T[], value: string | null): value is T {
    return value !== null && (list as readonly string[]).includes(value);
}

/** OK only for a connection whose last test passed. */
function connectionState(c: Connection): 'disabled' | 'never' | 'error' | 'ok' {
    if (!c.isEnabled) return 'disabled';
    if (!c.lastTestedAt || c.lastTestStatus === null) return 'never';
    return c.lastTestStatus === 'ok' ? 'ok' : 'error';
}

const STATE_VARIANT = { disabled: 'neutral', never: 'neutral', error: 'error', ok: 'success' } as const;

export default function SharePointHealthPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('admin');
    const [data, setData] = useState<Health | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/health'));
                if (cancelled) return;
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    if (!cancelled) setLoadError(apiErrorMessage(body, t('sharepoint.healthLoadError')));
                    return;
                }
                const body = (await res.json()) as Health;
                if (!cancelled) setData(body);
            } catch {
                if (!cancelled) setLoadError(t('sharepoint.healthLoadError'));
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl, t]);

    const cov = data?.evidenceCoverage;
    const runLabel = (automationKey: string): string => {
        const part = automationKey.includes('.') ? automationKey.slice(automationKey.indexOf('.') + 1) : automationKey;
        return known(RUN_KINDS, part) ? t(`sharepoint.runKind.${part}`) : automationKey;
    };

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('crumb.integrations'), href: tenantHref('/admin/integrations') },
                    { label: t('crumb.sharepointHealth') },
                ]}
            />
            <Heading level={1}>{t('sharepoint.healthTitle')}</Heading>

            {loadError ? (
                <InlineNotice variant="error" id="sharepoint-health-error">{loadError}</InlineNotice>
            ) : !data ? (
                <p className="text-sm text-content-subtle">{t('sharepoint.healthLoading')}</p>
            ) : data.connections.length === 0 ? (
                <InlineNotice variant="info" id="sharepoint-health-not-connected">
                    {t('sharepoint.notConnected')}{' '}
                    <Link href={tenantHref('/admin/integrations')} className="font-medium text-content-info hover:underline">
                        {t('crumb.integrations')}
                    </Link>
                </InlineNotice>
            ) : (
                <>
                    {/* Connection strip */}
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3">
                        {data.connections.map((c) => {
                            const state = connectionState(c);
                            return (
                                <Card key={c.id} className="space-y-tight p-4" data-testid={`sharepoint-connection-${c.id}`}>
                                    <div className="flex items-center gap-default">
                                        <span className="font-medium text-content-default">{c.name}</span>
                                        <StatusBadge variant={STATE_VARIANT[state]} data-state={state}>
                                            {t(`sharepoint.connectionState.${state}`)}
                                        </StatusBadge>
                                    </div>
                                    <p className="text-xs text-content-muted">
                                        {t('sharepoint.lastTested', { date: c.lastTestedAt ? formatDateTime(c.lastTestedAt) : t('sharepoint.never') })}
                                    </p>
                                </Card>
                            );
                        })}
                    </div>

                    {/* Coverage + policy links */}
                    <div className="grid grid-cols-2 gap-default sm:grid-cols-4">
                        <Card className="p-4"><KPIStat value={cov?.synced ?? 0} label={t('sharepoint.evidenceSynced')} /></Card>
                        <Card className="space-y-tight p-4">
                            <KPIStat value={cov?.stale ?? 0} label={t('sharepoint.stale')} />
                            <p className="text-xs text-content-muted">{t('sharepoint.staleHint')}</p>
                        </Card>
                        <Card className="space-y-tight p-4">
                            <KPIStat value={cov?.failed ?? 0} label={t('sharepoint.failedKpi')} />
                            <p className="text-xs text-content-muted">{t('sharepoint.failedHint')}</p>
                        </Card>
                        <Card className="p-4"><KPIStat value={data.policyLinks} label={t('sharepoint.policyLinks')} /></Card>
                    </div>

                    {/* The documents behind Stale and Failed. */}
                    {data.problems.length > 0 && (
                        <Card className="space-y-default p-6" id="sharepoint-health-problems">
                            <Heading level={2}>{t('sharepoint.problemsTitle')}</Heading>
                            <ul className="divide-y divide-border-subtle">
                                {data.problems.map((p) => (
                                    <li key={p.mappingId} className="flex flex-wrap items-center gap-default py-default text-sm">
                                        <StatusBadge variant={p.status === 'FAILED' ? 'error' : 'warning'}>
                                            {p.status === 'FAILED' ? t('sharepoint.failedKpi') : t('sharepoint.stale')}
                                        </StatusBadge>
                                        <span className="flex-1">
                                            {p.evidenceId ? (
                                                <Link href={tenantHref(`/evidence?ev=${p.evidenceId}`)} className="font-medium text-content-info hover:underline">
                                                    {p.evidenceTitle}
                                                </Link>
                                            ) : (
                                                <span className="text-content-muted">{t('sharepoint.problemNoEvidence')}</span>
                                            )}
                                            {p.errorMessage && (
                                                <span className="block text-xs text-content-muted">{p.errorMessage}</span>
                                            )}
                                        </span>
                                        {p.lastSyncedAt && (
                                            <span className="whitespace-nowrap text-xs text-content-muted">{formatDateTime(p.lastSyncedAt)}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {data.problemsTotal > data.problems.length && (
                                <p className="text-xs text-content-muted" id="sharepoint-health-problems-more">
                                    {t('sharepoint.problemsMore', { shown: data.problems.length, total: data.problemsTotal })}
                                </p>
                            )}
                        </Card>
                    )}

                    {/* Recent activity */}
                    <Card className="space-y-default p-6">
                        <Heading level={2}>{t('sharepoint.recentActivity')}</Heading>
                        {data.executions.length === 0 ? (
                            <p className="text-sm text-content-muted">{t('sharepoint.activityEmpty')}</p>
                        ) : (
                            <ul className="divide-y divide-border-subtle">
                                {data.executions.map((e) => (
                                    <li key={e.id} className="flex items-center gap-default py-default text-sm">
                                        <span className="flex-1 truncate">{runLabel(e.automationKey)}</span>
                                        <StatusBadge variant={e.status === 'PASSED' ? 'success' : e.status === 'FAILED' || e.status === 'ERROR' ? 'error' : e.status === 'PARTIAL' ? 'warning' : 'neutral'}>
                                            {known(RUN_STATUSES, e.status) ? t(`sharepoint.runStatus.${e.status}`) : e.status}
                                        </StatusBadge>
                                        <span className="w-20 text-right text-xs text-content-muted">
                                            {known(TRIGGERS, e.triggeredBy) ? t(`sharepoint.trigger.${e.triggeredBy}`) : e.triggeredBy}
                                        </span>
                                        <span className="whitespace-nowrap text-right text-xs text-content-muted">{formatDateTime(e.executedAt)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Card>
                </>
            )}
        </div>
    );
}
