'use client';

/* SP-5 — SharePoint sync-health dashboard. */
import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTranslations } from 'next-intl';

interface Health {
    connections: Array<{ id: string; name: string; lastTestedAt: string | null; lastTestStatus: string | null }>;
    executions: Array<{ id: string; automationKey: string; status: string; triggeredBy: string; executedAt: string; durationMs: number | null }>;
    evidenceCoverage: { synced: number; stale: number; failed: number; total: number };
    policyLinks: number;
}

export default function SharePointHealthPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('admin');
    const [data, setData] = useState<Health | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/health'));
                if (res.ok && !cancelled) setData(await res.json());
            } catch {
                /* ignore */
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl]);

    const cov = data?.evidenceCoverage;

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('crumb.integrations'), href: tenantHref('/admin/integrations') },
                    { label: t('crumb.sharepointHealth') },
                ]}
            />
            <Heading level={1}>{t('sharepoint.healthTitle')}</Heading>

            {/* Connection strip */}
            <div className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3">
                {(data?.connections ?? []).map((c) => (
                    <Card key={c.id} className="space-y-tight p-4">
                        <div className="flex items-center gap-default">
                            <span className="font-medium text-content-default">{c.name}</span>
                            <StatusBadge variant={c.lastTestStatus === 'error' ? 'error' : 'success'}>
                                {c.lastTestStatus === 'error' ? t('sharepoint.statusError') : t('sharepoint.ok')}
                            </StatusBadge>
                        </div>
                        <p className="text-xs text-content-muted">
                            {t('sharepoint.lastTested', { date: c.lastTestedAt ? formatDateTime(c.lastTestedAt) : t('sharepoint.never') })}
                        </p>
                    </Card>
                ))}
            </div>

            {/* Coverage + policy links */}
            <div className="grid grid-cols-2 gap-default sm:grid-cols-4">
                <Card className="p-4"><KPIStat value={cov?.synced ?? 0} label={t('sharepoint.evidenceSynced')} /></Card>
                <Card className="p-4"><KPIStat value={cov?.stale ?? 0} label={t('sharepoint.stale')} /></Card>
                <Card className="p-4"><KPIStat value={cov?.failed ?? 0} label={t('sharepoint.failedKpi')} /></Card>
                <Card className="p-4"><KPIStat value={data?.policyLinks ?? 0} label={t('sharepoint.policyLinks')} /></Card>
            </div>

            {/* Recent activity */}
            <Card className="space-y-default p-6">
                <Heading level={2}>{t('sharepoint.recentActivity')}</Heading>
                {(data?.executions ?? []).length === 0 ? (
                    <p className="text-sm text-content-muted">{t('sharepoint.activityEmpty')}</p>
                ) : (
                    <ul className="divide-y divide-border-subtle">
                        {(data?.executions ?? []).map((e) => (
                            <li key={e.id} className="flex items-center gap-default py-default text-sm">
                                <span className="flex-1 truncate font-mono text-xs">{e.automationKey}</span>
                                <StatusBadge variant={e.status === 'PASSED' ? 'success' : e.status === 'FAILED' ? 'error' : 'neutral'}>
                                    {e.status}
                                </StatusBadge>
                                <span className="w-20 text-right text-xs text-content-muted">{e.triggeredBy}</span>
                                <span className="whitespace-nowrap text-right text-xs text-content-muted">{formatDateTime(e.executedAt)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
}
