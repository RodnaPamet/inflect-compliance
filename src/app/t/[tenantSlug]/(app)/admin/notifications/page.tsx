'use client';
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DataTable, createColumns } from '@/components/ui/table';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface NotificationSettings {
    enabled: boolean;
    defaultFromName: string;
    defaultFromEmail: string;
    complianceMailbox: string | null;
    /** In-app types this workspace has switched off (#2564). */
    mutedInAppTypes: string[];
}

/**
 * One toggle-able in-app type, as the SERVER lists it.
 *
 * `title` arrives from the emitter's own copy rather than from `messages/`,
 * and that asymmetry is deliberate — see `listInAppNotificationTypes`. The
 * bell's rows are written at emit time and stored, so a translated label here
 * would promise a Bulgarian bell the emitter does not deliver.
 */
interface InAppNotificationType {
    type: string;
    title: string;
    muted: boolean;
}

interface OutboxStats {
    last24h: { pending: number; sent: number; failed: number };
    last7d: { pending: number; sent: number; failed: number };
    last30d: { pending: number; sent: number; failed: number };
}

export default function NotificationSettingsPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [tab, setTab] = useState<'settings' | 'stats'>('settings');
    const [settings, setSettings] = useState<NotificationSettings | null>(null);
    const [inAppTypes, setInAppTypes] = useState<InAppNotificationType[]>([]);
    const [stats, setStats] = useState<OutboxStats | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [runningJob, setRunningJob] = useState<'processOutbox' | 'dailySweep' | null>(null);

    const fetchData = useCallback(() => {
        fetch(apiUrl('/notification-settings'))
            .then(r => r.json())
            .then(data => {
                setSettings(data.settings);
                // Whatever the server lists — never a client-side literal, so
                // a future agentic type appears here with no edit to this file.
                setInAppTypes(data.inAppTypes ?? []);
                setStats(data.stats);
            })
            .catch(console.error);
    }, [apiUrl]);

    useEffect(() => { fetchData(); }, [fetchData]);

    async function handleRunJob(jobType: 'processOutbox' | 'dailySweep') {
        if (!confirm(t('notifications.runJobConfirm', { jobType }))) return;
        setRunningJob(jobType);
        try {
            const res = await fetch(apiUrl('/notification-settings/run-job'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobType }),
            });
            const data = await res.json();
            if (res.ok) {
                alert(t('notifications.successMsg', { message: data.message }) + '\n' + JSON.stringify(data.stats, null, 2));
                fetchData(); // Refresh stats
            } else {
                alert(t('notifications.errorMsg', { error: data.error || t('notifications.triggerFailed') }));
            }
        } finally {
            setRunningJob(null);
        }
    }

    async function handleSave() {
        if (!settings) return;
        setSaving(true);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/notification-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            const updated = await res.json();
            setSettings(updated);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } finally {
            setSaving(false);
        }
    }

    if (!settings) return <div className="p-8"><div className="h-6 w-full sm:w-48 bg-bg-elevated rounded animate-pulse" /></div>;

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('crumb.notifications') },
                    ]}
                    className="mb-1"
                />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-default">
                <div className="flex flex-wrap items-center gap-compact">
                    <Heading level={1}>{t('notifications.title')}</Heading>
                    <StatusBadge variant={settings.enabled ? 'success' : 'warning'}>
                        {settings.enabled ? t('notifications.enabled') : t('notifications.disabled')}
                    </StatusBadge>
                </div>
                <div className="flex items-center gap-compact">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRunJob('processOutbox')}
                        disabled={!!runningJob}
                        loading={runningJob === 'processOutbox'}
                        className="rounded-full"
                    >
                        {runningJob === 'processOutbox' ? t('notifications.sending') : t('notifications.processOutbox')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRunJob('dailySweep')}
                        disabled={!!runningJob}
                        loading={runningJob === 'dailySweep'}
                        className="rounded-full"
                    >
                        {runningJob === 'dailySweep' ? t('notifications.running') : t('notifications.dailySweep')}
                    </Button>
                </div>
            </div>

            {/* Epic 60 — ToggleGroup replaces hand-rolled tab bar. */}
            <ToggleGroup
                ariaLabel={t('notifications.viewAria')}
                options={[
                    { value: 'settings', label: t('notifications.tabSettings') },
                    { value: 'stats', label: t('notifications.tabStats') },
                ]}
                selected={tab}
                selectAction={(v) => setTab(v as 'settings' | 'stats')}
            />

            {tab === 'settings' ? (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    {/* Enable / Disable */}
                    <label className="flex items-center gap-compact cursor-pointer">
                        <input
                            type="checkbox"
                            checked={settings.enabled}
                            onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
                            className="toggle toggle-brand"
                        />
                        <span className="text-sm font-medium">{t('notifications.enableToggle')}</span>
                    </label>

                    {/* From Name */}
                    <div>
                        <label className="block text-xs text-content-muted mb-1">{t('notifications.senderName')}</label>
                        <input
                            type="text"
                            value={settings.defaultFromName}
                            onChange={e => setSettings({ ...settings, defaultFromName: e.target.value })}
                            className="input input-bordered w-full max-w-md"
                            placeholder="Inflect Compliance"
                        />
                    </div>

                    {/* From Email */}
                    <div>
                        <label className="block text-xs text-content-muted mb-1">{t('notifications.senderEmail')}</label>
                        <input
                            type="email"
                            value={settings.defaultFromEmail}
                            onChange={e => setSettings({ ...settings, defaultFromEmail: e.target.value })}
                            className="input input-bordered w-full max-w-md"
                            placeholder="noreply@inflect.app"
                        />
                    </div>

                    {/* Compliance Mailbox */}
                    <div>
                        <label className="block text-xs text-content-muted mb-1">{t('notifications.complianceMailbox')}</label>
                        <input
                            type="email"
                            value={settings.complianceMailbox || ''}
                            onChange={e => setSettings({ ...settings, complianceMailbox: e.target.value || null })}
                            className="input input-bordered w-full max-w-md"
                            placeholder={t('notifications.compliancePlaceholder')}
                        />
                        <p className="text-xs text-content-subtle mt-1">{t('notifications.bccNote')}</p>
                    </div>

                    {/* In-app (bell + SSE) preferences — #2564.
                        Separate from the `enabled` toggle above, which is
                        email-only: every reader of that flag is an outbox or
                        digest path, so one switch cannot mean both. */}
                    <div
                        className="border-t border-border-subtle pt-default"
                        data-testid="in-app-notification-types"
                    >
                        <label className="block text-xs text-content-muted mb-1">{t('notifications.inAppTitle')}</label>
                        <p className="text-xs text-content-subtle mb-2">{t('notifications.inAppDescription')}</p>
                        {inAppTypes.length === 0 ? (
                            <p className="text-sm text-content-muted">{t('notifications.inAppEmpty')}</p>
                        ) : (
                            <div className="space-y-compact">
                                {inAppTypes.map(info => {
                                    // Read the CHECKED state off `settings`, not off
                                    // `info.muted`. The catalogue is fetched once; the mute
                                    // list is what the save round-trip returns, so deriving
                                    // from it keeps one source of truth and leaves the
                                    // toggle correct after a save.
                                    const muted = settings.mutedInAppTypes.includes(info.type);
                                    return (
                                        <label
                                            key={info.type}
                                            className="flex items-center gap-compact cursor-pointer"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={!muted}
                                                aria-label={t('notifications.inAppToggleAria', { type: info.title })}
                                                data-testid={`in-app-type-${info.type}`}
                                                onChange={e => setSettings({
                                                    ...settings,
                                                    mutedInAppTypes: e.target.checked
                                                        ? settings.mutedInAppTypes.filter(x => x !== info.type)
                                                        : [...settings.mutedInAppTypes, info.type],
                                                })}
                                                className="toggle toggle-brand"
                                            />
                                            <span className="text-sm">{info.title}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Save */}
                    <div className="flex items-center gap-compact pt-2">
                        <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
                            {saving ? t('notifications.saving') : t('notifications.saveSettings')}
                        </Button>
                        {saved && <span className="text-sm text-content-success">{t('notifications.savedSuccess')}</span>}
                    </div>
                </div>
            ) : (
                /* R13-PR6 — outer `cardVariants()` wrapper dropped
                   so the DataTable primitive's own bordered card is
                   the only one (matches Controls list visually). */
                <div>
                    {stats ? (() => {
                        const statsColumns = createColumns<{ label: string; pending: number; sent: number; failed: number; total: number }>([
                            { accessorKey: 'label', header: t('notifications.colPeriod'), cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> },
                            { accessorKey: 'pending', header: t('notifications.colPending'), cell: ({ getValue }) => <StatusBadge variant="warning">{getValue()}</StatusBadge> },
                            { accessorKey: 'sent', header: t('notifications.colSent'), cell: ({ getValue }) => <StatusBadge variant="success">{getValue()}</StatusBadge> },
                            { accessorKey: 'failed', header: t('notifications.colFailed'), cell: ({ getValue }) => <StatusBadge variant="error">{getValue()}</StatusBadge> },
                            { accessorKey: 'total', header: t('notifications.colTotal'), cell: ({ getValue }) => <span className="text-content-muted">{getValue()}</span> },
                        ]);
                        const statsData = [
                            { label: t('notifications.last24h'), ...stats.last24h, total: stats.last24h.pending + stats.last24h.sent + stats.last24h.failed },
                            { label: t('notifications.last7d'), ...stats.last7d, total: stats.last7d.pending + stats.last7d.sent + stats.last7d.failed },
                            { label: t('notifications.last30d'), ...stats.last30d, total: stats.last30d.pending + stats.last30d.sent + stats.last30d.failed },
                        ];
                        return (
                            <DataTable
                                data={statsData}
                                columns={statsColumns}
                                getRowId={(r) => r.label}
                                emptyState={t('notifications.emptyStats')}
                                resourceName={(p) => p ? t('notifications.resourcePlural') : t('notifications.resourceSingular')}
                                data-testid="notification-stats-table"
                            />
                        );
                    })() : (
                        <p className="text-content-muted"><span className="inline-block h-4 w-full sm:w-32 bg-bg-elevated rounded animate-pulse" /></p>
                    )}
                </div>
            )}
        </div>
    );
}
