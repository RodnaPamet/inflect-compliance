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
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { formatDateTime } from '@/lib/format-date';
import { useTranslations } from 'next-intl';
import type { KeyedMutator } from 'swr';
import { useToast } from '@/components/ui/hooks/use-toast';
import { useToastWithUndo } from '@/components/ui/hooks';
import { RequirePermission } from '@/components/require-permission';
import { UpgradeGate } from '@/components/UpgradeGate';
import { RiskPicker } from '../_shared/RiskPicker';
import { AnalyticsState } from '../_shared/AnalyticsState';

interface Template { id: string; name: string; description: string | null; type: string }
/**
 * A ReportRun as the list endpoint returns it.
 *
 * `errorMessage` was ALREADY on the wire — `listReports` returns whole rows and
 * `generateReport` writes the field on failure — and simply absent from this
 * interface, so the row rendered a red FAILED pill with no cause and no way
 * forward. The data was there the whole time; the type hid it.
 */
interface Run {
    id: string;
    format: string;
    status: string;
    createdAt: string;
    templateId: string;
    errorMessage: string | null;
    parametersJson: { riskId?: string } | null;
}

/** Statuses `generateReport` can leave behind — see risk-report.ts. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED']);
interface Schedule {
    id: string; templateId: string; cadence: string; format: string; isActive: boolean;
    recipientsJson: string[] | null; nextRunAt: string | null; lastRunAt: string | null;
    /** Deep-dive scope. Set at creation, previously invisible ever after. */
    parametersJson: { riskId?: string } | null;
    deliveryDay: number | null;
}

const CADENCES = ['WEEKLY', 'MONTHLY', 'QUARTERLY'] as const;
const FORMATS = ['PDF', 'CSV', 'PPTX'] as const;
type ReportFormat = (typeof FORMATS)[number];

/**
 * Split a recipients field and report which entries are not addresses.
 *
 * The field was only ever split on `/[\s,;]+/` and length-checked, while the
 * server enforces `z.string().email()` — so "bob@" produced a 400 that the user
 * could not connect to anything they had typed. Validating the same shape here
 * turns a server rejection into an inline correction.
 *
 * Deliberately permissive (`x@y.z`): this is a typo-catcher standing in front of
 * the real check, not a second source of truth. Rejecting an address the server
 * would have accepted is the worse failure.
 */
function parseRecipients(raw: string): { emails: string[]; invalid: string[] } {
    const parts = raw.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    return {
        emails: parts.filter((v) => ok.test(v)),
        invalid: parts.filter((v) => !ok.test(v)),
    };
}

export default function RiskReportsPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // Generation is fully synchronous inside the POST, so a run killed by a
    // serverless timeout is stranded in GENERATING with nothing to move it.
    // There was no refreshInterval and no manual refresh, so the page showed
    // "generating…" forever and the only way out was a reload the UI never
    // suggested.
    //
    // SWR's function form derives the interval from the latest data, so polling
    // stops on its own once every run has settled — no state, no effect, and no
    // window where a stale interval outlives the condition that justified it.
    const reportsQuery = useTenantSWR<{ templates: Template[]; reports: Run[] }>(
        '/risks/reports',
        {
            refreshInterval: (latest) =>
                latest?.reports?.some((r) => !TERMINAL_STATUSES.has(r.status)) ? 5000 : 0,
        },
    );
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

    const generate = async (
        tpl: Template,
        format: 'PDF' | 'CSV' | 'PPTX',
        /**
         * Explicit deep-dive scope, for the retry path.
         *
         * Necessary rather than convenient: a retry cannot `setDeepDiveRisk`
         * and then call this, because the state update is not visible until the
         * next render — it would read the PREVIOUS value and silently generate
         * the wrong scope.
         */
        riskIdOverride?: string,
    ) => {
        setGeneratingId(tpl.id);
        try {
            const riskId = riskIdOverride ?? (isDeepDive(tpl) ? deepDiveRisk[tpl.id] ?? undefined : undefined);
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

    /**
     * Re-run a failed report with the SAME template and scope.
     *
     * Reuses `generate`, so the entitlement/permission failures and the toasts
     * behave identically — a retry that reported differently from the original
     * attempt would be its own confusion. The deep-dive scope comes from the
     * failed run's own `parametersJson` rather than the row's current picker
     * value, so "retry" means retry, not "run something else".
     */
    const rerun = async (r: Run) => {
        const tpl = templates.find((x) => x.id === r.templateId);
        if (!tpl) return;
        await generate(
            tpl,
            (r.format as 'PDF' | 'CSV' | 'PPTX') ?? 'PDF',
            r.parametersJson?.riskId,
        );
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
                {/* Wrapped like Recent and Schedules already are. Outside it, a
                    failed GET /risks/reports rendered an empty <ul> next to a
                    live "New template" button and an empty schedule Combobox —
                    indistinguishable from a healthy tenant with no templates,
                    which is the exact failure AnalyticsState's own docstring
                    calls out. */}
                <AnalyticsState
                    isLoading={reportsQuery.isLoading}
                    error={reportsQuery.error}
                    isEmpty={templates.length === 0}
                    emptyText={t('reports.templatesEmpty')}
                    errorText={t('reports.loadError')}
                >
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
                            {/* Every button below is a write the server refuses
                                for a READER (reports.export = false), and the
                                page showed all of them unconditionally — so a
                                READER clicked, got a 403, and the failure toast
                                explained a limitation the UI had implied did not
                                exist.

                                PDF and PPTX additionally sit behind the
                                PDF_EXPORTS entitlement, which the risk-report
                                route began enforcing in #1759. CSV does NOT —
                                it is a data extract, and the server leaves it
                                ungated deliberately, so wrapping it here would
                                claim an entitlement the product does not sell. */}
                            <RequirePermission resource="reports" action="export">
                                <UpgradeGate feature="PDF_EXPORTS">
                                    <Button size="sm" variant="primary" onClick={() => generate(tpl, 'PDF')} disabled={generatingId === tpl.id}>{t('reports.generatePdf')}</Button>
                                </UpgradeGate>
                                <UpgradeGate feature="PDF_EXPORTS">
                                    <Button size="sm" variant="secondary" onClick={() => generate(tpl, 'PPTX')} disabled={generatingId === tpl.id}>PPTX</Button>
                                </UpgradeGate>
                                <Button size="sm" variant="secondary" onClick={() => generate(tpl, 'CSV')} disabled={generatingId === tpl.id}>CSV</Button>
                            </RequirePermission>
                            {generatingId === tpl.id && (
                                <span className="text-xs text-content-muted" data-testid={`generating-${tpl.id}`}>{t('reports.generating')}</span>
                            )}
                        </li>
                    ))}
                </ul>
                </AnalyticsState>
                <RequirePermission resource="reports" action="export">
                    <NewTemplateForm apiUrl={apiUrl} onCreated={() => reportsQuery.mutate()} t={t} />
                </RequirePermission>
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
                                {/* A red FAILED pill on its own tells the user
                                    that something broke and nothing about what
                                    or what to do. The reason was already stored
                                    and already returned. */}
                                {r.status === 'FAILED' && r.errorMessage && (
                                    <span
                                        className="text-xs text-content-error"
                                        data-testid={`run-error-${r.id}`}
                                    >
                                        {r.errorMessage}
                                    </span>
                                )}
                                {r.status === 'COMPLETED' && (
                                    <a className="ml-auto" href={apiUrl(`/risks/reports/${r.id}/download`)}>
                                        <Button size="sm" variant="ghost">{t('reports.download')}</Button>
                                    </a>
                                )}
                                {r.status === 'FAILED' && (
                                    <RequirePermission resource="reports" action="export">
                                        <span className="ml-auto">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => rerun(r)}
                                                disabled={generatingId === r.templateId}
                                                data-testid={`run-retry-${r.id}`}
                                            >
                                                {t('reports.retry')}
                                            </Button>
                                        </span>
                                    </RequirePermission>
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
            // Failure toasted, success silent — so the only unambiguous signal
            // was the form closing, which also happens on cancel.
            toast.success(t('reports.templateCreated'));
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
    // Split from the edit-save flag: one shared boolean meant saving an edit on
    // one row disabled the Create button (and vice versa), with no indication
    // why. They are independent operations on independent forms.
    const [busy, setBusy] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);
    // Edit-in-place state (item 2): the schedule id being edited + its draft.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editCadence, setEditCadence] = useState<(typeof CADENCES)[number]>('MONTHLY');
    const [editRecipients, setEditRecipients] = useState('');
    const [editFormat, setEditFormat] = useState<ReportFormat>('PDF');
    const [editRiskId, setEditRiskId] = useState<string | null>(null);

    const templateOptions: ComboboxOption[] = templates.map((tpl) => ({ value: tpl.id, label: tpl.name }));
    const cadenceOptions: ComboboxOption[] = CADENCES.map((c) => ({ value: c, label: t(`reports.cadence_${c}`) }));
    const formatOptions: ComboboxOption[] = FORMATS.map((f) => ({ value: f, label: f }));
    // A RISK_DEEP_DIVE schedule must carry the same single-risk scope the
    // one-off generate path sends, or it silently runs portfolio-wide.
    const selectedIsDeepDive = templates.find((tpl) => tpl.id === templateId)?.type === 'RISK_DEEP_DIVE';
    // Match the usecase's validation: a schedule needs at least one recipient
    // OR a SharePoint destination (createSchedule throws otherwise).
    const canCreate =
        !!templateId && (!!recipients.trim() || !!spDriveId.trim());

    const create = async () => {
        const { emails, invalid } = parseRecipients(recipients);
        if (invalid.length > 0) {
            toast.error(t('reports.scheduleInvalidRecipients', { list: invalid.join(', ') }));
            return;
        }
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
            toast.success(t('reports.scheduleCreated'));
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
        // `format`, the deep-dive `riskId` and `deliveryDay` were never seeded,
        // never rendered and never editable — so someone who scoped a deep-dive
        // schedule to a single risk at creation could not afterwards SEE what it
        // was scoped to, let alone change it. The first two are editable; the
        // third is shown read-only because `updateSchedule` does not accept it.
        setEditFormat((FORMATS as readonly string[]).includes(s.format) ? (s.format as ReportFormat) : 'PDF');
        setEditRiskId(s.parametersJson?.riskId ?? null);
    };
    const saveEdit = async (id: string) => {
        const { emails, invalid } = parseRecipients(editRecipients);
        if (invalid.length > 0) {
            toast.error(t('reports.scheduleInvalidRecipients', { list: invalid.join(', ') }));
            return;
        }
        if (emails.length === 0) return;
        setSavingId(id);
        try {
            await patch(id, {
                cadence: editCadence,
                recipients: emails,
                format: editFormat,
                ...(editRiskId ? { parameters: { riskId: editRiskId } } : {}),
            });
            setEditingId(null);
            toast.success(t('reports.scheduleUpdated'));
        } catch {
            toast.error(t('reports.scheduleUpdateFailed'));
        } finally { setSavingId(null); }
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

            {/* Scope BEFORE the Create button, not after it.
                A deep-dive schedule created without a riskId silently runs
                portfolio-wide — the exact outcome the comment on
                `selectedIsDeepDive` says this field exists to prevent. Sitting
                below an already-enabled Create button, it was easy to never
                see. */}
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
                <RequirePermission resource="reports" action="export">
                    <Button variant="secondary" onClick={create} disabled={busy || !canCreate} id="schedule-create-btn">{t('reports.scheduleCreate')}</Button>
                </RequirePermission>
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
                                    <label className="block w-full sm:w-32"><span className="text-xs text-content-muted">{t('reports.scheduleFormat')}</span>
                                        <Combobox id={`schedule-edit-format-${s.id}`} options={formatOptions} selected={formatOptions.find((o) => o.value === editFormat) ?? null} setSelected={(o) => { if (o) setEditFormat(o.value as ReportFormat); }} />
                                    </label>
                                    <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('reports.scheduleRecipients')}</span>
                                        <Input value={editRecipients} onChange={(e) => setEditRecipients(e.target.value)} placeholder={t('reports.scheduleRecipientsPlaceholder')} />
                                    </label>
                                    {/* Only for a deep-dive template — a scope
                                        picker on a portfolio schedule would
                                        imply a setting that does nothing. */}
                                    {templates.find((tpl) => tpl.id === s.templateId)?.type === 'RISK_DEEP_DIVE' && (
                                        <div className="w-full max-w-xs">
                                            <span className="text-xs text-content-muted">{t('reports.scheduleDeepDiveScope')}</span>
                                            <RiskPicker
                                                id={`schedule-edit-risk-${s.id}`}
                                                value={editRiskId}
                                                onChange={(id) => setEditRiskId(id)}
                                                allowNone
                                                noneLabel={t('reports.deepDiveAll')}
                                                placeholder={t('reports.deepDiveScope')}
                                            />
                                        </div>
                                    )}
                                    {/* Read-only: `updateSchedule` does not
                                        accept deliveryDay, so an editable field
                                        would be another control that silently
                                        does nothing. Shown because a user who
                                        set it deserves to see it. */}
                                    {s.deliveryDay != null && (
                                        <span className="text-xs text-content-subtle">
                                            {t('reports.scheduleDeliveryDayReadOnly', { day: s.deliveryDay })}
                                        </span>
                                    )}
                                    <span className="ml-auto flex gap-tight">
                                        <Button size="sm" variant="secondary" onClick={() => saveEdit(s.id)} disabled={savingId === s.id || !editRecipients.trim()} data-testid={`schedule-save-${s.id}`}>{t('reports.scheduleSave')}</Button>
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
                                    <RequirePermission resource="reports" action="export">
                                        <span className="ml-auto flex gap-tight">
                                            <Button size="sm" variant="ghost" onClick={() => startEdit(s)} data-testid={`schedule-edit-btn-${s.id}`}>{t('reports.scheduleEdit')}</Button>
                                            <Button size="sm" variant="ghost" onClick={() => togglePause(s)} data-testid={`schedule-toggle-${s.id}`}>{s.isActive ? t('reports.schedulePause') : t('reports.scheduleResume')}</Button>
                                            {/* `variant="destructive"` rather than a ghost button
                                                hand-painted with `text-content-error`. The tone is
                                                the primitive's job — an inline colour override
                                                gets the text but not the hover, focus ring or
                                                disabled treatment, so it reads as destructive
                                                only while idle. */}
                                            <Button size="sm" variant="destructive" onClick={() => removeSchedule(s.id)} data-testid={`schedule-delete-${s.id}`}>{t('reports.scheduleDelete')}</Button>
                                        </span>
                                    </RequirePermission>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            </AnalyticsState>
        </Card>
    );
}
