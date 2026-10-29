'use client';
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@inflect/ui/components/ui/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { DataTable, createColumns } from '@/components/ui/table';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@inflect/ui/lib/cn';

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

type JobType = 'processOutbox' | 'dailySweep';

/** The three fields the PUT schema can refuse, by the path its 400 names. */
type FieldKey = 'defaultFromName' | 'defaultFromEmail' | 'complianceMailbox';
type FieldErrors = Partial<Record<FieldKey, true>>;

interface OutboxCounts { sent: number; failed: number; skipped: number }
interface SweepCounts { scanned: number; tasksCreated: number; skippedDuplicate: number }

/** A settings body is one only when it has the shape the page renders. */
function isSettings(body: unknown): body is NotificationSettings {
    const b = body as Partial<NotificationSettings> | null;
    return !!b && typeof b === 'object' && typeof b.enabled === 'boolean' && Array.isArray(b.mutedInAppTypes);
}

/** Which fields a refused PUT named, read off the validation envelope's details. */
function refusedFields(body: unknown): FieldErrors {
    const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
    const out: FieldErrors = {};
    if (!Array.isArray(details)) return out;
    for (const d of details) {
        const field = (d as { path?: unknown[] })?.path?.[0];
        if (field === 'defaultFromName' || field === 'defaultFromEmail' || field === 'complianceMailbox') {
            out[field] = true;
        }
    }
    return out;
}

export default function NotificationSettingsPage() {
    const t = useTranslations('admin');
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [tab, setTab] = useState<'settings' | 'stats'>('settings');
    // `settings` is the form; `savedSettings` is what the server last confirmed.
    // The header badge reads the second, so it never reports an unsaved switch.
    const [settings, setSettings] = useState<NotificationSettings | null>(null);
    const [savedSettings, setSavedSettings] = useState<NotificationSettings | null>(null);
    const [inAppTypes, setInAppTypes] = useState<InAppNotificationType[]>([]);
    const [stats, setStats] = useState<OutboxStats | null>(null);
    // `null` = no failure. A string — possibly empty, when the server gave no
    // reason — means the load failed, and the page says so instead of waiting.
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [runningJob, setRunningJob] = useState<JobType | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [jobToConfirm, setJobToConfirm] = useState<JobType>('processOutbox');

    // A promise chain rather than `async`/`await`: every state update then sits
    // in a callback, which is what the effect below may legitimately trigger.
    const fetchData = useCallback(() =>
        fetch(apiUrl('/notification-settings'))
            .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => null) }))
            .then(({ ok, data }) => {
                if (!ok || !isSettings(data?.settings)) {
                    setLoadError(apiErrorMessage(data, ''));
                    return;
                }
                setSettings(data.settings);
                setSavedSettings(data.settings);
                // Whatever the server lists — never a client-side literal, so
                // a future agentic type appears here with no edit to this file.
                setInAppTypes(data.inAppTypes ?? []);
                setStats(data.stats ?? null);
            })
            .catch(() => setLoadError('')),
    [apiUrl]);

    useEffect(() => { void fetchData(); }, [fetchData]);

    /**
     * Refresh the send stats after a job. Stats only: re-reading the settings
     * here would throw away edits the operator has not saved yet.
     */
    const refreshStats = useCallback(async () => {
        try {
            const r = await fetch(apiUrl('/notification-settings'));
            const data = await r.json().catch(() => null);
            if (r.ok && data?.stats) setStats(data.stats);
        } catch {
            // The job's own result has already been shown; stale stats are not
            // worth a second message.
        }
    }, [apiUrl]);

    function askToRunJob(jobType: JobType) {
        setJobToConfirm(jobType);
        setConfirmOpen(true);
    }

    async function runJob(jobType: JobType) {
        setRunningJob(jobType);
        try {
            const res = await fetch(apiUrl('/notification-settings/run-job'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobType }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                toast.error(apiErrorMessage(data, t('notifications.triggerFailed')));
                return;
            }
            if (jobType === 'processOutbox') {
                const o = (data?.stats ?? {}) as Partial<OutboxCounts>;
                toast.success(t('notifications.outboxResultTitle'), {
                    description: t('notifications.outboxResult', {
                        sent: o.sent ?? 0, failed: o.failed ?? 0, skipped: o.skipped ?? 0,
                    }),
                });
            } else {
                const sweeps = (data?.stats?.sweeps ?? {}) as Record<string, Partial<SweepCounts>>;
                const sum = (k: keyof SweepCounts) =>
                    Object.values(sweeps).reduce((n, s) => n + (s?.[k] ?? 0), 0);
                const o = (data?.stats?.outbox ?? {}) as Partial<OutboxCounts>;
                toast.success(t('notifications.sweepResultTitle'), {
                    description: t('notifications.sweepResult', {
                        tasks: sum('tasksCreated'), duplicates: sum('skippedDuplicate'),
                        sent: o.sent ?? 0, failed: o.failed ?? 0, skipped: o.skipped ?? 0,
                    }),
                });
            }
            void refreshStats();
        } catch {
            toast.error(t('notifications.triggerFailed'));
        } finally {
            setRunningJob(null);
        }
    }

    async function handleSave() {
        if (!settings) return;
        setSaving(true);
        setSaved(false);
        setSaveError(null);
        setFieldErrors({});
        try {
            const res = await fetch(apiUrl('/notification-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            const body = await res.json().catch(() => null);
            // A refused save keeps the form as the operator left it. The body
            // of a 400 is the error envelope, never settings, so it must not
            // reach `setSettings` — it used to, and the next render read
            // `mutedInAppTypes` off it and crashed the page.
            if (!res.ok || !isSettings(body)) {
                setFieldErrors(refusedFields(body));
                setSaveError(apiErrorMessage(body, ''));
                return;
            }
            setSettings(body);
            setSavedSettings(body);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch {
            setSaveError('');
        } finally {
            setSaving(false);
        }
    }

    const header = (
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
    );

    // One page, one H1, whichever state the page is in.
    const title = <Heading level={1}>{t('notifications.title')}</Heading>;

    if (loadError !== null) {
        return (
            <div className="space-y-section animate-fadeIn">
                <BackAffordance />
                {header}
                {title}
                <ErrorState
                    title={t('notifications.loadFailed')}
                    description={loadError || undefined}
                    onRetry={() => { setLoadError(null); void fetchData(); }}
                    data-testid="notification-settings-load-error"
                />
            </div>
        );
    }

    if (!settings || !savedSettings) return <div className="p-8"><div className="h-6 w-full sm:w-48 bg-bg-elevated rounded animate-pulse" /></div>;

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            {header}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-default">
                <div className="flex flex-wrap items-center gap-compact">
                    {title}
                    <StatusBadge
                        variant={savedSettings.enabled ? 'success' : 'warning'}
                        data-testid="notifications-email-status"
                    >
                        {savedSettings.enabled ? t('notifications.enabled') : t('notifications.disabled')}
                    </StatusBadge>
                </div>
                <div className="flex items-center gap-compact">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => askToRunJob('processOutbox')}
                        disabled={!!runningJob}
                        loading={runningJob === 'processOutbox'}
                        className="rounded-full"
                    >
                        {runningJob === 'processOutbox' ? t('notifications.sending') : t('notifications.processOutbox')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => askToRunJob('dailySweep')}
                        disabled={!!runningJob}
                        loading={runningJob === 'dailySweep'}
                        className="rounded-full"
                    >
                        {runningJob === 'dailySweep' ? t('notifications.running') : t('notifications.dailySweep')}
                    </Button>
                </div>
            </div>

            <ConfirmDialog
                showModal={confirmOpen}
                setShowModal={setConfirmOpen}
                tone="info"
                title={jobToConfirm === 'processOutbox'
                    ? t('notifications.runOutboxConfirmTitle')
                    : t('notifications.runSweepConfirmTitle')}
                description={jobToConfirm === 'processOutbox'
                    ? t('notifications.runOutboxConfirmBody')
                    : t('notifications.runSweepConfirmBody')}
                confirmLabel={jobToConfirm === 'processOutbox'
                    ? t('notifications.runOutboxConfirm')
                    : t('notifications.runSweepConfirm')}
                onConfirm={() => runJob(jobToConfirm)}
            />

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
                    {/* Enable / Disable — email only; the help text names
                        exactly which emails it stops and which it never does. */}
                    <div className="space-y-tight">
                        <div className="flex items-center gap-compact">
                            <Switch
                                id="notifications-email-enabled"
                                checked={settings.enabled}
                                onCheckedChange={(on) => setSettings({ ...settings, enabled: on })}
                                aria-describedby="notifications-email-enabled-help"
                            />
                            <Label htmlFor="notifications-email-enabled">{t('notifications.enableToggle')}</Label>
                        </div>
                        <p id="notifications-email-enabled-help" className="text-xs text-content-subtle">
                            {t('notifications.enableToggleHelp')}
                        </p>
                    </div>

                    <FormField
                        label={t('notifications.senderName')}
                        required
                        error={fieldErrors.defaultFromName ? t('notifications.senderNameInvalid') : undefined}
                        className="max-w-md"
                    >
                        <Input
                            id="notifications-sender-name"
                            type="text"
                            value={settings.defaultFromName}
                            onChange={e => setSettings({ ...settings, defaultFromName: e.target.value })}
                            placeholder={t('notifications.senderNamePlaceholder')}
                        />
                    </FormField>

                    <FormField
                        label={t('notifications.senderEmail')}
                        required
                        description={t('notifications.senderNote')}
                        error={fieldErrors.defaultFromEmail ? t('notifications.emailInvalid') : undefined}
                        className="max-w-md"
                    >
                        <Input
                            id="notifications-sender-email"
                            type="email"
                            value={settings.defaultFromEmail}
                            onChange={e => setSettings({ ...settings, defaultFromEmail: e.target.value })}
                            placeholder={t('notifications.senderEmailPlaceholder')}
                        />
                    </FormField>

                    <FormField
                        label={t('notifications.complianceMailbox')}
                        description={t('notifications.bccNote')}
                        error={fieldErrors.complianceMailbox ? t('notifications.emailInvalid') : undefined}
                        className="max-w-md"
                    >
                        <Input
                            id="notifications-compliance-mailbox"
                            type="email"
                            value={settings.complianceMailbox || ''}
                            onChange={e => setSettings({ ...settings, complianceMailbox: e.target.value || null })}
                            placeholder={t('notifications.compliancePlaceholder')}
                        />
                    </FormField>

                    {/* In-app (bell + SSE) preferences — #2564.
                        Separate from the `enabled` toggle above, which is
                        email-only: every reader of that flag is an email
                        path, so one switch cannot mean both. */}
                    <div
                        className="border-t border-border-subtle pt-default"
                        data-testid="in-app-notification-types"
                    >
                        <p className="block text-xs text-content-muted mb-1">{t('notifications.inAppTitle')}</p>
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
                                    const switchId = `in-app-type-switch-${info.type}`;
                                    return (
                                        <div key={info.type} className="flex items-center gap-compact">
                                            <Switch
                                                id={switchId}
                                                checked={!muted}
                                                aria-label={t('notifications.inAppToggleAria', { type: info.title })}
                                                data-testid={`in-app-type-${info.type}`}
                                                onCheckedChange={(on) => setSettings({
                                                    ...settings,
                                                    mutedInAppTypes: on
                                                        ? settings.mutedInAppTypes.filter(x => x !== info.type)
                                                        : [...settings.mutedInAppTypes, info.type],
                                                })}
                                            />
                                            <Label htmlFor={switchId} className="text-sm font-normal">{info.title}</Label>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Save */}
                    <div className="flex flex-wrap items-center gap-compact pt-2">
                        <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
                            {saving ? t('notifications.saving') : t('notifications.saveSettings')}
                        </Button>
                        {saved && <span className="text-sm text-content-success">{t('notifications.savedSuccess')}</span>}
                        {saveError !== null && (
                            <span role="alert" className="text-sm text-content-error" data-testid="notification-settings-save-error">
                                {t('notifications.saveFailed')}
                                {saveError ? ` ${saveError}` : ''}
                            </span>
                        )}
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
                                // Three fixed summary rows with no bulk action.
                                selectionEnabled={false}
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
