'use client';

/* RQ-10 — Risk reports: templates → generate, recent runs → download.
 * PR-L — surface the (previously UI-less) schedule backend: create / list /
 * activate-deactivate / delete schedules, a new-custom-template form, and the
 * RISK_DEEP_DIVE single-risk scope (parameters.riskId). */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { FormField } from '@/components/ui/form-field';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { formatDateTime } from '@/lib/format-date';
import { useTranslations } from 'next-intl';
import type { KeyedMutator } from 'swr';
import { useToast } from '@/components/ui/hooks/use-toast';
import { useToastWithUndo } from '@/components/ui/hooks';
import { RiskPicker } from '../_shared/RiskPicker';
import { AnalyticsState } from '../_shared/AnalyticsState';

interface Template { id: string; name: string; description: string | null; type: string }
interface Run { id: string; format: string; status: string; createdAt: string; templateId: string }
interface Schedule {
    id: string; templateId: string; cadence: string; format: string; isActive: boolean;
    recipientsJson: string[] | null; nextRunAt: string | null; lastRunAt: string | null;
}

const CADENCES = ['WEEKLY', 'MONTHLY', 'QUARTERLY'] as const;

export default function RiskReportsPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const reportsQuery = useTenantSWR<{ templates: Template[]; reports: Run[] }>('/risks/reports');
    const schedulesQuery = useTenantSWR<{ schedules: Schedule[] }>('/risks/reports/schedules');
    const templates = reportsQuery.data?.templates ?? [];
    const reports = reportsQuery.data?.reports ?? [];
    const schedules = schedulesQuery.data?.schedules ?? [];
    const toast = useToast();
    // Per-row generate state (item 2): the template id whose request is in
    // flight, so only the clicked row shows "generating…" + disables.
    const [generatingId, setGeneratingId] = useState<string | null>(null);

    // RISK_DEEP_DIVE single-risk scope (per template row).
    const [deepDiveRisk, setDeepDiveRisk] = useState<Record<string, string | null>>({});

    const isDeepDive = (tpl: Template) => tpl.type === 'RISK_DEEP_DIVE';

    const generate = async (tpl: Template, format: 'PDF' | 'CSV' | 'PPTX') => {
        setGeneratingId(tpl.id);
        try {
            const riskId = isDeepDive(tpl) ? deepDiveRisk[tpl.id] ?? undefined : undefined;
            const res = await fetch(apiUrl('/risks/reports'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateId: tpl.id, format, ...(riskId ? { parameters: { riskId } } : {}) }),
            });
            if (!res.ok) throw new Error('Failed to generate report');
            await reportsQuery.mutate();
            toast.success(t('reports.generateSuccess', { format }));
        } catch {
            toast.error(t('reports.generateFailed'));
        } finally { setGeneratingId(null); }
    };

    const nameOf = (id: string) => templates.find((tpl) => tpl.id === id)?.name ?? '—';
    const statusVariant = (s: string) => (s === 'COMPLETED' ? 'success' : s === 'FAILED' ? 'error' : 'info');

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('reports.breadcrumb') }]} />
            <Heading level={1}>{t('reports.title')}</Heading>

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('reports.templates')}</Heading>
                <ul className="divide-y divide-border-subtle">
                    {templates.map((tpl) => (
                        <li key={tpl.id} className="flex flex-wrap items-center gap-default py-default text-sm">
                            <div className="flex-1 min-w-[12rem]">
                                <div className="font-medium text-content-emphasis">{tpl.name}</div>
                                {tpl.description && <div className="text-xs text-content-muted">{tpl.description}</div>}
                                {isDeepDive(tpl) && (
                                    <div className="mt-tight max-w-xs">
                                        <RiskPicker
                                            id={`deepdive-risk-${tpl.id}`}
                                            value={deepDiveRisk[tpl.id] ?? null}
                                            onChange={(id) => setDeepDiveRisk((prev) => ({ ...prev, [tpl.id]: id }))}
                                            allowNone
                                            noneLabel={t('reports.deepDiveAll')}
                                            placeholder={t('reports.deepDiveScope')}
                                        />
                                    </div>
                                )}
                            </div>
                            <Button size="sm" variant="primary" onClick={() => generate(tpl, 'PDF')} disabled={generatingId === tpl.id}>{t('reports.generatePdf')}</Button>
                            <Button size="sm" variant="secondary" onClick={() => generate(tpl, 'PPTX')} disabled={generatingId === tpl.id}>PPTX</Button>
                            <Button size="sm" variant="secondary" onClick={() => generate(tpl, 'CSV')} disabled={generatingId === tpl.id}>CSV</Button>
                            {generatingId === tpl.id && (
                                <span className="text-xs text-content-muted" data-testid={`generating-${tpl.id}`}>{t('reports.generating')}</span>
                            )}
                        </li>
                    ))}
                </ul>
                <NewTemplateForm apiUrl={apiUrl} onCreated={() => reportsQuery.mutate()} t={t} />
            </Card>

            {/* PR-L — scheduled delivery (was fully backend, zero UI). */}
            <SchedulesCard
                apiUrl={apiUrl}
                templates={templates}
                schedules={schedules}
                loading={schedulesQuery.isLoading}
                error={schedulesQuery.error}
                mutate={schedulesQuery.mutate}
                nameOf={nameOf}
                t={t}
            />

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('reports.recent')}</Heading>
                <AnalyticsState
                    isLoading={reportsQuery.isLoading}
                    error={reportsQuery.error}
                    isEmpty={reports.length === 0}
                    emptyText={t('reports.empty')}
                    errorText={t('reports.loadError')}
                >
                    <ul className="divide-y divide-border-subtle">
                        {reports.map((r) => (
                            <li key={r.id} className="flex flex-wrap items-center gap-default py-default text-sm">
                                <span className="text-content-muted">{formatDateTime(r.createdAt)}</span>
                                <span className="font-medium text-content-emphasis">{nameOf(r.templateId)}</span>
                                <span className="font-mono text-xs text-content-subtle">{r.format}</span>
                                <StatusBadge variant={statusVariant(r.status)}>{r.status}</StatusBadge>
                                {r.status === 'COMPLETED' && (
                                    <a className="ml-auto" href={apiUrl(`/risks/reports/${r.id}/download`)}>
                                        <Button size="sm" variant="ghost">{t('reports.download')}</Button>
                                    </a>
                                )}
                            </li>
                        ))}
                    </ul>
                </AnalyticsState>
            </Card>
        </div>
    );
}

type Tr = (k: string, v?: Record<string, string | number | Date>) => string;

function NewTemplateForm({ apiUrl, onCreated, t }: { apiUrl: (p: string) => string; onCreated: () => void; t: Tr }) {
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [type, setType] = useState('PORTFOLIO_SUMMARY');
    const [busy, setBusy] = useState(false);
    const TYPE_OPTIONS: ComboboxOption[] = [
        { value: 'PORTFOLIO_SUMMARY', label: t('reports.typePortfolio') },
        { value: 'RISK_DEEP_DIVE', label: t('reports.typeDeepDive') },
        { value: 'BIA', label: t('reports.typeBia') },
        { value: 'CUSTOM', label: t('reports.typeCustom') },
    ];
    const create = async () => {
        if (!name.trim()) return;
        setBusy(true);
        try {
            const res = await fetch(apiUrl('/risks/reports/templates'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), type }),
            });
            if (!res.ok) throw new Error('Failed to create template');
            setName(''); setType('PORTFOLIO_SUMMARY'); setOpen(false); onCreated();
        } catch {
            toast.error(t('reports.templateCreateFailed'));
        } finally { setBusy(false); }
    };
    if (!open) {
        return <Button size="sm" variant="ghost" onClick={() => setOpen(true)} id="new-template-btn">{t('reports.newTemplate')}</Button>;
    }
    return (
        <div className="flex flex-wrap items-end gap-default border-t border-border-subtle pt-default">
            <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('reports.templateName')}</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('reports.templateNamePlaceholder')} />
            </label>
            <label className="block w-full sm:w-56"><span className="text-xs text-content-muted">{t('reports.templateType')}</span>
                <Combobox id="new-template-type" options={TYPE_OPTIONS} selected={TYPE_OPTIONS.find((o) => o.value === type) ?? null} setSelected={(o) => { if (o) setType(String(o.value)); }} />
            </label>
            <Button size="sm" variant="secondary" onClick={create} disabled={busy || !name.trim()}>{t('reports.createTemplate')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('edit.cancel')}</Button>
        </div>
    );
}

function SchedulesCard({
    apiUrl, templates, schedules, loading, error, mutate, nameOf, t,
}: {
    apiUrl: (p: string) => string;
    templates: Template[];
    schedules: Schedule[];
    loading: boolean;
    error: unknown;
    mutate: KeyedMutator<{ schedules: Schedule[] }>;
    nameOf: (id: string) => string;
    t: Tr;
}) {
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const [templateId, setTemplateId] = useState('');
    const [cadence, setCadence] = useState<(typeof CADENCES)[number]>('MONTHLY');
    const [recipients, setRecipients] = useState('');
    const [scheduleRiskId, setScheduleRiskId] = useState<string | null>(null);
    // Item 4 — optional SharePoint delivery destination (backend already
    // supports it via createSchedule's sharePointDriveId/sharePointFolderId).
    const [spDriveId, setSpDriveId] = useState('');
    const [spFolderId, setSpFolderId] = useState('');
    const [busy, setBusy] = useState(false);
    // Edit-in-place state (item 2): the schedule id being edited + its draft.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editCadence, setEditCadence] = useState<(typeof CADENCES)[number]>('MONTHLY');
    const [editRecipients, setEditRecipients] = useState('');

    const templateOptions: ComboboxOption[] = templates.map((tpl) => ({ value: tpl.id, label: tpl.name }));
    const cadenceOptions: ComboboxOption[] = CADENCES.map((c) => ({ value: c, label: t(`reports.cadence_${c}`) }));
    // A RISK_DEEP_DIVE schedule must carry the same single-risk scope the
    // one-off generate path sends, or it silently runs portfolio-wide.
    const selectedIsDeepDive = templates.find((tpl) => tpl.id === templateId)?.type === 'RISK_DEEP_DIVE';
    // Match the usecase's validation: a schedule needs at least one recipient
    // OR a SharePoint destination (createSchedule throws otherwise).
    const canCreate =
        !!templateId && (!!recipients.trim() || !!spDriveId.trim());

    const create = async () => {
        const emails = recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        if (!templateId || (emails.length === 0 && !spDriveId.trim())) return;
        setBusy(true);
        try {
            const riskId = selectedIsDeepDive ? scheduleRiskId ?? undefined : undefined;
            const res = await fetch(apiUrl('/risks/reports/schedules'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    templateId, cadence, recipients: emails,
                    ...(riskId ? { parameters: { riskId } } : {}),
                    ...(spDriveId.trim() ? { sharePointDriveId: spDriveId.trim() } : {}),
                    ...(spFolderId.trim() ? { sharePointFolderId: spFolderId.trim() } : {}),
                }),
            });
            if (!res.ok) throw new Error('Failed to create schedule');
            setTemplateId(''); setRecipients(''); setScheduleRiskId(null);
            setSpDriveId(''); setSpFolderId('');
            await mutate();
        } catch {
            toast.error(t('reports.scheduleCreateFailed'));
        } finally { setBusy(false); }
    };

    const patch = async (id: string, body: Record<string, unknown>) => {
        const res = await fetch(apiUrl(`/risks/reports/schedules/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error('Failed to update schedule');
        await mutate();
    };
    const togglePause = async (s: Schedule) => {
        try {
            await patch(s.id, { isActive: !s.isActive });
        } catch {
            toast.error(t('reports.scheduleUpdateFailed'));
        }
    };

    const startEdit = (s: Schedule) => {
        setEditingId(s.id);
        setEditCadence((CADENCES as readonly string[]).includes(s.cadence) ? (s.cadence as (typeof CADENCES)[number]) : 'MONTHLY');
        setEditRecipients((s.recipientsJson ?? []).join(', '));
    };
    const saveEdit = async (id: string) => {
        const emails = editRecipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        if (emails.length === 0) return;
        setBusy(true);
        try {
            await patch(id, { cadence: editCadence, recipients: emails });
            setEditingId(null);
        } catch {
            toast.error(t('reports.scheduleUpdateFailed'));
        } finally { setBusy(false); }
    };
    // Item 3 — delayed-commit delete (Epic 67). Optimistically drop the row
    // from the SWR cache, fire the real DELETE after the undo window, and
    // restore the cached list on Undo / failure. See docs/destructive-actions.md.
    const removeSchedule = (id: string) => {
        const previous = schedules;
        mutate({ schedules: schedules.filter((s) => s.id !== id) }, { revalidate: false });
        triggerUndoToast({
            message: t('reports.scheduleDeletedToast'),
            undoMessage: t('reports.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/risks/reports/schedules/${id}`), { method: 'DELETE' });
                if (!res.ok) throw new Error('Failed to delete schedule');
                await mutate();
            },
            undoAction: () => { mutate({ schedules: previous }, { revalidate: false }); },
            onError: () => {
                toast.error(t('reports.scheduleDeleteFailed'));
                mutate({ schedules: previous }, { revalidate: false });
            },
        });
    };

    return (
        <Card className="space-y-default p-6">
            <Heading level={2}>{t('reports.schedulesTitle')}</Heading>
            <p className="text-sm text-content-muted">{t('reports.schedulesIntro')}</p>

            <div className="flex flex-wrap items-end gap-default">
                <label className="block w-full sm:w-56"><span className="text-xs text-content-muted">{t('reports.scheduleTemplate')}</span>
                    <Combobox id="schedule-template" options={templateOptions} selected={templateOptions.find((o) => o.value === templateId) ?? null} setSelected={(o) => setTemplateId(o ? String(o.value) : '')} placeholder={t('reports.scheduleTemplatePlaceholder')} />
                </label>
                <label className="block w-full sm:w-40"><span className="text-xs text-content-muted">{t('reports.scheduleCadence')}</span>
                    <Combobox id="schedule-cadence" options={cadenceOptions} selected={cadenceOptions.find((o) => o.value === cadence) ?? null} setSelected={(o) => { if (o) setCadence(o.value as (typeof CADENCES)[number]); }} />
                </label>
                <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('reports.scheduleRecipients')}</span>
                    <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder={t('reports.scheduleRecipientsPlaceholder')} />
                </label>
                <Button variant="secondary" onClick={create} disabled={busy || !canCreate} id="schedule-create-btn">{t('reports.scheduleCreate')}</Button>
            </div>

            {/* Item 4 — optional SharePoint delivery destination. A schedule
                needs at least one recipient OR a SharePoint drive (the usecase
                enforces the same). Folder is optional within the drive. */}
            <div className="flex flex-wrap items-end gap-default">
                <label className="block w-full sm:w-72"><span className="text-xs text-content-muted">{t('reports.scheduleSharePointDrive')}</span>
                    <Input id="schedule-sp-drive" value={spDriveId} onChange={(e) => setSpDriveId(e.target.value)} placeholder={t('reports.scheduleSharePointDrivePlaceholder')} />
                </label>
                <label className="block w-full sm:w-72"><span className="text-xs text-content-muted">{t('reports.scheduleSharePointFolder')}</span>
                    <Input id="schedule-sp-folder" value={spFolderId} onChange={(e) => setSpFolderId(e.target.value)} placeholder={t('reports.scheduleSharePointFolderPlaceholder')} />
                </label>
                <p className="w-full text-xs text-content-subtle">{t('reports.scheduleDestinationHint')}</p>
            </div>

            {selectedIsDeepDive && (
                <div className="max-w-xs">
                    <span className="text-xs text-content-muted">{t('reports.scheduleDeepDiveScope')}</span>
                    <RiskPicker
                        id="schedule-deepdive-risk"
                        value={scheduleRiskId}
                        onChange={(id) => setScheduleRiskId(id)}
                        allowNone
                        noneLabel={t('reports.deepDiveAll')}
                        placeholder={t('reports.deepDiveScope')}
                    />
                </div>
            )}

            <AnalyticsState isLoading={loading} error={error} isEmpty={schedules.length === 0} emptyText={t('reports.schedulesEmpty')} errorText={t('reports.loadError')}>
                <ul className="divide-y divide-border-subtle" data-testid="report-schedules">
                    {schedules.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center gap-default py-default text-sm" data-testid={`schedule-row-${s.id}`}>
                            {editingId === s.id ? (
                                <div className="flex flex-1 flex-wrap items-end gap-default" data-testid={`schedule-edit-${s.id}`}>
                                    <span className="font-medium text-content-emphasis">{nameOf(s.templateId)}</span>
                                    <label className="block w-full sm:w-40"><span className="text-xs text-content-muted">{t('reports.scheduleCadence')}</span>
                                        <Combobox id={`schedule-edit-cadence-${s.id}`} options={cadenceOptions} selected={cadenceOptions.find((o) => o.value === editCadence) ?? null} setSelected={(o) => { if (o) setEditCadence(o.value as (typeof CADENCES)[number]); }} />
                                    </label>
                                    <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('reports.scheduleRecipients')}</span>
                                        <Input value={editRecipients} onChange={(e) => setEditRecipients(e.target.value)} placeholder={t('reports.scheduleRecipientsPlaceholder')} />
                                    </label>
                                    <span className="ml-auto flex gap-tight">
                                        <Button size="sm" variant="secondary" onClick={() => saveEdit(s.id)} disabled={busy || !editRecipients.trim()} data-testid={`schedule-save-${s.id}`}>{t('reports.scheduleSave')}</Button>
                                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} data-testid={`schedule-cancel-${s.id}`}>{t('edit.cancel')}</Button>
                                    </span>
                                </div>
                            ) : (
                                <>
                                    <StatusBadge variant={s.isActive ? 'success' : 'neutral'}>{s.isActive ? t('reports.scheduleActive') : t('reports.schedulePaused')}</StatusBadge>
                                    <span className="font-medium text-content-emphasis">{nameOf(s.templateId)}</span>
                                    <span className="text-content-muted">{t(`reports.cadence_${s.cadence}` as string)}</span>
                                    <span className="text-xs text-content-subtle">{(s.recipientsJson ?? []).join(', ')}</span>
                                    {s.nextRunAt && <span className="text-xs text-content-subtle">{t('reports.nextRun', { date: formatDateTime(s.nextRunAt) })}</span>}
                                    <span className="ml-auto flex gap-tight">
                                        <Button size="sm" variant="ghost" onClick={() => startEdit(s)} data-testid={`schedule-edit-btn-${s.id}`}>{t('reports.scheduleEdit')}</Button>
                                        <Button size="sm" variant="ghost" onClick={() => togglePause(s)} data-testid={`schedule-toggle-${s.id}`}>{s.isActive ? t('reports.schedulePause') : t('reports.scheduleResume')}</Button>
                                        <Button size="sm" variant="ghost" className="text-content-error" onClick={() => removeSchedule(s.id)} data-testid={`schedule-delete-${s.id}`}>{t('reports.scheduleDelete')}</Button>
                                    </span>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            </AnalyticsState>
        </Card>
    );
}
